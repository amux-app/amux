import type { Stats } from 'node:fs';
import { getCommitsAhead, parseRecentCommits, resolveBaseBranch } from './baseBranch.js';
import { BoundedCache } from '../boundedCache.js';
import { STATUS_ARGS } from './gitArgs.js';
import { git, safeGit } from './gitCommand.js';
import { collectWorkingTreeDiffFromStatus } from './gitDiffCollector.js';
import { parsePorcelainV1Z, type ParsedStatusEntry, type WorkingTreeDiffData } from './gitDiffParser.js';
import { MAX_UNTRACKED_SCAN_FILES, UntrackedScanCache } from './gitUntrackedFile.js';
import {
  canonicalWorktreePath,
  readWorktreeContext,
  releaseWorktreePath,
  type WorktreeContext,
} from './gitWorktreeContext.js';
import { readHeadSignature, readWorkingSignature } from './gitWorktreeSignature.js';

interface RecentCommit {
  message: string;
  sha: string;
}

export interface WorktreeMeta {
  baseBranch: string;
  commitsAhead: number | null;
  context: WorktreeContext;
  recentCommits: RecentCommit[];
}

export interface WorktreeSnapshot extends WorktreeMeta {
  diff: WorkingTreeDiffData;
}

interface RepoMeta {
  baseBranch: string;
  commitsAhead: number | null;
  recentCommits: RecentCommit[];
}

interface MetaState {
  fetchedAt: number;
  meta: RepoMeta;
}

interface HeadState {
  context: WorktreeContext;
  headChanged: boolean;
  headSignature: string;
}

interface WorkingState {
  entries: ParsedStatusEntry[];
  signature: string;
  stats: Map<string, Stats>;
  statusOutput: string;
}

/** What a caller needs out of an entry; raised in place while a collection runs. */
interface Need {
  diff: boolean;
  patches: boolean;
}

interface Flight {
  need: Need;
  promise: Promise<CacheEntry | null>;
}

interface DiffEntry {
  checkedAt: number;
  data: WorkingTreeDiffData;
  includesPatches: boolean;
  patchesWantedAt: number;
  statusOutput: string;
  workingSignature: string;
}

interface CacheEntry {
  checkedAt: number;
  context: WorktreeContext;
  diff: DiffEntry | null;
  headSignature: string;
  meta: RepoMeta;
  metaFetchedAt: number;
  /** Untracked reads memoized for this worktree; released with the entry. */
  untracked: UntrackedScanCache;
}

const RECENT_COMMITS_ARGS = ['log', '-3', '--format=%h%x1f%s%x1e'] as const;
// Collapses the burst of requests several panes fire in the same frame. Kept
// short so an explicit user refresh is never answered with visibly stale data.
const FRESH_MS = 300;
// Upper bound on how long remote-driven metadata (ahead count, base branch) may
// lag behind a fetch that did not move HEAD.
const META_TTL_MS = 15_000;
// How long a worktree keeps collecting patches after the last caller asked for
// them. Covers the diff view's poll interval so a status-only refresh in between
// cannot drop them, and releases the memory once that view stops polling.
const PATCH_RETENTION_MS = 30_000;
// An entry holds a full working-tree diff, patches included, so the cache is
// bounded rather than left to grow with every worktree the process ever saw.
// The bound covers the worktrees one fleet polls in a refresh cycle (a project's
// panes plus their repository roots, across a handful of open projects); beyond
// that, the least recently used worktree pays one extra collection.
const MAX_CACHED_WORKTREES = 32;

const cache = new BoundedCache<CacheEntry>(MAX_CACHED_WORKTREES);
const inFlight = new Map<string, Flight>();

/**
 * Repository context and branch metadata without the working-tree diff, for
 * callers that render a commit range: they need the base branch and commit
 * counts, but none of the working-tree scan.
 */
export async function getWorktreeMeta(worktreePath: string): Promise<WorktreeMeta | null> {
  const entry = await resolveEntry(worktreePath, { diff: false, patches: false });
  return entry ? toMeta(entry) : null;
}

/**
 * Working-tree snapshot shared by every caller looking at the same worktree.
 * Keyed by the resolved working tree path so sibling worktrees of one
 * repository never see each other's counts.
 */
