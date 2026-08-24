import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { ProjectTextSearchResult } from '../../../shared/ipc-types.js';
import { BINARY_FILE_EXTENSIONS } from '../../../shared/filePolicy.js';
import { log } from '../Logger.js';
import type { FileIndexEntry } from './ProjectFileIndex.js';

const GIT_GREP_RECORD_LIMIT = 2_000;
const GIT_GREP_STDERR_LIMIT = 4_096;
const LOW_RELEVANCE_FILES = new Set(['makefile', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
const MAX_FALLBACK_FILE_BYTES = 512 * 1024;
const MAX_GIT_GREP_BYTES = 8 * 1024 * 1024;
const MAX_MATCHES_PER_FILE = 3;
const MAX_TEXT_RESULTS = 50;

interface ScoredTextResult extends ProjectTextSearchResult {
  score: number;
}

export function gitGrep(
  rootPath: string,
  query: string,
  setProcess: (child: ChildProcess) => void,
  clearProcess: (child: ChildProcess) => void,
): Promise<ProjectTextSearchResult[] | null> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      'git',
      [
        'grep',
        '-n',
        '-i',
        '-I',
        '-F',
        '-z',
        '--untracked',
        '--exclude-standard',
        `--max-count=${MAX_MATCHES_PER_FILE}`,
        '--',
        query,
      ],
      { cwd: rootPath },
    );

    let buffered = '';
    let recordCount = 0;
    let stderr = '';
    let settled = false;

    const settle = (value: ProjectTextSearchResult[] | null): void => {
      if (settled) return;
      settled = true;
      clearProcess(child);
      resolvePromise(value);
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffered += chunk;
      recordCount += chunk.split('\n').length - 1;
      if (recordCount >= GIT_GREP_RECORD_LIMIT || buffered.length >= MAX_GIT_GREP_BYTES) {
        child.kill('SIGTERM');
      }
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < GIT_GREP_STDERR_LIMIT) stderr += chunk;
    });

    child.on('error', (error) => {
      log.warn('project-search', 'git grep failed to spawn, falling back to file scan', {
        error: String(error),
        query,
        rootPath,
      });
      settle(null);
    });

    child.on('close', (code, signal) => {
      if (signal !== null || code === 0 || code === 1) {
        settle(parseGitGrepOutput(rootPath, query, buffered));
        return;
      }

      log.warn('project-search', 'git grep failed, falling back to file scan', {
        code,
        query,
        rootPath,
        stderr: stderr.trim(),
      });
      settle(null);
    });

    setProcess(child);
  });
}

export async function fallbackTextSearch(
  rootPath: string,
  entries: readonly FileIndexEntry[],
  query: string,
): Promise<ProjectTextSearchResult[]> {
  const results: ScoredTextResult[] = [];

  for (const entry of entries) {
    if (results.length >= MAX_TEXT_RESULTS) break;
    const matches = await searchTextInFile(resolve(rootPath, entry.path), query);

    for (const match of matches) {
      results.push({
        rootPath,
        path: entry.path,
        filename: entry.filename,
        lineNumber: match.lineNumber,
        lineContent: match.lineContent,
        score: scoreTextResult(entry.filename, match.lineContent, query.toLowerCase()),
      });
      if (results.length >= MAX_TEXT_RESULTS) break;
    }
  }

  results.sort((left, right) => (right.score - left.score)
    || left.path.localeCompare(right.path)
    || (left.lineNumber - right.lineNumber));

  return results.slice(0, MAX_TEXT_RESULTS).map(({ score: _score, ...result }) => result);
}

async function searchTextInFile(
  absolutePath: string,
  query: string,
): Promise<Array<{ lineNumber: number; lineContent: string }>> {
  if (isBinaryPath(absolutePath)) return [];

  let buffer: Buffer;
  try {
    buffer = await readFile(absolutePath);
  } catch {
    return [];
  }

  if (buffer.length > MAX_FALLBACK_FILE_BYTES || looksBinary(buffer)) return [];

  const queryLower = query.toLowerCase();
  const lines = buffer.toString('utf8').replace(/\r\n/g, '\n').split('\n');
  const matches: Array<{ lineNumber: number; lineContent: string }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.toLowerCase().includes(queryLower)) continue;

    matches.push({
      lineNumber: index + 1,
      lineContent: line.trim().slice(0, 200),
    });
    if (matches.length >= MAX_MATCHES_PER_FILE) break;
  }

  return matches;
}

export function parseGitGrepOutput(
  rootPath: string,
  query: string,
  stdout: string,
): ProjectTextSearchResult[] {
  const results: ScoredTextResult[] = [];
  const queryLower = query.toLowerCase();

  for (const record of stdout.split('\n')) {
    if (!record) continue;
    const parsed = parseGitGrepRecord(record);
    if (!parsed) continue;

    const { path, lineNumber, lineContent } = parsed;
    const filename = basename(path);
    results.push({
      rootPath,
      path,
      filename,
      lineNumber,
      lineContent,
      score: scoreTextResult(filename, lineContent, queryLower),
    });
  }

  results.sort((left, right) => right.score - left.score);
  return results.slice(0, MAX_TEXT_RESULTS).map(({ score: _score, ...result }) => result);
}

function parseGitGrepRecord(
  record: string,
): { path: string; lineNumber: number; lineContent: string } | null {
  const firstNul = record.indexOf('\0');
  if (firstNul < 0) return null;
  const secondNul = record.indexOf('\0', firstNul + 1);
  if (secondNul < 0) return null;

  const lineNumber = parseInt(record.slice(firstNul + 1, secondNul), 10);
  if (!Number.isFinite(lineNumber)) return null;

  return {
    path: record.slice(0, firstNul),
    lineNumber,
    lineContent: record.slice(secondNul + 1).trim().slice(0, 200),
  };
}

function scoreTextResult(filename: string, lineContent: string, queryLower: string): number {
  let score = LOW_RELEVANCE_FILES.has(filename.toLowerCase()) ? -10 : 0;
  const lineLower = lineContent.toLowerCase();
  const matchIndex = lineLower.indexOf(queryLower);

  if (matchIndex >= 0 && matchIndex < 20) score += 3;
  if (lineContent.length < 80) score += 2;

  const before = matchIndex > 0 ? lineLower[matchIndex - 1] : ' ';
  const after = matchIndex >= 0 && matchIndex + queryLower.length < lineLower.length
    ? lineLower[matchIndex + queryLower.length]
    : ' ';
  if (/[\s'"=:{(\[,]/.test(before) && /[\s'"=:})\],]/.test(after)) score += 5;
  return score;
}

function isBinaryPath(filePath: string): boolean {
  const extension = filePath.split('.').pop()?.toLowerCase() ?? '';
  return BINARY_FILE_EXTENSIONS.has(extension);
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 512));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}
