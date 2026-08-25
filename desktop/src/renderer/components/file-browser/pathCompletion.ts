import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete';
import { posix } from 'path-browserify';
import type { FileEntry, FileListRequest, FileListResponse } from '../../../shared/ipc-types';
import { listFiles } from '../../api/file.api';

const PATH_COMPLETION_CACHE_TTL_MS = 5_000;
const PATH_COMPLETION_CACHE_MAX_ENTRIES = 50;

export interface ParsedLiteralIgnorePath {
  directoryPath: string;
  from: number;
  rooted: boolean;
  segment: string;
}

export type FileListProvider = (request: FileListRequest) => Promise<FileListResponse>;

interface CachedListing {
  entries: readonly FileEntry[];
  expiresAt: number;
}

const UNSUPPORTED_PATTERN_CHARS = new Set(['*', '?', '[', '\\']);

export function parseLiteralIgnorePath(value: string): ParsedLiteralIgnorePath | null {
  if (value.startsWith('#') || [...value].some((character) => UNSUPPORTED_PATTERN_CHARS.has(character))) {
    return null;
  }

  let remainder = value;
  let rooted = false;
  if (remainder.startsWith('!')) remainder = remainder.slice(1);
  if (remainder.startsWith('/')) {
    rooted = true;
    remainder = remainder.slice(1);
  }

  const segments = remainder.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  if (segments.slice(0, -1).some((segment) => segment.length === 0)) return null;

  const segment = segments.at(-1) ?? '';
  return {
    directoryPath: segments.slice(0, -1).join('/'),
    from: value.length - segment.length,
    rooted,
    segment,
  };
}

function normalizeRelativeDirectory(value: string): string | null {
  const normalized = posix.normalize(value.replace(/\\/g, '/'));
  if (normalized === '.' || normalized === '') return '';
  if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function getIgnoreFileDirectory(relativePath: string): string | null {
  const normalizedPath = normalizeRelativeDirectory(relativePath);
  if (normalizedPath === null || normalizedPath === '') return null;
  return normalizeRelativeDirectory(posix.dirname(normalizedPath));
}

function resolveListingDirectory(
  relativePath: string,
  parsed: ParsedLiteralIgnorePath,
): string | null {
  const containingDirectory = getIgnoreFileDirectory(relativePath);
  if (containingDirectory === null) return null;
  const baseDirectory = parsed.rooted ? '' : containingDirectory;
  return normalizeRelativeDirectory(posix.join(baseDirectory, parsed.directoryPath));
}

function isLiteralPathSegment(value: string): boolean {
  return value !== '.'
    && value !== '..'
    && ![...value].some((character) => (
      character === '/' || UNSUPPORTED_PATTERN_CHARS.has(character)
    ));
}

function toCompletion(entry: FileEntry): Completion {
  if (entry.isDirectory) {
    return {
      apply: `${entry.name}/`,
      boost: 1,
      detail: 'directory',
      label: entry.name,
      type: 'folder',
    };
  }
  return { label: entry.name, type: 'file' };
}

function getLinePrefix(context: CompletionContext): { lineFrom: number; prefix: string } {
  const line = context.state.doc.lineAt(context.pos);
  return {
    lineFrom: line.from,
    prefix: line.text.slice(0, context.pos - line.from),
  };
}

export function createPathCompletionSource(
  rootPath: string,
  relativePath: string,
  listDirectory: FileListProvider = listFiles,
): CompletionSource {
  const cache = new Map<string, CachedListing>();

  async function getListing(
    dirPath: string,
    context: CompletionContext,
  ): Promise<readonly FileEntry[] | null> {
    const now = Date.now();
    const cached = cache.get(dirPath);
    if (cached && cached.expiresAt > now) return cached.entries;
    if (cached) cache.delete(dirPath);

    const request: FileListRequest = dirPath
      ? { dirPath, rootPath }
      : { rootPath };
    let response: FileListResponse;
    try {
      response = await listDirectory(request);
    } catch {
      return null;
    }
    if (context.aborted || response.error) return null;

    cache.set(dirPath, {
      entries: response.entries,
      expiresAt: Date.now() + PATH_COMPLETION_CACHE_TTL_MS,
    });
    if (cache.size > PATH_COMPLETION_CACHE_MAX_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    return response.entries;
  }

  return async (context) => {
    const { lineFrom, prefix } = getLinePrefix(context);
    const parsed = parseLiteralIgnorePath(prefix);
    if (!parsed || (parsed.segment === '' && !context.explicit && !prefix.endsWith('/'))) return null;

    const dirPath = resolveListingDirectory(relativePath, parsed);
    if (dirPath === null) return null;

    const listing = await getListing(dirPath, context);
    if (!listing || context.aborted) return null;

    return {
      from: lineFrom + parsed.from,
      options: listing.map(toCompletion),
      validFor: isLiteralPathSegment,
    } satisfies CompletionResult;
  };
}