export async function getWorktreeSnapshot(
  worktreePath: string,
  includePatches: boolean,
): Promise<WorktreeSnapshot | null> {
  const entry = await resolveEntry(worktreePath, { diff: true, patches: includePatches });
  if (!entry?.diff) return null;
  return { ...toMeta(entry), diff: entry.diff.data };
}

/**
 * Frees everything cached for a worktree that is going away, so a closed pane
 * or a removed worktree releases its diff immediately instead of waiting to be
 * evicted by later traffic.
 */
export function releaseWorktreeSnapshot(worktreePath: string): void {
  cache.delete(releaseWorktreePath(worktreePath));
}

async function resolveEntry(worktreePath: string, need: Need): Promise<CacheEntry | null> {
  const key = await canonicalWorktreePath(worktreePath);
  while (true) {
    const fresh = readFreshEntry(key, need);
    if (fresh) return fresh;

    const pending = inFlight.get(key);
    if (pending) {
      raiseNeed(pending.need, need);
      const entry = await pending.promise;
      if (satisfies(entry, need)) return entry;
      // The need may have been raised after the running collector committed to
      // its detail level. Re-enter through the shared-flight gate so several
      // late callers coalesce into one follow-up collection.
      continue;
    }
    return beginFlight(worktreePath, key, need);
  }
}

/**
 * One collection per worktree serves every caller. A caller that needs more than
 * the running collection was asked for raises its requirement in place; only a
 * request arriving after that collection committed pays for a pass of its own.
 */
function beginFlight(worktreePath: string, key: string, need: Need): Promise<CacheEntry | null> {
  const shared: Need = { ...need };
  const promise = buildEntry(worktreePath, key, shared).finally(() => {
    if (inFlight.get(key)?.need === shared) inFlight.delete(key);
  });
  inFlight.set(key, { need: shared, promise });
  return promise;
}

function raiseNeed(target: Need, need: Need): void {
  target.diff = target.diff || need.diff;
  target.patches = target.patches || need.patches;
}

function satisfies(entry: CacheEntry | null, need: Need): boolean {
  if (!entry || !need.diff) return true;
  const { diff } = entry;
  return !!diff && (!need.patches || diff.includesPatches);
}

function readFreshEntry(key: string, need: Need): CacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (!need.diff) return isFresh(entry.checkedAt) ? entry : null;

  const { diff } = entry;
  if (!diff || (need.patches && !diff.includesPatches)) return null;
  return isFresh(diff.checkedAt) ? entry : null;
}

function isFresh(checkedAt: number): boolean {
  return Date.now() - checkedAt <= FRESH_MS;
}

async function buildEntry(worktreePath: string, key: string, need: Need): Promise<CacheEntry | null> {
  const cached = cache.get(key);
  const head = await resolveHead(worktreePath, cached);
  if (!head) {
    cache.delete(key);
    return null;
  }

  const working = need.diff ? await readWorkingState(worktreePath) : null;
  if (cached && isReusable(cached, head, working, need)) return touch(cached, working, need);

  const untracked = cached?.untracked ?? new UntrackedScanCache();
  const [meta, diff] = await Promise.all([
    resolveMeta(worktreePath, head, cached),
    resolveDiff(worktreePath, head, cached, working, need, untracked),
  ]);

  const entry: CacheEntry = {
    checkedAt: Date.now(),
    context: head.context,
    diff,
    headSignature: head.headSignature,
    meta: meta.meta,
    metaFetchedAt: meta.fetchedAt,
    untracked,
  };
  cache.set(key, entry);
  return entry;
}

async function readWorkingState(worktreePath: string): Promise<WorkingState> {
  const statusOutput = await git(worktreePath, STATUS_ARGS);
  const entries = parsePorcelainV1Z(statusOutput);
  const { signature, stats } = await readWorkingSignature(worktreePath, pathsForWorkingSignature(entries));

  return { entries, signature, stats, statusOutput };
}

/**
 * The diff collector never reads untracked content past its safety cap, so
 * stat-ing those omitted paths cannot affect the cached result. Tracked paths
 * remain unbounded because every one contributes exact diff data.
 */
function pathsForWorkingSignature(entries: readonly ParsedStatusEntry[]): string[] {
  const paths: string[] = [];
  let untrackedCount = 0;
  for (const entry of entries) {
    if (entry.status === 'untracked') {
      untrackedCount += 1;
      if (untrackedCount > MAX_UNTRACKED_SCAN_FILES) continue;
    }
    paths.push(entry.path);
  }
  return paths;
}

