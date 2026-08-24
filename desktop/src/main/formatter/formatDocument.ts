import { Buffer } from 'node:buffer';
import { relative, resolve } from 'node:path';
import { diffChars } from 'diff';
import * as prettier from 'prettier';
import type { FileEol, TextChange } from '../../shared/ipc-types.js';

const MAX_FORMAT_BYTES = 1024 * 1024;
const MAX_FORMAT_CHANGES = 10_000;

interface FormatDocumentOptions {
  content: string;
  eol: FileEol;
  filePath: string;
  projectRoot: string;
}

export type FormatDocumentResult =
  | { kind: 'formatted'; changes: TextChange[] }
  | { kind: 'ignored' }
  | { kind: 'unchanged' };

function assertBounded(value: string, label: string): void {
  if (Buffer.byteLength(value, 'utf8') > MAX_FORMAT_BYTES) {
    throw new Error(`${label} exceeds 1 MB`);
  }
}

function assertWithinProjectRoot(projectRoot: string, filePath: string): void {
  const relativePath = relative(resolve(projectRoot), resolve(filePath));
  if (relativePath === '..' || relativePath.startsWith('../') || relativePath.startsWith('..\\')) {
    throw new Error('Formatter path is outside the project root');
  }
}

function computeMultiHunkChanges(original: string, formatted: string): TextChange[] {
  const changes: TextChange[] = [];
  const parts = diffChars(original, formatted);
  let originalOffset = 0;
  let pending: TextChange | null = null;

  for (const part of parts) {
    if (!part.added && !part.removed) {
      if (pending) {
        changes.push(pending);
        pending = null;
      }
      originalOffset += part.value.length;
      continue;
    }

    pending ??= { from: originalOffset, to: originalOffset, insert: '' };
    if (part.removed) {
      pending.to += part.value.length;
      originalOffset += part.value.length;
    } else {
      pending.insert += part.value;
    }
  }
  if (pending) changes.push(pending);
  if (changes.length > MAX_FORMAT_CHANGES) {
    throw new Error('Formatter produced too many changes');
  }
  return changes;
}

export function applyTextChanges(content: string, changes: readonly TextChange[]): string {
  let result = content;
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    const change = changes[index];
    result = result.slice(0, change.from) + change.insert + result.slice(change.to);
  }
  return result;
}

export async function formatDocument(options: FormatDocumentOptions): Promise<FormatDocumentResult> {
  assertWithinProjectRoot(options.projectRoot, options.filePath);
  assertBounded(options.content, 'Formatter input');

  const ignorePath = resolve(options.projectRoot, '.prettierignore');
  const fileInfo = await prettier.getFileInfo(options.filePath, {
    ignorePath,
    resolveConfig: false,
  });
  if (fileInfo.ignored) return { kind: 'ignored' };

  const projectConfig = await prettier.resolveConfig(options.filePath);
  const formatted = await prettier.format(options.content, {
    ...projectConfig,
    endOfLine: options.eol,
    filepath: options.filePath,
  });
  assertBounded(formatted, 'Formatter output');
  if (formatted === options.content) return { kind: 'unchanged' };
  return {
    kind: 'formatted',
    changes: computeMultiHunkChanges(options.content, formatted),
  };
}
