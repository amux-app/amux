import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileAsync } from '../utils/execAsync.js';
import { getManagedWorktreesDir } from '../utils/worktreePaths.js';

const METADATA_CONCURRENCY = 4;

export type PreservedWorktreeGitStatus =
  | 'clean'
  | 'dirty'
  | 'unavailable'
  | 'unchecked';

export type PreservedWorktreeRegistration =
  | 'registered'
  | 'unregistered'
  | 'unchecked';

export interface PreservedWorktree {
  branch: string | null;
  gitStatus: PreservedWorktreeGitStatus;
  lastModified: Date;
  path: string;
  registration: PreservedWorktreeRegistration;
  slug: string;
}

export interface PreservedWorktreeRemovalState {
  branch: string | null;
  gitStatus: PreservedWorktreeGitStatus;
  registration: PreservedWorktreeRegistration;
}

export interface RemovePreservedWorktreeOptions {
  activeWorktreePaths: string[];
  allowDataLoss: boolean;
  expectedState: PreservedWorktreeRemovalState;
  projectRoot: string;
  worktreePath: string;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await operation(values[index]);
    }
  };

  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function normalizeActivePaths(activeWorktreePaths: string[]): Set<string> {
  return new Set(activeWorktreePaths.map((worktreePath) => resolve(worktreePath)));
}

function hasRemovalRisk(worktree: PreservedWorktreeRemovalState): boolean {
  return worktree.gitStatus !== 'clean'
    || worktree.registration !== 'registered'
    || worktree.branch === null;
}

function resolveManagedWorktreePath(projectRoot: string, requestedPath: string): string {
  const managedRoot = resolve(getManagedWorktreesDir(projectRoot));
  const worktreePath = resolve(requestedPath);
  if (dirname(worktreePath) !== managedRoot || basename(worktreePath).length === 0) {
    throw new Error('Worktree is outside the managed worktree directory');
  }
  return worktreePath;
}

async function readMetadata(
  projectRoot: string,
  activePaths: Set<string>,
  requestedPath: string,
): Promise<PreservedWorktree> {
  const worktreePath = resolveManagedWorktreePath(projectRoot, requestedPath);
  if (activePaths.has(worktreePath)) {
    throw new Error('Worktree is active and cannot be treated as preserved');
  }

  const gitMarkerPath = join(worktreePath, '.git');
  const [worktreeStats, gitMarkerStats] = await Promise.all([
    lstat(worktreePath),
    lstat(gitMarkerPath),
  ]);

  if (!worktreeStats.isDirectory() || worktreeStats.isSymbolicLink()) {
    throw new Error('Managed worktree path is not a regular directory');
  }
  if (
    gitMarkerStats.isSymbolicLink()
    || (!gitMarkerStats.isFile() && !gitMarkerStats.isDirectory())
  ) {
    throw new Error('Managed worktree has an invalid Git marker');
  }

  return {
    branch: null,
    gitStatus: 'unchecked',
    lastModified: worktreeStats.mtime > gitMarkerStats.mtime
      ? worktreeStats.mtime
      : gitMarkerStats.mtime,
    path: worktreePath,
    registration: 'unchecked',
    slug: basename(worktreePath),
  };
}