async function resolveHead(worktreePath: string, cached: CacheEntry | undefined): Promise<HeadState | null> {
  if (cached) {
    const { gitCommonDir, gitDir } = cached.context;
    const headSignature = await readHeadSignature(gitDir, gitCommonDir);
    if (headSignature === cached.headSignature) {
      return { context: cached.context, headChanged: false, headSignature };
    }
  }

  const context = await readWorktreeContext(worktreePath);
  if (!context) return null;

  return {
    context,
    headChanged: true,
    headSignature: await readHeadSignature(context.gitDir, context.gitCommonDir),
  };
}

async function resolveDiff(
  worktreePath: string,
  head: HeadState,
  cached: CacheEntry | undefined,
  working: WorkingState | null,
  need: Need,
  untracked: UntrackedScanCache,
): Promise<DiffEntry | null> {
  // A metadata-only pass keeps a diff that is still valid and drops one a moved
  // HEAD invalidated, since the working tree is only ever compared against HEAD.
  if (!working) return cached && !head.headChanged ? cached.diff : null;

  const includePatches = need.patches || retainsPatches(cached);
  const data = await collectWorkingTreeDiffFromStatus(
    worktreePath,
    working.entries,
    head.context.hasHeadCommit,
    includePatches,
    true,
    { cache: untracked, stats: working.stats },
  );
  const now = Date.now();

  return {
    checkedAt: now,
    data,
    includesPatches: includePatches,
    patchesWantedAt: need.patches ? now : (cached?.diff?.patchesWantedAt ?? 0),
    statusOutput: working.statusOutput,
    workingSignature: working.signature,
  };
}

/**
 * Patch collection stays on while the diff view keeps polling, so a status-only
 * refresh in between cannot downgrade the entry and force the next diff request
 * to collect the patches again.
 */
function retainsPatches(cached: CacheEntry | undefined): boolean {
  const diff = cached?.diff;
  return !!diff?.includesPatches && Date.now() - diff.patchesWantedAt <= PATCH_RETENTION_MS;
}

async function resolveMeta(
  worktreePath: string,
  head: HeadState,
  cached: CacheEntry | undefined,
): Promise<MetaState> {
  if (cached && !head.headChanged && !isMetaStale(cached)) {
    return { fetchedAt: cached.metaFetchedAt, meta: cached.meta };
  }
  return { fetchedAt: Date.now(), meta: await collectMeta(worktreePath, head.context) };
}

function isReusable(cached: CacheEntry, head: HeadState, working: WorkingState | null, need: Need): boolean {
  if (head.headChanged) return false;
  if (!working) return !isMetaStale(cached);

  const { diff } = cached;
  if (!diff || (need.patches && !diff.includesPatches)) return false;
  return diff.statusOutput === working.statusOutput && diff.workingSignature === working.signature;
}

function touch(entry: CacheEntry, working: WorkingState | null, need: Need): CacheEntry {
  const now = Date.now();
  entry.checkedAt = now;
  if (!working || !entry.diff) return entry;

  entry.diff.checkedAt = now;
  if (need.patches) entry.diff.patchesWantedAt = now;
  return entry;
}

function isMetaStale(cached: CacheEntry): boolean {
  return Date.now() - cached.metaFetchedAt > META_TTL_MS;
}

function toMeta(entry: CacheEntry): WorktreeMeta {
  return { ...entry.meta, context: entry.context };
}

async function collectMeta(worktreePath: string, context: WorktreeContext): Promise<RepoMeta> {
  const baseBranch = await resolveBaseBranch(worktreePath, context.gitCommonDir);
  const [commitsAhead, recentCommitsRaw] = await Promise.all([
    getCommitsAhead(worktreePath, baseBranch),
    context.hasHeadCommit ? safeGit(worktreePath, RECENT_COMMITS_ARGS) : Promise.resolve(''),
  ]);

  return { baseBranch, commitsAhead, recentCommits: parseRecentCommits(recentCommitsRaw) };
}

export const __test__ = {
  cachedWorktreeCount: () => cache.size,
  maxCachedWorktrees: MAX_CACHED_WORKTREES,
  pathsForWorkingSignature,
  resetSnapshotCache: () => {
    cache.clear();
    inFlight.clear();
  },
};
