import type { Stats } from 'node:fs';
import type { GitDiffFileEntry, GitDiffMode, GitFileDiffResponse } from '../../../shared/ipc-types.js';
import { HEAD_REF, PATHSPEC_SEPARATOR, STATUS_ARGS, VERIFY_HEAD_ARGS } from './gitArgs.js';
import { git, gitOrThrow, safeGit } from './gitCommand.js';
import {
  countPatchStats,
  EMPTY_PATCH_STATS,
  mergeTrackedDiffStats,
  parseDiffToStatusEntries,
  parsePorcelainV1Z,
  parseRawDiffWithNumstat,
  sortGitDiffFiles,
  splitDiffByFile,
  summarizeGitDiffFiles,
  type ParsedStatusEntry,
  type TrackedDiffStat,
  type WorkingTreeDiffData,
} from './gitDiffParser.js';
import {
  readUntrackedFileContent,
  selectScannableUntracked,
  SKIPPED_UNTRACKED_CONTENT,
  UNREAD_UNTRACKED_CONTENT,
  UntrackedScanCache,
  type UntrackedFileContent,
} from './gitUntrackedFile.js';

const BYTES_PER_MB = 1024 * 1024;
const FULL_FILE_CONTEXT_LINES = 999_999;
const FULL_FILE_DIFF_MAX_BYTES = 10 * BYTES_PER_MB;
const FULL_FILE_DIFF_TOO_LARGE_MESSAGE = 'Full-file diff is too large; showing compact diff.';
const FULL_FILE_DIFF_UNAVAILABLE_MESSAGE = 'Full-file diff could not be loaded; showing compact diff.';
const MAX_BUFFER_EXCEEDED_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
const REVIEW_DIFF_MAX_BUFFER = 64 * BYTES_PER_MB;
const REVIEW_DIFF_TOO_LARGE_MESSAGE =
  `The diff is too large to review (exceeds ${REVIEW_DIFF_MAX_BUFFER / BYTES_PER_MB} MB)`;
const CACHED_FLAG = '--cached';
const DIFF_PATCH_ARGS = ['diff', '--no-color', '--find-renames'] as const;
const DIFF_RAW_ARGS = ['diff', '--raw', '--numstat', '-z', '--find-renames'] as const;

interface FullContextDiffResult {
  diffText: string;
  error?: string;
  tooLarge?: boolean;
}
/** What a repeat caller already holds for the untracked scan of one worktree. */
export interface UntrackedScanInput {
  cache?: UntrackedScanCache;
  stats?: ReadonlyMap<string, Stats>;
}

interface UntrackedScan extends UntrackedScanInput {
  cache: UntrackedScanCache;
  includePatches: boolean;
  /** Null when untracked content was never requested. */
  scannable: Set<string> | null;
  worktreePath: string;
}

/**
 * Working-tree collection for callers that already ran `git status` and know
 * whether HEAD resolves, so neither process is spent twice. `untracked` carries
 * the stats those callers already took, so untracked files are not stat-ed
 * twice, and the worktree's scan cache, so unchanged files are not re-read.
 */
