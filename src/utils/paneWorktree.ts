import * as fs from 'fs';
import type { MuxBasePane } from '../types.js';
import { LogService } from '../services/LogService.js';
import { execFileAsync } from './execAsync.js';
import { isValidBranchName } from './git.js';
import { buildGitRefVerifyArgs, buildGitWorktreeAddArgs } from './paneCreationGit.js';
import { SettingsManager } from './settingsManager.js';
import { getManagedWorktreePath } from './worktreePaths.js';

/**
 * Add a git worktree for a pane that didn't have one when it was created.
 *
 * **Runs git directly from Node (not via the pane's shell).** An earlier
 * version sent `git worktree add` as a shell command into the tmux pane and
 * polled the filesystem for the worktree directory. That broke as soon as the
 * pane was running an agent (Claude / Codex / OpenCode): the command got
 * typed into the agent's input box instead of executing, the poll loop timed
 * out after 5s, and the user saw a "Worktree not created at …" toast even
 * though the agent might subsequently run the command itself.
 *
 * Doing the git work from Node sidesteps the agent entirely. The pane's
 * existing terminal session is left alone — callers that want to chdir the
 * pane into the new worktree can do so after the fact.
 */
export async function createWorktreeForPane(
  pane: MuxBasePane,
  projectRoot: string,
): Promise<{ worktreePath: string; branchName: string } | null> {
  const log = LogService.getInstance();

  if (pane.worktreePath) {
    log.info('[createWorktreeForPane] Pane already has a worktree', 'paneCreation');
    return null;
  }

  const slug = pane.slug;
  const settingsManager = new SettingsManager(projectRoot);
  const settings = settingsManager.getSettings();

  const branchPrefix = settings.branchPrefix || '';
  const branchName = branchPrefix ? `${branchPrefix}${slug}` : slug;
  const worktreePath = getManagedWorktreePath(projectRoot, slug);

  if (!isValidBranchName(branchName)) {
    throw new Error(`Invalid branch name "${branchName}" — pane slug contains characters git won't accept.`);
  }

  // Prune stale worktree records first; this is a no-op when there's
  // nothing dangling and harmless when there is.
  try {
    await execFileAsync('git', ['worktree', 'prune'], { cwd: projectRoot });
  } catch {
    // Ignore — prune failures shouldn't block the add.
  }

  // Pre-flight: does the branch already exist? If so, attach to it instead
  // of trying to create a fresh branch with the same name.
  let branchExists = false;
  try {
    await execFileAsync(
      'git',
      ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
      { cwd: projectRoot },
    );
    branchExists = true;
  } catch {
    // Branch doesn't exist; we'll create it.
  }

  const baseBranch = settings.baseBranch || '';
  if (baseBranch) {
    if (!isValidBranchName(baseBranch)) {
      throw new Error(`Invalid base branch name "${baseBranch}".`);
    }
    try {
      await execFileAsync('git', buildGitRefVerifyArgs(baseBranch), { cwd: projectRoot });
    } catch {
      throw new Error(`Base branch "${baseBranch}" does not exist. Update the baseBranch setting to a valid branch name.`);
    }
  }

  // Refuse to overwrite an existing directory at the target path — `git
  // worktree add` would error too, but the error from us is clearer than
  // git's "already exists" message and avoids leaking shell-quoted paths
  // into the toast.
  if (fs.existsSync(worktreePath)) {
    throw new Error(`A directory already exists at ${worktreePath}. Remove it or pick a different slug.`);
  }

  const worktreeAddArgs = buildGitWorktreeAddArgs({
    branchName,
    createBranch: !branchExists,
    startPoint: baseBranch || undefined,
    worktreePath,
  });

  log.info(`[createWorktreeForPane] running: ${JSON.stringify(['git', ...worktreeAddArgs])}`, 'paneCreation');

  try {
    await execFileAsync('git', worktreeAddArgs, { cwd: projectRoot, timeout: 60000 });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error(`[createWorktreeForPane] git worktree add failed: ${errorMsg}`, 'paneCreation');
    throw new Error(`Failed to create worktree: ${errorMsg}`);
  }

  if (!fs.existsSync(worktreePath)) {
    // execAsync didn't throw but the directory still isn't there — very rare,
    // usually a permissions issue. Surface it explicitly.
    throw new Error(`git reported success but worktree directory is missing at ${worktreePath}.`);
  }

  log.info(`[createWorktreeForPane] worktree created at ${worktreePath}`, 'paneCreation');
  return { worktreePath, branchName: branchName !== slug ? branchName : slug };
}
