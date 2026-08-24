import type { Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { statFingerprint } from '../statFingerprint.js';

export interface WorkingSignature {
  signature: string;
  /** Stats already taken per changed path, so readers do not stat them again. */
  stats: Map<string, Stats>;
}

const DOT_GIT = '.git';
const GITDIR_PREFIX = 'gitdir: ';
const HEAD_FILE = 'HEAD';
const PACKED_REFS_FILE = 'packed-refs';
const SYMREF_PREFIX = 'ref: ';
const SEPARATOR = '\0';

/**
 * Identifies the commit the working tree is compared against, using file stats
 * only. Covers commits, amends, resets and branch switches without spending a
 * git process. The index is deliberately excluded: `git status` and `git diff`
 * rewrite it as a side effect, and every index-only change (staging, unstaging)
 * already alters porcelain status output.
 */
export async function readHeadSignature(gitDir: string, gitCommonDir: string): Promise<string> {
  const head = (await readFile(join(gitDir, HEAD_FILE), 'utf8').catch(() => '')).trim();
  const refTarget = head.startsWith(SYMREF_PREFIX) ? head.slice(SYMREF_PREFIX.length).trim() : '';

  const [looseRefSig, packedRefsSig] = await Promise.all([
    refTarget ? fileSignature(join(gitCommonDir, refTarget)) : '',
    refTarget ? fileSignature(join(gitCommonDir, PACKED_REFS_FILE)) : '',
  ]);

  return [head, looseRefSig, packedRefsSig].join(SEPARATOR);
}

/**
 * Identifies the content of every path git reported as changed. Editing a file
 * without adding or removing entries leaves `git status` output identical, so
 * the diff cache needs a per-path content identity to stay exact. It is the same
 * fingerprint the untracked reader memoizes on, so both layers invalidate on the
 * same edit rather than one masking the other.
 */
export async function readWorkingSignature(
  worktreePath: string,
  paths: readonly string[],
): Promise<WorkingSignature> {
  const stats = new Map<string, Stats>();
  const signatures = await Promise.all(
    paths.map((path) => pathSignature(worktreePath, path, stats)),
  );
  return { signature: signatures.join(SEPARATOR), stats };
}

async function pathSignature(worktreePath: string, path: string, stats: Map<string, Stats>): Promise<string> {
  const fullPath = resolve(worktreePath, path);
  const info = await stat(fullPath).catch(() => null);
  if (!info) return '';
  stats.set(path, info);
  return info.isDirectory() ? submoduleSignature(fullPath) : statFingerprint(info);
}

/**
 * A submodule is the only directory `git status` reports as changed, and its
 * own commits move nothing the parent worktree can stat: the directory keeps
 * its mtime and status stays byte-identical while the recorded commit changes.
 * Its HEAD is therefore part of the parent's working signature.
 */
async function submoduleSignature(submodulePath: string): Promise<string> {
  const gitDir = await resolveSubmoduleGitDir(submodulePath);
  return gitDir ? readHeadSignature(gitDir, gitDir) : '';
}

async function resolveSubmoduleGitDir(submodulePath: string): Promise<string> {
  const dotGit = join(submodulePath, DOT_GIT);
  const info = await stat(dotGit).catch(() => null);
  if (!info) return '';
  if (info.isDirectory()) return dotGit;

  const pointer = (await readFile(dotGit, 'utf8').catch(() => '')).trim();
  return pointer.startsWith(GITDIR_PREFIX)
    ? resolve(submodulePath, pointer.slice(GITDIR_PREFIX.length).trim())
    : '';
}

/**
 * Refs deliberately stay on size and mtime rather than the working-tree
 * fingerprint. Git never rewrites a ref in place: every update is written to a
 * lock file and renamed over the target, so a content change always lands on a
 * new inode whose mtime is that write. Change time therefore distinguishes
 * nothing extra here, while a metadata-only touch inside the git directory would
 * read as a moved HEAD and force a full context and metadata recollection.
 */
async function fileSignature(path: string): Promise<string> {
  const info = await stat(path).catch(() => null);
  return info ? `${info.size}:${info.mtimeMs}` : '';
}
