import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HEAD_REF, PATHSPEC_SEPARATOR, STATUS_ARGS, VERIFY_HEAD_ARGS } from './gitArgs.js';
import { git, gitOrThrow } from './gitCommand.js';
import { parsePorcelainV1Z, type ParsedStatusEntry } from './gitDiffParser.js';

const REVIEW_SNAPSHOT_MESSAGE = 'muxbase review snapshot';
const SNAPSHOT_MAX_FILE_BYTES = 1024 * 1024;
const SECRET_NAME_RE = /(?:^|[\\/])(\.env(\.[^/\\]*)?|secrets?\.(?:json|ya?ml|toml)|credentials?\.(?:json|ya?ml)|.*\.pem|.*\.key|.*\.p12|.*\.pfx|.*\.cer)$/i;

export interface SnapshotResult {
  sha: string;
  skippedFiles: string[];
}

async function skippedSnapshotFiles(
  worktreePath: string,
  statusEntries: ParsedStatusEntry[],
): Promise<string[]> {
  const skip = new Set<string>();

  for (const entry of statusEntries) {
    const paths = [entry.path, entry.oldPath].filter((path): path is string => !!path);
    if (paths.some((path) => SECRET_NAME_RE.test(path))) {
      // Restore both sides of a rename/copy so secret contents cannot move into
      // the snapshot under a non-secret destination name.
      for (const path of paths) skip.add(path);
    }
  }

  const untrackedPaths = statusEntries
    .filter((entry) => entry.status === 'untracked')
    .map((entry) => entry.path);

  await Promise.all(untrackedPaths.map(async (relPath) => {
    if (skip.has(relPath)) return;
    try {
      const fileStat = await stat(resolve(worktreePath, relPath));
      if (fileStat.isFile() && fileStat.size > SNAPSHOT_MAX_FILE_BYTES) {
        skip.add(relPath);
      }
    } catch {
      skip.add(relPath);
    }
  }));

  return [...skip].sort();
}

/**
 * Capture the working state (staged, unstaged, untracked) as an immutable commit
 * without mutating the source branch, index, or history; returns HEAD when clean.
 *
 * Secret-named changes and untracked files larger than 1 MB are excluded from
 * the snapshot and returned as `skippedFiles` so the review prompt can note them.
 *
 * The temp index lives in an OS temp dir, not under `.git`: in a linked worktree
 * `.git` is a file (`gitdir: …`), so an index written there fails to lock.
 */
export async function createReviewSnapshot(worktreePath: string): Promise<SnapshotResult> {
  const headSha = (await git(worktreePath, VERIFY_HEAD_ARGS)).trim();
  if (!headSha) {
    throw new Error('This repository has no commits yet — make an initial commit first');
  }

  const statusEntries = parsePorcelainV1Z(await git(worktreePath, STATUS_ARGS));
  if (statusEntries.length === 0) {
    return { sha: headSha, skippedFiles: [] };
  }

  const skippedFiles = await skippedSnapshotFiles(worktreePath, statusEntries);

  const indexDir = await mkdtemp(join(tmpdir(), 'muxbase-review-index-'));
  const env = { GIT_INDEX_FILE: join(indexDir, 'index') };
  try {
    // Seed the temp index from HEAD so files that are tracked but now match
    // .gitignore are retained — `git add -A` against an empty index would drop
    // them and the snapshot would show a phantom deletion.
    await gitOrThrow(worktreePath, ['read-tree', HEAD_REF], { env });

    // Use add -A to capture all changes (including staged new files), then restore
    // skipped paths to HEAD in the temp index without touching the working tree.
    // The pathspec list is passed to one reset: without any path it would restore
    // the whole index.
    await gitOrThrow(worktreePath, ['add', '-A'], { env });
    if (skippedFiles.length > 0) {
      await gitOrThrow(worktreePath, ['reset', '-q', HEAD_REF, PATHSPEC_SEPARATOR, ...skippedFiles], { env });
    }

    const tree = (await gitOrThrow(worktreePath, ['write-tree'], { env })).trim();
    const snapshot = (await gitOrThrow(
      worktreePath,
      ['commit-tree', tree, '-p', headSha, '-m', REVIEW_SNAPSHOT_MESSAGE],
      { env },
    )).trim();
    if (!tree || !snapshot) {
      throw new Error('Failed to create review snapshot: empty tree or commit');
    }
    return { sha: snapshot, skippedFiles };
  } finally {
    await rm(indexDir, { recursive: true, force: true });
  }
}
