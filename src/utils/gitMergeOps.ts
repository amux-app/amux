/**
 * Merge Execution Utilities
 *
 * Handles the actual merge operations with proper error handling
 */

import { execFileAsync } from './execAsync.js';
import {
  findConflictMergeTransactionForMerge,
  inspectConflictMergeState,
} from './conflictMergeTransaction.js';
import { cleanupPromptFilesForSlug } from './promptStore.js';

const GIT_WRITE_TIMEOUT_MS = 5 * 60 * 1000;

export interface MergeResult {
  success: boolean;
  error?: string;
  conflictFiles?: string[];
  needsManualResolution?: boolean;
  status?: 'clean' | 'conflicted' | 'failed';
}

/**
 * Merge main branch into worktree branch
 * This is step 1 of the two-phase merge: get latest changes from main
 */
export async function mergeMainIntoWorktree(
  worktreePath: string,
  mainBranch: string
): Promise<MergeResult> {
  try {
    await execFileAsync('git', ['merge', mainBranch, '--no-edit'], {
      cwd: worktreePath,
      timeout: GIT_WRITE_TIMEOUT_MS,
    });

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    const state = await inspectConflictMergeState(worktreePath);
    if (state.status === 'conflicted') {
      const abortResult = await abortMerge(worktreePath);
      const cleanState = await inspectConflictMergeState(worktreePath);
      if (!abortResult.success || cleanState.status !== 'clean') {
        return {
          success: false,
          status: 'failed',
          error: `Merge conflict detected, but abort failed: ${abortResult.error || cleanState.error || 'repository is not clean'}`,
        };
      }
      return {
        success: false,
        status: 'conflicted',
        error: 'Merge conflicts detected',
        conflictFiles: state.unmergedFiles,
        needsManualResolution: true,
      };
    }

    if (state.status === 'failed' && await isInMergeState(worktreePath)) {
      await abortMerge(worktreePath);
    }

    return {
      success: false,
      status: 'failed',
      error: errorMessage,
    };
  }
}

/**
 * Merge worktree branch into main (should be clean after resolving conflicts)
 * This is step 2 of the two-phase merge: bring changes back to main
 */
export async function mergeWorktreeIntoMain(
  mainRepoPath: string,
  worktreeBranch: string
): Promise<MergeResult> {
  const activeTransaction = findConflictMergeTransactionForMerge(mainRepoPath, worktreeBranch);
  if (activeTransaction && activeTransaction.state !== 'resolved') {
    return {
      success: false,
      status: 'failed',
      error: 'A conflict merge transaction is still active; resolve or abort it before merging',
    };
  }

  try {
    await execFileAsync('git', ['merge', worktreeBranch, '--no-edit'], {
      cwd: mainRepoPath,
      timeout: GIT_WRITE_TIMEOUT_MS,
    });

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // This shouldn't have conflicts if we properly merged main into worktree first
    const state = await inspectConflictMergeState(mainRepoPath);
    if (state.status === 'conflicted') {
      const conflictFiles = state.unmergedFiles;
      await abortMerge(mainRepoPath);

      return {
        success: false,
        status: 'conflicted',
        error: 'Unexpected merge conflicts in main',
        conflictFiles,
        needsManualResolution: true,
      };
    }

    if (state.status === 'failed' && await isInMergeState(mainRepoPath)) {
      await abortMerge(mainRepoPath);
    }

    return {
      success: false,
      status: 'failed',
      error: errorMessage,
    };
  }
}

/**
 * Get list of files with merge conflicts
 */
async function getConflictingFiles(repoPath: string): Promise<string[]> {
  try {
    const output = await execFileAsync(
      'git',
      ['diff', '--name-only', '--diff-filter=U'],
      { cwd: repoPath },
    );

    return output
      .trim()
      .split('\n')
      .filter(line => line.trim());
  } catch {
    return [];
  }
}

/**
 * Abort an in-progress merge
 */
export async function abortMerge(repoPath: string): Promise<{ success: boolean; error?: string }> {
  try {
    await execFileAsync('git', ['merge', '--abort'], { cwd: repoPath });
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check if repository is in a merge state
 */
async function isInMergeState(repoPath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

/**
 * Complete a merge after conflicts are resolved
 */
export async function completeMerge(repoPath: string, message?: string): Promise<MergeResult> {
  try {
    // Check if all conflicts are resolved
    const conflictFiles = await getConflictingFiles(repoPath);
    if (conflictFiles.length > 0) {
      return {
        success: false,
        status: 'conflicted',
        error: 'Not all conflicts have been resolved',
        conflictFiles,
        needsManualResolution: true,
      };
    }

    // Complete the merge
    const commitMsg = message || 'Merge branch with resolved conflicts';
    await execFileAsync('git', ['commit', '-m', commitMsg], {
      cwd: repoPath,
      timeout: GIT_WRITE_TIMEOUT_MS,
    });

    return { success: true };
  } catch (error) {
    return {
      success: false,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Clean up worktree and branch after successful merge
 */
export async function cleanupAfterMerge(
  mainRepoPath: string,
  worktreePath: string,
  branchName: string
): Promise<{ success: boolean; error?: string }> {
  const activeTransaction = findConflictMergeTransactionForMerge(mainRepoPath, branchName);
  if (activeTransaction) {
    return {
      success: false,
      error: 'Cannot clean up a worktree while its conflict merge transaction is active',
    };
  }

  try {
    // Remove worktree
    await execFileAsync('git', ['worktree', 'remove', worktreePath, '--force'], {
      cwd: mainRepoPath,
    });

    // Delete branch (use -d for safety, it will fail if not merged)
    await execFileAsync('git', ['branch', '-d', branchName], { cwd: mainRepoPath });

    // Best-effort cleanup for any prompt artifacts associated with this branch.
    await cleanupPromptFilesForSlug(mainRepoPath, branchName);

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