export async function collectWorkingTreeDiffFromStatus(
  worktreePath: string,
  parsedStatus: ParsedStatusEntry[],
  hasHeadCommit: boolean,
  includePatches: boolean,
  includeUntrackedContent: boolean,
  untracked?: UntrackedScanInput,
): Promise<WorkingTreeDiffData> {
  let trackedDiffText = '';
  let trackedStatsByPath = new Map<string, TrackedDiffStat>();

  if (hasHeadCommit) {
    const [statsRaw, diffRaw] = await Promise.all([
      safeGit(worktreePath, [...DIFF_RAW_ARGS, HEAD_REF, PATHSPEC_SEPARATOR], ''),
      includePatches ? safeGit(worktreePath, [...DIFF_PATCH_ARGS, HEAD_REF, PATHSPEC_SEPARATOR], '') : Promise.resolve(''),
    ]);
    trackedStatsByPath = parseRawDiffWithNumstat(statsRaw);
    trackedDiffText = diffRaw ?? '';
  } else {
    const [cachedStatsRaw, workingStatsRaw, cachedDiffRaw, workingDiffRaw] = await Promise.all([
      safeGit(worktreePath, [...DIFF_RAW_ARGS, CACHED_FLAG, PATHSPEC_SEPARATOR], ''),
      safeGit(worktreePath, [...DIFF_RAW_ARGS, PATHSPEC_SEPARATOR], ''),
      includePatches ? safeGit(worktreePath, [...DIFF_PATCH_ARGS, CACHED_FLAG, PATHSPEC_SEPARATOR], '') : Promise.resolve(''),
      includePatches ? safeGit(worktreePath, [...DIFF_PATCH_ARGS, PATHSPEC_SEPARATOR], '') : Promise.resolve(''),
    ]);
    trackedStatsByPath = mergeTrackedDiffStats(
      parseRawDiffWithNumstat(cachedStatsRaw),
      parseRawDiffWithNumstat(workingStatsRaw),
    );
    trackedDiffText = [cachedDiffRaw, workingDiffRaw]
      .map((chunk) => chunk ?? '')
      .filter(Boolean)
      .join('\n');
  }

  const trackedPatchByPath = includePatches ? splitDiffByFile(trackedDiffText) : new Map<string, string>();
  const cache = untracked?.cache ?? new UntrackedScanCache();
  const untrackedScan: UntrackedScan = {
    cache,
    includePatches,
    scannable: includeUntrackedContent ? selectScannableUntracked(parsedStatus, cache) : null,
    stats: untracked?.stats,
    worktreePath,
  };

  const files = sortGitDiffFiles(await Promise.all(parsedStatus.map(async (entry) => {
    if (entry.status === 'untracked') {
      return buildUntrackedFileEntry(entry, untrackedScan);
    }
    return buildTrackedFileEntry(entry, trackedStatsByPath, trackedPatchByPath, includePatches);
  })));

  const diff = includePatches
    ? files
      .filter((file) => file.patch)
      .map((file) => file.patch!.trimEnd())
      .filter(Boolean)
      .join('\n\n')
    : '';
  const summary = summarizeGitDiffFiles(files);

  return {
    diff,
    files,
    ...summary,
  };
}

export async function collectRangeDiffData(
  worktreePath: string,
  diffMode: Exclude<GitDiffMode, 'working'>,
  baseBranch: string,
): Promise<WorkingTreeDiffData> {
  return collectDiffForRange(worktreePath, rangeFor(diffMode, baseBranch));
}

export async function collectWorkingTreeFilePatch(
  worktreePath: string,
  path: string,
  oldPath?: string,
): Promise<GitFileDiffResponse> {
  const [statusOutput, hasHeadCommit] = await Promise.all([
    git(worktreePath, STATUS_ARGS),
    safeGit(worktreePath, VERIFY_HEAD_ARGS, ''),
  ]);
  const statusEntry = findStatusEntryForPath(parsePorcelainV1Z(statusOutput), path, oldPath);

  if (statusEntry?.status === 'untracked') {
    return {
      path: statusEntry.path,
      ...(await readUntrackedFileContent(worktreePath, statusEntry.path, true)),
    };
  }

  const resolvedOldPath = oldPath ?? statusEntry?.oldPath;
  const diffText = hasHeadCommit
    ? await collectFullContextDiff(worktreePath, HEAD_REF, path, resolvedOldPath)
    : await collectInitialCommitFullContextDiff(worktreePath, path, resolvedOldPath);

  return buildFileDiffResponse(path, resolvedOldPath, diffText);
}

export async function collectRangeFilePatch(
  worktreePath: string,
  diffMode: Exclude<GitDiffMode, 'working'>,
  baseBranch: string,
  path: string,
  oldPath?: string,
): Promise<GitFileDiffResponse> {
  const diffText = await collectFullContextDiff(worktreePath, rangeFor(diffMode, baseBranch), path, oldPath);

  return buildFileDiffResponse(path, oldPath, diffText);
}

/**
 * Diff a synthetic snapshot commit against its merge base with the source branch
 * (`base...snapshot`). Used by the review flow so the reviewer sees the full set
 * of changes captured in the snapshot, including work that was uncommitted on the
 * source branch.
 */
export async function collectSnapshotDiffData(
  worktreePath: string,
  baseBranch: string,
  snapshotSha: string,
): Promise<WorkingTreeDiffData> {
  return collectDiffForRange(worktreePath, `${baseBranch}...${snapshotSha}`);
}

