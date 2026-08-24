import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import MiniSearch from 'minisearch';
import type { SearchResult } from 'minisearch';
import type { ProjectFileSearchResult } from '../../../shared/ipc-types.js';
import { HEAVY_IGNORED_DIRS } from '../../../shared/filePolicy.js';
import { log } from '../Logger.js';

export const FILE_INDEX_TTL_MS = 2 * 60_000;

const FILE_TOKEN_SEPARATOR = /[\s/\\._-]+/;
const SEARCH_ACRONYM_BOUNDARY = /([a-z0-9])([A-Z])/g;
const MAX_FILE_RESULTS = 50;
const MAX_FALLBACK_FILES = 100_000;
const MAX_GIT_FILES_BUFFER = 16 * 1024 * 1024;
const FALLBACK_FILE_LIST_TIMEOUT_MS = 5_000;
const GIT_FILE_LIST_TIMEOUT_MS = 5_000;

interface IndexedFileDocument {
  id: string;
  path: string;
  filename: string;
  directory: string;
}

export interface FileIndexEntry {
  path: string;
  filename: string;
  directory: string;
  filenameAcronymLower: string;
  filenameLower: string;
  pathLower: string;
  depth: number;
  pathSegmentsLower: string[];
}

export interface FileIndexCache {
  builtAt: number;
  entries: FileIndexEntry[];
  entriesByPath: Map<string, FileIndexEntry>;
  index: MiniSearch<IndexedFileDocument>;
}

export interface FileIndexBuildOptions {
  fallbackTimeoutMs?: number;
  gitTimeoutMs?: number;
  maxFallbackFiles?: number;
}

interface ScoredFileResult extends ProjectFileSearchResult {
  score: number;
  depth: number;
}

export async function buildFileIndex(
  rootPath: string,
  options: FileIndexBuildOptions = {},
): Promise<FileIndexCache> {
  const gitTimeoutMs = normalizeLimit(options.gitTimeoutMs, GIT_FILE_LIST_TIMEOUT_MS, 1);
  const fallbackTimeoutMs = normalizeLimit(
    options.fallbackTimeoutMs,
    FALLBACK_FILE_LIST_TIMEOUT_MS,
    0,
  );
  const maxFallbackFiles = normalizeLimit(
    options.maxFallbackFiles,
    MAX_FALLBACK_FILES,
    0,
  );
  const filePaths = await listSearchableFiles(rootPath, {
    fallbackTimeoutMs,
    gitTimeoutMs,
    maxFallbackFiles,
  });
  const cache = createFileSearchIndex(filePaths);

  log.info('project-search', 'File index refreshed', {
    fileCount: cache.entries.length,
    rootPath,
  });

  return cache;
}

export function createFileSearchIndex(filePaths: readonly string[]): FileIndexCache {
  const uniquePaths = Array.from(new Set(filePaths.map(normalizeRelativePath))).filter(Boolean);
  const entries = uniquePaths.map((path) => createFileIndexEntry(path));
  const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const index = new MiniSearch<IndexedFileDocument>({
    fields: ['filename', 'path', 'directory'],
    searchOptions: {
      boost: { directory: 1, filename: 6, path: 2 },
      combineWith: 'AND',
      fuzzy: 0.2,
      prefix: true,
    },
    storeFields: ['path', 'filename', 'directory'],
    tokenize: tokenizeSearchText,
  });

  index.addAll(entries.map((entry) => ({
    id: entry.path,
    path: entry.path,
    filename: entry.filename,
    directory: entry.directory,
  })));

  return {
    builtAt: Date.now(),
    entries,
    entriesByPath,
    index,
  };
}

async function listSearchableFiles(
  rootPath: string,
  options: Required<FileIndexBuildOptions>,
): Promise<string[]> {
  const gitFiles = await listGitFiles(rootPath, options.gitTimeoutMs);
  if (gitFiles) return gitFiles;
  return walkFiles(rootPath, options);
}

function listGitFiles(rootPath: string, timeout: number): Promise<string[] | null> {
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: rootPath, maxBuffer: MAX_GIT_FILES_BUFFER, timeout },
      (error, stdout) => {
        if (error) {
          log.warn('project-search', 'git ls-files failed, falling back to filesystem walk', {
            error: String(error),
            rootPath,
          });
          resolvePromise(null);
          return;
        }

        resolvePromise(parseGitFileListOutput(stdout));
      },
    );
  });
}

