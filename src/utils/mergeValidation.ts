/**
 * Merge Validation Utilities
 *
 * Provides comprehensive pre-merge validation to detect issues before attempting merge
 */

import { LogService } from '../services/LogService.js';
import { execAsyncWithStatus, execFileAsync } from './execAsync.js';
import { getCurrentBranchAsync } from './git.js';
import { shQuote } from './shellEscape.js';

const AUMX_METADATA_PATHS = ['.amux', '.amux-hooks', '.aumx', '.aumx-hooks'];
const GIT_COMMIT_TIMEOUT_MS = 5 * 60 * 1000;

export interface MergeValidationResult {
  canMerge: boolean;
  issues: MergeIssue[];
  mainBranch: string;
  worktreeBranch: string;
  conflictPrediction?: MergeConflictPrediction;
}

type MergeConflictPrediction = 'clean' | 'conflicted' | 'unknown';

export interface MergeConflictPredictionResult {
  prediction: MergeConflictPrediction;
  conflictFiles: string[];
}

export interface MergeIssue {
  type: 'main_dirty' | 'worktree_uncommitted' | 'merge_conflict' | 'nothing_to_merge';
  message: string;
  files?: string[];
  canAutoResolve: boolean;
}

export interface GitStatus {
  hasChanges: boolean;
  files: string[];
  summary: string;
}

function runGit(repoPath: string, args: string[]): Promise<string> {
  return execFileAsync('git', args, { cwd: repoPath });
}

function getGitErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const execError = error as Error & { stderr?: Buffer | string };
    if (execError.stderr) {
      const stderr = typeof execError.stderr === 'string'
        ? execError.stderr
        : execError.stderr.toString();
      if (stderr.trim()) {
        return stderr.trim();
      }
    }
    return error.message;
  }
  return String(error);
}

function parseGitStatusPath(line: string): string {
  const trimmed = line.trimStart();
  const spaceIndex = trimmed.indexOf(' ');
  return spaceIndex >= 0 ? trimmed.slice(spaceIndex + 1).trim() : trimmed;
}

function isAumxMetadataPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').replace(/^"|"$/g, '');
  return AUMX_METADATA_PATHS.some((metadataPath) => (
    normalized === metadataPath
    || normalized === `${metadataPath}/`
    || normalized.startsWith(`${metadataPath}/`)
  ));
}

function isAumxMetadataStatusPath(filePath: string): boolean {
  return filePath
    .split(' -> ')
    .every((statusPath) => isAumxMetadataPath(statusPath));
}

/**
 * Get git status for a repository
 */
export async function getGitStatus(repoPath: string): Promise<GitStatus> {
  LogService.getInstance().info(`Getting git status for: ${repoPath}`, 'mergeValidation');
  const statusOutput = await runGit(repoPath, ['status', '--porcelain']);

  const files = statusOutput
    .trim()
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      const filename = parseGitStatusPath(line);
      LogService.getInstance().info(`Git status: "${line}" → "${filename}"`, 'mergeValidation');
      return filename;
    })
    .filter((filename) => !isAumxMetadataStatusPath(filename));

  LogService.getInstance().info(`Final files for ${repoPath}: ${JSON.stringify(files)}`, 'mergeValidation');

  return {
    hasChanges: files.length > 0,
    files,
    summary: statusOutput.trim(),
  };
}

/**
 * Get current branch name
 */
/**
 * Check if there are any commits to merge
 */