/**
 * Diff a snapshot commit against the current HEAD (`HEAD...snapshot`). Used when
 * reviewing a pane that edits a shared checkout directly (no dedicated worktree):
 * the reviewer sees only this session's uncommitted changes, not the branch's
 * prior commits.
 */
export async function collectWorkingDiffData(
  repoPath: string,
  snapshotSha: string,
): Promise<WorkingTreeDiffData> {
  return collectDiffForRange(repoPath, `${HEAD_REF}...${snapshotSha}`);
}

async function collectDiffForRange(worktreePath: string, range: string): Promise<WorkingTreeDiffData> {
  let rawDiff: string;
  try {
    rawDiff = await gitOrThrow(
      worktreePath,
      [...DIFF_PATCH_ARGS, range, PATHSPEC_SEPARATOR],
      { maxBuffer: REVIEW_DIFF_MAX_BUFFER },
    );
  } catch (err) {
    if (hasErrorCode(err, MAX_BUFFER_EXCEEDED_CODE)) throw new Error(REVIEW_DIFF_TOO_LARGE_MESSAGE);
    throw err;
  }
  const result = parseDiffToStatusEntries(rawDiff);
  const trackedPatchByPath = splitDiffByFile(result.trackedDiffText);

  const files = sortGitDiffFiles(result.parsedStatus.map((entry) => {
    const patch = findPatchInMap(trackedPatchByPath, entry.path, entry.oldPath);
    const patchStats = countPatchStats(patch);

    return {
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      staged: entry.staged,
      unstaged: entry.unstaged,
      additions: patchStats.additions,
      deletions: patchStats.deletions,
      patch,
      isBinary: patchStats.isBinary,
    };
  }));

  const diff = files
    .filter((file) => file.patch)
    .map((file) => file.patch!.trimEnd())
    .filter(Boolean)
    .join('\n\n');

  return {
    diff,
    files,
    ...summarizeGitDiffFiles(files),
  };
}

async function collectFullContextDiff(
  worktreePath: string,
  range: string,
  path: string,
  oldPath?: string,
): Promise<FullContextDiffResult> {
  return runFullContextDiff(worktreePath, fullContextDiffArgs(range, path, oldPath));
}

async function collectInitialCommitFullContextDiff(
  worktreePath: string,
  path: string,
  oldPath?: string,
): Promise<FullContextDiffResult> {
  const [cachedDiff, workingDiff] = await Promise.all([
    runFullContextDiff(worktreePath, fullContextDiffArgs(CACHED_FLAG, path, oldPath)),
    runFullContextDiff(worktreePath, fullContextDiffArgs('', path, oldPath)),
  ]);

  return mergeFullContextDiffs(cachedDiff, workingDiff);
}

async function runFullContextDiff(worktreePath: string, args: readonly string[]): Promise<FullContextDiffResult> {
  try {
    return {
      diffText: await gitOrThrow(worktreePath, args, { maxBuffer: FULL_FILE_DIFF_MAX_BYTES }),
    };
  } catch (error) {
    return buildFullContextError(error);
  }
}

function mergeFullContextDiffs(...results: FullContextDiffResult[]): FullContextDiffResult {
  const failure = results.find((result) => result.error || result.tooLarge);
  if (failure) return failure;

  return {
    diffText: results
      .map((result) => result.diffText)
      .filter(Boolean)
      .join('\n'),
  };
}

