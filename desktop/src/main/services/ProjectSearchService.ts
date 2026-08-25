import type { ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import type { MuxBasePane } from 'muxbase/core';
import type {
  ProjectFileSearchResult,
  ProjectTextSearchResult,
} from '../../shared/ipc-types.js';
import { resolveAuthorizedFileRoot } from '../utils/file-root-authorization.js';
import { log } from './Logger.js';
import {
  buildFileIndex,
  createFileSearchIndex,
  FILE_INDEX_TTL_MS,
  parseGitFileListOutput,
  scoreFileEntry,
  searchFileIndex,
  tokenizeSearchText,
  type FileIndexCache,
} from './project-search/ProjectFileIndex.js';
import {
  fallbackTextSearch,
  gitGrep,
  parseGitGrepOutput,
} from './project-search/ProjectTextSearch.js';

const EMPTY_RESULT_REFRESH_AGE_MS = 5_000;
const MIN_QUERY_LENGTH = 2;
const MAX_SETTLED_FILE_INDEXES = 4;

interface FileIndexState {
  cache?: FileIndexCache;
  pending?: Promise<FileIndexCache>;
}

export class ProjectSearchService {
  private readonly activeTextSearchByRoot = new Map<string, ChildProcess>();
  private readonly fileIndexes = new Map<string, FileIndexState>();

  constructor(
    private readonly buildIndex: (rootPath: string) => Promise<FileIndexCache> = buildFileIndex,
  ) {}

  async searchFiles(rootPath: string, query: string): Promise<ProjectFileSearchResult[]> {
    const normalizedQuery = normalizeSearchQuery(query);
    if (normalizedQuery.length < MIN_QUERY_LENGTH) return [];

    const cache = await this.getFileIndex(rootPath);
    const results = searchFileIndex(cache, rootPath, normalizedQuery);
    if (results.length > 0 || Date.now() - cache.builtAt < EMPTY_RESULT_REFRESH_AGE_MS) {
      return results;
    }

    const refreshedCache = await this.getFileIndex(rootPath, true);
    if (refreshedCache === cache) return results;
    return searchFileIndex(refreshedCache, rootPath, normalizedQuery);
  }

  async searchText(rootPath: string, query: string): Promise<ProjectTextSearchResult[]> {
    const normalizedQuery = normalizeSearchQuery(query);
    if (normalizedQuery.length < MIN_QUERY_LENGTH) return [];

    this.activeTextSearchByRoot.get(rootPath)?.kill();
    const grepResults = await gitGrep(
      rootPath,
      normalizedQuery,
      (child) => {
        this.activeTextSearchByRoot.set(rootPath, child);
      },
      (child) => {
        if (this.activeTextSearchByRoot.get(rootPath) === child) {
          this.activeTextSearchByRoot.delete(rootPath);
        }
      },
    );
    if (grepResults !== null) return grepResults;

    const cache = await this.getFileIndex(rootPath);
    return fallbackTextSearch(rootPath, cache.entries, normalizedQuery);
  }

  invalidate(rootPath: string): void {
    if (rootPath) this.fileIndexes.delete(resolve(rootPath));
  }

  private async getFileIndex(rootPath: string, forceRefresh = false): Promise<FileIndexCache> {
    const cacheKey = resolve(rootPath);
    const now = Date.now();
    const state = this.fileIndexes.get(cacheKey);

    if (!forceRefresh && state?.cache && now - state.cache.builtAt < FILE_INDEX_TTL_MS) {
      this.maintainFileIndexes(now, cacheKey, state);
      return state.cache;
    }

    this.maintainFileIndexes(now);

    if (state?.pending) return state.pending;

    const previousCache = state?.cache;
    const pendingState: FileIndexState = { cache: previousCache };
    const pending = this.buildIndex(cacheKey)
      .then((cache) => {
        if (this.fileIndexes.get(cacheKey) !== pendingState) return cache;
        this.maintainFileIndexes(Date.now(), cacheKey, { cache });
        return cache;
      })
      .catch((error) => this.handleIndexFailure(
        cacheKey,
        pendingState,
        previousCache,
        error,
      ));

    pendingState.pending = pending;
    this.fileIndexes.set(cacheKey, pendingState);
    return pending;
  }

  private handleIndexFailure(
    cacheKey: string,
    pendingState: FileIndexState,
    previousCache: FileIndexCache | undefined,
    error: unknown,
  ): FileIndexCache {
    if (this.fileIndexes.get(cacheKey) !== pendingState) {
      if (previousCache) return previousCache;
      throw error;
    }

    if (!previousCache) {
      this.fileIndexes.delete(cacheKey);
      throw error;
    }

    log.warn('project-search', 'File index refresh failed, using cached entries', {
      error: String(error),
      rootPath: cacheKey,
    });
    this.maintainFileIndexes(Date.now(), cacheKey, { cache: previousCache });
    return previousCache;
  }

  private maintainFileIndexes(
    now: number,
    touchedKey?: string,
    touchedState?: FileIndexState,
  ): void {
    for (const [cacheKey, state] of this.fileIndexes) {
      if (!state.pending && state.cache && now - state.cache.builtAt >= FILE_INDEX_TTL_MS) {
        this.fileIndexes.delete(cacheKey);
      }
    }

    if (touchedKey && touchedState) {
      this.fileIndexes.delete(touchedKey);
      this.fileIndexes.set(touchedKey, touchedState);
    }

    let settledCount = 0;
    for (const state of this.fileIndexes.values()) {
      if (state.cache && !state.pending) settledCount += 1;
    }

    for (const [cacheKey, state] of this.fileIndexes) {
      if (settledCount <= MAX_SETTLED_FILE_INDEXES) return;
      if (!state.cache || state.pending) continue;
      this.fileIndexes.delete(cacheKey);
      settledCount -= 1;
    }
  }
}

export const projectSearchService = new ProjectSearchService();

export function resolveProjectSearchRoot(
  projectRoot: string,
  panes: readonly MuxBasePane[],
  requestedRoot?: string,
): string {
  const defaultRoot = resolveDefaultFileRoot(projectRoot, panes);

  if (requestedRoot) {
    try {
      return resolveAuthorizedFileRoot(projectRoot, panes, requestedRoot);
    } catch {
      return defaultRoot;
    }
  }

  return defaultRoot;
}

function resolveDefaultFileRoot(projectRoot: string, panes: readonly MuxBasePane[]): string {
  if (projectRoot) return resolve(projectRoot);

  const firstPaneRoot = panes.find((pane) => pane.worktreePath || pane.projectRoot);
  if (firstPaneRoot?.worktreePath) return resolve(firstPaneRoot.worktreePath);
  if (firstPaneRoot?.projectRoot) return resolve(firstPaneRoot.projectRoot);
  return '';
}

function normalizeSearchQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

export const __test__ = {
  FILE_INDEX_TTL_MS,
  createFileSearchIndex,
  parseGitFileListOutput,
  parseGitGrepOutput,
  resolveProjectSearchRoot,
  scoreFileEntry,
  searchFileIndex,
  tokenizeSearchText,
};