async function hasCommitsToMerge(
  repoPath: string,
  fromBranch: string,
  toBranch: string,
): Promise<boolean> {
  try {
    const output = await runGit(repoPath, ['log', `${toBranch}..${fromBranch}`, '--oneline']);
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Detect potential merge conflicts without actually merging
 */
export async function predictMergeConflicts(
  repoPath: string,
  sourceBranch: string,
  targetBranch: string
): Promise<MergeConflictPredictionResult> {
  const result = await execAsyncWithStatus(
    `git merge-tree --write-tree --no-messages --name-only -- ${shQuote(targetBranch)} ${shQuote(sourceBranch)}`,
    { cwd: repoPath, timeout: 30000 },
  );
  if (result.exitCode === 0) return { prediction: 'clean', conflictFiles: [] };
  if (result.exitCode !== 1) return { prediction: 'unknown', conflictFiles: [] };

  const conflictFiles = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(line));
  return conflictFiles.length > 0
    ? { prediction: 'conflicted', conflictFiles }
    : { prediction: 'unknown', conflictFiles: [] };
}

/**
 * Comprehensive pre-merge validation
 */
export async function validateMerge(
  mainRepoPath: string,
  worktreePath: string,
  worktreeBranch: string
): Promise<MergeValidationResult> {
  const issues: MergeIssue[] = [];

  // Get current main branch
  const mainBranch = await getCurrentBranchAsync(mainRepoPath);

  // Check if main branch is clean
  const mainStatus = await getGitStatus(mainRepoPath);
  if (mainStatus.hasChanges) {
    issues.push({
      type: 'main_dirty',
      message: `Main branch (${mainBranch}) has uncommitted changes`,
      files: mainStatus.files,
      canAutoResolve: true, // Can offer to commit or stash
    });
  }

  // Check if worktree has uncommitted changes
  const worktreeStatus = await getGitStatus(worktreePath);
  LogService.getInstance().info(
    `Worktree status: hasChanges=${worktreeStatus.hasChanges}, files=${JSON.stringify(worktreeStatus.files)}`,
    'mergeValidation'
  );
  if (worktreeStatus.hasChanges) {
    issues.push({
      type: 'worktree_uncommitted',
      message: `Worktree has uncommitted changes`,
      files: worktreeStatus.files,
      canAutoResolve: true, // Can offer to commit with AI message
    });
  }

  // Check if there's anything to merge (commits OR uncommitted changes)
  const hasCommits = await hasCommitsToMerge(mainRepoPath, worktreeBranch, mainBranch);
  LogService.getInstance().info(
    `Merge check: hasCommits=${hasCommits}, worktreeHasChanges=${worktreeStatus.hasChanges}`,
    'mergeValidation'
  );
  if (!hasCommits && !worktreeStatus.hasChanges) {
    LogService.getInstance().info('Adding nothing_to_merge issue', 'mergeValidation');
    issues.push({
      type: 'nothing_to_merge',
      message: 'No new commits to merge',
      canAutoResolve: false,
    });
  }

  // Detect potential merge conflicts
  const conflictPrediction = await predictMergeConflicts(
    mainRepoPath,
    worktreeBranch,
    mainBranch
  );

  if (conflictPrediction.prediction === 'conflicted') {
    issues.push({
      type: 'merge_conflict',
      message: 'Merge conflicts detected',
      files: conflictPrediction.conflictFiles,
      canAutoResolve: true, // Can offer AI-assisted merge
    });
  }

  return {
    canMerge: issues.length === 0,
    issues,
    mainBranch,
    worktreeBranch,
    conflictPrediction: conflictPrediction.prediction,
  };
}

/**
 * Stage all uncommitted changes
 */
export async function stageAllChanges(
  repoPath: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    LogService.getInstance().info(`Staging all changes in: ${repoPath}`, 'stageAllChanges');

    await runGit(repoPath, ['add', '-A']);

    // Check if anything was actually staged
    try {
      await runGit(repoPath, ['diff', '--cached', '--quiet']);
      // If this succeeds, nothing is staged
      LogService.getInstance().warn(`No changes were staged in: ${repoPath}`, 'stageAllChanges');
    } catch {
      // Good - there are staged changes
      LogService.getInstance().info(`Changes staged successfully in: ${repoPath}`, 'stageAllChanges');
    }

    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    LogService.getInstance().error(`Failed to stage changes in ${repoPath}: ${errorMsg}`, 'stageAllChanges');
    return {
      success: false,
      error: errorMsg,
    };
  }
}

/**
 * Commit staged changes with a message
 */
export async function commitChanges(
  repoPath: string,
  message: string
): Promise<{ success: boolean; error?: string }> {
  try {
    LogService.getInstance().info(`Committing changes in: ${repoPath}`, 'commitChanges');
    LogService.getInstance().info(`Commit message: ${message}`, 'commitChanges');
    await execFileAsync('git', ['commit', '-m', message], {
      cwd: repoPath,
      timeout: GIT_COMMIT_TIMEOUT_MS,
    });

    LogService.getInstance().info(`Commit successful in: ${repoPath}`, 'commitChanges');
    return { success: true };
  } catch (error: unknown) {
    const errorMessage = getGitErrorMessage(error);
    LogService.getInstance().error(`Commit failed in ${repoPath}: ${errorMessage}`, 'commitChanges');
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Stash uncommitted changes
 */
export async function stashChanges(repoPath: string): Promise<{ success: boolean; error?: string }> {
  try {
    await runGit(repoPath, ['stash', 'push', '-u', '-m', 'aumx: auto-stash before merge']);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