function buildFullContextError(error: unknown): FullContextDiffResult {
  if (hasErrorCode(error, MAX_BUFFER_EXCEEDED_CODE)) {
    return {
      diffText: '',
      error: FULL_FILE_DIFF_TOO_LARGE_MESSAGE,
      tooLarge: true,
    };
  }

  return {
    diffText: '',
    error: FULL_FILE_DIFF_UNAVAILABLE_MESSAGE,
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return (error as { code?: unknown }).code === code;
}

function buildFileDiffResponse(path: string, oldPath: string | undefined, result: FullContextDiffResult): GitFileDiffResponse {
  if (result.error || result.tooLarge) {
    return {
      path,
      error: result.error ?? FULL_FILE_DIFF_UNAVAILABLE_MESSAGE,
      tooLarge: result.tooLarge || undefined,
    };
  }

  const patch = findPatchForPath(result.diffText, path, oldPath);
  if (!patch) {
    return {
      path,
      error: FULL_FILE_DIFF_UNAVAILABLE_MESSAGE,
    };
  }

  const patchStats = countPatchStats(patch);

  return {
    path,
    patch,
    isBinary: patchStats.isBinary || undefined,
  };
}

function findPatchForPath(diffText: string, path: string, oldPath?: string): string | undefined {
  return findPatchInMap(splitDiffByFile(diffText), path, oldPath);
}

function findPatchInMap(patchByPath: Map<string, string>, path: string, oldPath?: string): string | undefined {
  return patchByPath.get(path) ?? (oldPath ? patchByPath.get(oldPath) : undefined);
}

function findStatusEntryForPath(
  entries: ReturnType<typeof parsePorcelainV1Z>,
  path: string,
  oldPath?: string,
): ReturnType<typeof parsePorcelainV1Z>[number] | undefined {
  return entries.find((entry) => entry.path === path)
    ?? entries.find((entry) => matchesPath(entry.path, entry.oldPath, path, oldPath));
}

function fullContextDiffArgs(range: string, path: string, oldPath?: string): string[] {
  return [
    ...DIFF_PATCH_ARGS,
    `--unified=${FULL_FILE_CONTEXT_LINES}`,
    ...(range ? [range] : []),
    PATHSPEC_SEPARATOR,
    ...formatPathspecs(path, oldPath),
  ];
}

function rangeFor(diffMode: Exclude<GitDiffMode, 'working'>, baseBranch: string): string {
  return diffMode === 'branch'
    ? `${baseBranch}...${HEAD_REF}`
    : `${HEAD_REF}~1..${HEAD_REF}`;
}

function formatPathspecs(path: string, oldPath?: string): string[] {
  return uniquePaths(path, oldPath).map((value) => `:(literal)${value}`);
}

function matchesPath(entryPath: string, entryOldPath: string | undefined, path: string, oldPath?: string): boolean {
  const requestedPaths = uniquePaths(path, oldPath);
  return uniquePaths(entryPath, entryOldPath).some((entryValue) => requestedPaths.includes(entryValue));
}

function uniquePaths(...paths: Array<string | undefined>): string[] {
  return Array.from(new Set(paths.filter((path): path is string => Boolean(path))));
}

async function buildUntrackedFileEntry(
  entry: ParsedStatusEntry,
  scan: UntrackedScan,
): Promise<GitDiffFileEntry> {
  const content = await resolveUntrackedContent(entry.path, scan);

  return {
    path: entry.path,
    oldPath: entry.oldPath,
    status: entry.status,
    staged: entry.staged,
    unstaged: entry.unstaged,
    additions: content.additions,
    deletions: 0,
    patch: content.patch,
    isBinary: content.isBinary,
    tooLarge: content.tooLarge,
  };
}

/**
 * A null scannable set means untracked content was never requested; a path
 * missing from a present set was dropped by the scan cap and says so.
 */
async function resolveUntrackedContent(path: string, scan: UntrackedScan): Promise<UntrackedFileContent> {
  if (!scan.scannable) return UNREAD_UNTRACKED_CONTENT;
  if (!scan.scannable.has(path)) return SKIPPED_UNTRACKED_CONTENT;
  return scan.cache.read(scan.worktreePath, path, scan.includePatches, scan.stats?.get(path));
}

function buildTrackedFileEntry(
  entry: ParsedStatusEntry,
  trackedStatsByPath: Map<string, TrackedDiffStat>,
  trackedPatchByPath: Map<string, string>,
  includePatches: boolean,
): GitDiffFileEntry {
  const trackedStat = trackedStatsByPath.get(entry.path)
    ?? (entry.oldPath ? trackedStatsByPath.get(entry.oldPath) : undefined);
  const patch = includePatches ? findPatchInMap(trackedPatchByPath, entry.path, entry.oldPath) : undefined;
  const patchStats = patch ? countPatchStats(patch) : EMPTY_PATCH_STATS;

  return {
    path: entry.path,
    oldPath: entry.oldPath,
    status: entry.status,
    staged: entry.staged,
    unstaged: entry.unstaged,
    additions: trackedStat?.additions ?? patchStats.additions,
    deletions: trackedStat?.deletions ?? patchStats.deletions,
    patch,
    isBinary: patchStats.isBinary,
  };
}
