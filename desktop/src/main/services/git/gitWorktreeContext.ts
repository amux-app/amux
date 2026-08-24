import { realpath } from 'node:fs/promises';
import { BoundedCache } from '../boundedCache.js';
import { HEAD_REF, REV_PARSE } from './gitArgs.js';
import { git } from './gitCommand.js';

export interface WorktreeContext {
  branch: string;
  detachedHead: boolean;
  gitCommonDir: string;
  gitDir: string;
  gitRoot: string;
  hasHeadCommit: boolean;
  isWorktree: boolean;
}

const LAYOUT_ARGS = [
  REV_PARSE,
  '--path-format=absolute',
  '--show-toplevel',
  '--git-dir',
  '--git-common-dir',
] as const;
// `HEAD` first makes the whole invocation fail on an unborn branch, which is the
// signal used to fall back to the layout-only form.
const CONTEXT_ARGS = [
  REV_PARSE,
  HEAD_REF,
  '--path-format=absolute',
  '--show-toplevel',
  '--git-dir',
  '--git-common-dir',
  '--path-format=relative',
  '--abbrev-ref',
  HEAD_REF,
] as const;
const LAYOUT_LINES = 3;
const CONTEXT_LINES = 5;

// Two short strings per entry, so the bound only has to cover the paths in
// active rotation; a miss costs a single realpath call.
const MAX_CANONICAL_PATHS = 256;

const canonicalPaths = new BoundedCache<string>(MAX_CANONICAL_PATHS);

/**
 * Worktrees of the same repository share a common git dir but have distinct
 * working trees, so every cache in this layer keys on the resolved working tree
 * path — never on the repository root.
 */
export async function canonicalWorktreePath(worktreePath: string): Promise<string> {
  const cached = canonicalPaths.get(worktreePath);
  if (cached) return cached;
  const resolved = await realpath(worktreePath).catch(() => worktreePath);
  canonicalPaths.set(worktreePath, resolved);
  return resolved;
}

/**
 * Drops the memoized resolution and reports the key the other caches use, so a
 * pane that closes can release its entries without a realpath on a path that
 * may already be gone.
 */
export function releaseWorktreePath(worktreePath: string): string {
  return canonicalPaths.take(worktreePath) ?? worktreePath;
}

export async function readWorktreeContext(worktreePath: string): Promise<WorktreeContext | null> {
  const full = splitLines(await git(worktreePath, CONTEXT_ARGS));
  if (full.length >= CONTEXT_LINES) {
    return buildContext(full.slice(1, LAYOUT_LINES + 1), full[LAYOUT_LINES + 1], true);
  }

  const layout = splitLines(await git(worktreePath, LAYOUT_ARGS));
  if (layout.length < LAYOUT_LINES) return null;
  return buildContext(layout, '', false);
}

function buildContext(layout: string[], branchRaw: string, hasHeadCommit: boolean): WorktreeContext {
  const [gitRoot, gitDir, gitCommonDir] = layout;
  const branch = branchRaw.trim();

  return {
    branch,
    detachedHead: branch === HEAD_REF,
    gitCommonDir,
    gitDir,
    gitRoot,
    hasHeadCommit,
    isWorktree: gitDir !== gitCommonDir,
  };
}

function splitLines(output: string): string[] {
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

export const __test__ = {
  resetCanonicalPaths: () => canonicalPaths.clear(),
};