export async function listPreservedWorktreesAsync(
  projectRoot: string,
  activeWorktreePaths: string[],
): Promise<PreservedWorktree[]> {
  const managedRoot = getManagedWorktreesDir(projectRoot);
  let entries;
  try {
    entries = await readdir(managedRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const activePaths = normalizeActivePaths(activeWorktreePaths);
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(managedRoot, entry.name));
  const metadata = await mapWithConcurrency(
    candidates,
    METADATA_CONCURRENCY,
    async (candidate) => {
      try {
        return await readMetadata(projectRoot, activePaths, candidate);
      } catch {
        return null;
      }
    },
  );

  return metadata
    .filter((worktree): worktree is PreservedWorktree => worktree !== null)
    .sort((left, right) => right.lastModified.getTime() - left.lastModified.getTime());
}

export async function inspectPreservedWorktreeAsync(
  projectRoot: string,
  activeWorktreePaths: string[],
  requestedPath: string,
): Promise<PreservedWorktree> {
  const metadata = await readMetadata(
    projectRoot,
    normalizeActivePaths(activeWorktreePaths),
    requestedPath,
  );

  let branch: string | null = null;
  let gitStatus: PreservedWorktreeGitStatus = 'unavailable';
  try {
    const output = await execFileAsync(
      'git',
      [
        '-C',
        metadata.path,
        'status',
        '--porcelain=v2',
        '--branch',
        '--untracked-files=normal',
      ],
      { timeout: 30_000 },
    );
    const lines = output.split('\n').filter(Boolean);
    const branchHead = lines
      .find((line) => line.startsWith('# branch.head '))
      ?.slice('# branch.head '.length)
      .trim();
    branch = branchHead && !branchHead.startsWith('(') ? branchHead : null;
    const dirty = lines.some((line) => !line.startsWith('# '));
    gitStatus = dirty ? 'dirty' : 'clean';
  } catch {
    // Keep the unavailable status while independently checking registration.
  }

  let registration: PreservedWorktreeRegistration = 'unchecked';
  try {
    registration = await isRegisteredWorktree(projectRoot, metadata.path)
      ? 'registered'
      : 'unregistered';
  } catch {
    // Deletion requires explicit data-loss consent when registration is unknown.
  }

  return {
    ...metadata,
    branch,
    gitStatus,
    registration,
  };
}

function parseRegisteredWorktreePaths(output: string): string[] {
  return output
    .split(/\0|\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

async function isRegisteredWorktree(projectRoot: string, worktreePath: string): Promise<boolean> {
  const output = await execFileAsync(
    'git',
    ['-C', projectRoot, 'worktree', 'list', '--porcelain', '-z'],
    { timeout: 30_000 },
  );
  const canonicalTarget = await realpath(worktreePath);

  for (const registeredPath of parseRegisteredWorktreePaths(output)) {
    try {
      if (await realpath(registeredPath) === canonicalTarget) return true;
    } catch {
      // Ignore stale entries. Git will prune them on a future maintenance run.
    }
  }
  return false;
}

export async function removePreservedWorktreeAsync(
  options: RemovePreservedWorktreeOptions,
): Promise<void> {
  const inspection = await inspectPreservedWorktreeAsync(
    options.projectRoot,
    options.activeWorktreePaths,
    options.worktreePath,
  );

  if (
    inspection.branch !== options.expectedState.branch
    || inspection.gitStatus !== options.expectedState.gitStatus
    || inspection.registration !== options.expectedState.registration
  ) {
    throw new Error('Worktree state changed since it was inspected. Inspect and confirm again.');
  }

  if (inspection.gitStatus === 'dirty' && !options.allowDataLoss) {
    throw new Error('Worktree has uncommitted changes');
  }
  if (inspection.gitStatus === 'unavailable' && !options.allowDataLoss) {
    throw new Error('Worktree status could not be verified');
  }
  if (inspection.registration === 'unregistered' && !options.allowDataLoss) {
    throw new Error('Worktree is not registered with the active repository');
  }
  if (inspection.registration === 'unchecked' && !options.allowDataLoss) {
    throw new Error('Worktree registration could not be verified');
  }
  if (
    inspection.branch === null
    && inspection.gitStatus !== 'unavailable'
    && !options.allowDataLoss
  ) {
    throw new Error('Worktree has a detached HEAD');
  }

  if (inspection.registration === 'registered') {
    const args = ['-C', options.projectRoot, 'worktree', 'remove'];
    if (options.allowDataLoss && hasRemovalRisk(inspection)) args.push('--force');
    args.push(inspection.path);
    await execFileAsync(
      'git',
      args,
      { timeout: 30_000 },
    );
    return;
  }

  await rm(inspection.path, { recursive: true });
}