async function walkFiles(
  rootPath: string,
  options: Pick<Required<FileIndexBuildOptions>, 'fallbackTimeoutMs' | 'maxFallbackFiles'>,
): Promise<string[]> {
  const files: string[] = [];
  const pendingDirs: string[] = [''];
  const deadline = Date.now() + options.fallbackTimeoutMs;

  while (pendingDirs.length > 0) {
    assertFallbackWalkWithinTimeLimit(
      rootPath,
      files.length,
      deadline,
      options.fallbackTimeoutMs,
    );

    const currentRelativeDir = pendingDirs.pop() ?? '';
    const currentAbsoluteDir = currentRelativeDir
      ? resolve(rootPath, currentRelativeDir)
      : rootPath;

    let dirents: Dirent[] | null;
    try {
      dirents = await readdirBeforeDeadline(currentAbsoluteDir, deadline);
    } catch (error) {
      log.debug('project-search', 'Skipping unreadable directory during fallback walk', {
        dir: currentAbsoluteDir,
        error: String(error),
      });
      continue;
    }
    if (!dirents) {
      throwFallbackTimeLimit(rootPath, files.length, options.fallbackTimeoutMs);
    }

    dirents.sort((left, right) => left.name.localeCompare(right.name));

    for (const dirent of dirents) {
      assertFallbackWalkWithinTimeLimit(
        rootPath,
        files.length,
        deadline,
        options.fallbackTimeoutMs,
      );
      const nextRelativePath = currentRelativeDir
        ? `${currentRelativeDir}/${dirent.name}`
        : dirent.name;

      if (dirent.isDirectory()) {
        if (!HEAVY_IGNORED_DIRS.has(dirent.name)) pendingDirs.push(nextRelativePath);
        continue;
      }

      if (dirent.isFile()) {
        if (files.length >= options.maxFallbackFiles) {
          throwFallbackFileLimit(rootPath, files.length, options.maxFallbackFiles);
        }
        files.push(nextRelativePath);
      }
    }
  }

  return files;
}

async function readdirBeforeDeadline(path: string, deadline: number): Promise<Dirent[] | null> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return null;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol('timed-out');
  try {
    const result = await Promise.race([
      readdir(path, { withFileTypes: true }),
      new Promise<typeof timedOut>((resolvePromise) => {
        timeout = setTimeout(() => resolvePromise(timedOut), remainingMs);
        timeout.unref();
      }),
    ]);
    return result === timedOut ? null : result;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function assertFallbackWalkWithinTimeLimit(
  rootPath: string,
  fileCount: number,
  deadline: number,
  timeoutMs: number,
): void {
  if (Date.now() >= deadline) {
    throwFallbackTimeLimit(rootPath, fileCount, timeoutMs);
  }
}

function throwFallbackTimeLimit(rootPath: string, fileCount: number, timeoutMs: number): never {
  log.warn('project-search', 'Filesystem fallback walk reached its time limit', {
    fileCount,
    rootPath,
    timeoutMs,
  });
  throw new Error(`Filesystem fallback walk reached its ${timeoutMs} ms time limit`);
}

function throwFallbackFileLimit(rootPath: string, fileCount: number, maxFiles: number): never {
  log.warn('project-search', 'Filesystem fallback walk reached its file limit', {
    fileCount,
    maxFiles,
    rootPath,
  });
  throw new Error(`Filesystem fallback walk reached its ${maxFiles}-file limit`);
}

function normalizeLimit(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.floor(value));
}

function createFileIndexEntry(filePath: string): FileIndexEntry {
  const normalizedPath = normalizeRelativePath(filePath);
  const filename = basename(normalizedPath);
  const directory = normalizedPath.includes('/')
    ? normalizedPath.slice(0, normalizedPath.lastIndexOf('/'))
    : '';

  return {
    path: normalizedPath,
    filename,
    directory,
    filenameAcronymLower: createSearchAcronym(filename),
    filenameLower: filename.toLowerCase(),
    pathLower: normalizedPath.toLowerCase(),
    depth: directory ? directory.split('/').length : 0,
    pathSegmentsLower: normalizedPath.toLowerCase().split('/'),
  };
}

