import { isValidBranchName, SettingsManager } from 'aumx/core';
import { HEAD_REF, REV_PARSE } from './gitArgs.js';
import { safeGit } from './gitCommand.js';

function projectRootFromCommonDir(gitCommonDir: string): string {
  const commonDir = gitCommonDir.trim();
  return commonDir.endsWith('.git') ? commonDir.slice(0, -5) : commonDir;
}

async function deriveProjectRoot(worktreePath: string): Promise<string | null> {
  const gitCommonDir = await safeGit(worktreePath, [REV_PARSE, '--path-format=absolute', '--git-common-dir']);
  if (!gitCommonDir) return null;
  return projectRootFromCommonDir(gitCommonDir);
}

function refExists(worktreePath: string, ref: string): Promise<string | null> {
  return safeGit(worktreePath, [REV_PARSE, '--verify', ref]);
}

/**
 * `gitCommonDir` lets callers that already resolved the repository layout skip
 * the extra `rev-parse --git-common-dir` process.
 */
export async function resolveBaseBranch(worktreePath: string, gitCommonDir?: string): Promise<string> {
  const projectRoot = gitCommonDir
    ? projectRootFromCommonDir(gitCommonDir)
    : await deriveProjectRoot(worktreePath);
  if (projectRoot) {
    const settings = SettingsManager.getInstance(projectRoot).getSettings();
    if (settings.baseBranch && isValidBranchName(settings.baseBranch)) {
      return settings.baseBranch;
    }
  }
  const originHead = await safeGit(worktreePath, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (originHead) {
    const branch = originHead.trim().replace('refs/remotes/origin/', '');
    if (branch && isValidBranchName(branch)) return branch;
  }
  const mainExists = await refExists(worktreePath, 'refs/heads/main');
  if (mainExists) return 'main';
  const masterExists = await refExists(worktreePath, 'refs/heads/master');
  if (masterExists) return 'master';
  const currentBranch = await safeGit(worktreePath, [REV_PARSE, '--abbrev-ref', HEAD_REF]);
  if (currentBranch && currentBranch.trim() !== HEAD_REF) return currentBranch.trim();
  return 'main';
}

async function countCommitsAhead(worktreePath: string, ref: string): Promise<number | null> {
  const raw = await safeGit(worktreePath, ['rev-list', '--count', `${ref}..${HEAD_REF}`]);
  const parsed = parseInt((raw ?? '').trim(), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export async function getCommitsAhead(worktreePath: string, baseBranch: string): Promise<number | null> {
  if (!isValidBranchName(baseBranch)) return null;
  // Prefer origin/<baseBranch> over the local ref so the count stays accurate when
  // the local base branch is stale (a common case when the user only works in worktrees).
  // A missing remote ref makes rev-list fail, which is the same signal a separate
  // existence probe would have produced, without spending a second process.
  const fromRemote = await countCommitsAhead(worktreePath, `origin/${baseBranch}`);
  return fromRemote ?? await countCommitsAhead(worktreePath, baseBranch);
}

export function parseRecentCommits(raw: string | null): { sha: string; message: string }[] {
  if (!raw) return [];
  return raw.split('\x1e').filter(Boolean).map((record) => {
    const [sha, message] = record.trim().split('\x1f');
    return { sha: sha ?? '', message: message ?? '' };
  }).filter((c) => c.sha);
}