export function searchFileIndex(
  cache: FileIndexCache,
  rootPath: string,
  query: string,
): ProjectFileSearchResult[] {
  const queryTokens = tokenizeSearchText(query);
  const seenPaths = new Set<string>();
  const scoredResults: ScoredFileResult[] = [];
  const searchHits = cache.index.search(query);

  for (const rawHit of searchHits) {
    const hit = rawHit as SearchResult & IndexedFileDocument;
    const entry = cache.entriesByPath.get(hit.path);
    if (!entry || seenPaths.has(entry.path)) continue;

    const heuristicScore = scoreFileEntry(entry, query, queryTokens);
    if (heuristicScore <= 0) continue;

    seenPaths.add(entry.path);
    scoredResults.push({
      rootPath,
      path: entry.path,
      filename: entry.filename,
      score: hit.score + heuristicScore,
      depth: entry.depth,
    });

    if (scoredResults.length >= MAX_FILE_RESULTS * 4) break;
  }

  if (scoredResults.length < MAX_FILE_RESULTS) {
    appendHeuristicMatches(cache, rootPath, query, queryTokens, seenPaths, scoredResults);
  }

  scoredResults.sort(compareFileResults);
  return scoredResults
    .slice(0, MAX_FILE_RESULTS)
    .map(({ depth: _depth, score: _score, ...result }) => result);
}

function appendHeuristicMatches(
  cache: FileIndexCache,
  rootPath: string,
  query: string,
  queryTokens: readonly string[],
  seenPaths: Set<string>,
  scoredResults: ScoredFileResult[],
): void {
  for (const entry of cache.entries) {
    if (seenPaths.has(entry.path)) continue;
    const score = scoreFileEntry(entry, query, queryTokens);
    if (score <= 0) continue;

    seenPaths.add(entry.path);
    scoredResults.push({
      rootPath,
      path: entry.path,
      filename: entry.filename,
      score,
      depth: entry.depth,
    });
  }
}

export function scoreFileEntry(
  entry: FileIndexEntry,
  query: string,
  queryTokens: readonly string[],
): number {
  let score = 0;
  let matched = false;

  const filenameIndex = entry.filenameLower.indexOf(query);
  if (filenameIndex >= 0) {
    matched = true;
    score += filenameIndex === 0 ? 160 : 120 - Math.min(filenameIndex * 4, 60);
    if (entry.filenameLower === query) score += 60;
  }

  const pathIndex = entry.pathLower.indexOf(query);
  if (pathIndex >= 0) {
    matched = true;
    score += pathIndex === 0 ? 70 : 50 - Math.min(pathIndex * 2, 40);
  }

  const acronymScore = scoreFilenameAcronym(entry, query);
  if (acronymScore > 0) {
    matched = true;
    score += acronymScore;
  }

  let tokenScore = 0;
  let allTokensMatched = true;
  for (const token of queryTokens) {
    if (entry.filenameLower.includes(token)) {
      matched = true;
      tokenScore += entry.filenameLower.startsWith(token) ? 24 : 16;
    } else if (entry.pathLower.includes(token)) {
      matched = true;
      tokenScore += 8;
    } else {
      allTokensMatched = false;
      break;
    }
  }

  if (allTokensMatched) score += tokenScore;
  if (!matched) return 0;
  if (entry.pathSegmentsLower.includes(query)) score += 18;

  score -= entry.depth * 2;
  score -= Math.min(entry.path.length, 180) * 0.06;
  return Math.max(score, 0);
}

function compareFileResults(left: ScoredFileResult, right: ScoredFileResult): number {
  return (right.score - left.score)
    || (left.depth - right.depth)
    || (left.filename.length - right.filename.length)
    || left.path.localeCompare(right.path);
}

function scoreFilenameAcronym(entry: FileIndexEntry, query: string): number {
  if (query.length < 2 || query.includes(' ') || !entry.filenameAcronymLower) return 0;
  if (entry.filenameAcronymLower === query) return 96;
  if (entry.filenameAcronymLower.startsWith(query)) {
    return 80 - Math.min((entry.filenameAcronymLower.length - query.length) * 3, 30);
  }
  return 0;
}

export function parseGitFileListOutput(stdout: string): string[] {
  return stdout.split('\0').map(normalizeRelativePath).filter(Boolean);
}

function normalizeRelativePath(filePath: string): string {
  return filePath.trim().replace(/\\/g, '/');
}

export function tokenizeSearchText(text: string): string[] {
  return text.toLowerCase().split(FILE_TOKEN_SEPARATOR).filter(Boolean);
}

function createSearchAcronym(text: string): string {
  return text
    .replace(SEARCH_ACRONYM_BOUNDARY, '$1 $2')
    .split(FILE_TOKEN_SEPARATOR)
    .filter(Boolean)
    .map((part) => part[0]?.toLowerCase() ?? '')
    .join('');
}
