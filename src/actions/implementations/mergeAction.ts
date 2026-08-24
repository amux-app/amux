/**
 * MERGE Action - Merge a worktree into the main branch with comprehensive pre-checks
 *
 * This is the simplified orchestrator that delegates to specialized modules.
 * Supports multi-merge: detects sub-worktrees and merges them all sequentially.
 */

import type { AumxPane } from '../../types.js';
import type { ActionResult, ActionContext } from '../types.js';
import type { MergeIssue, MergeValidationResult } from '../../utils/mergeValidation.js';
import { triggerHook } from '../../utils/hooks.js';
import { getPaneBranchName } from '../../utils/git.js';
import { executeMerge } from '../merge/mergeExecution.js';
import { LogService } from '../../services/LogService.js';
import { detectAllWorktrees } from '../../utils/worktreeDiscovery.js';
import { buildMergeQueue, executeMultiMerge } from '../merge/multiMergeOrchestrator.js';
import { validateMerge } from '../../utils/mergeValidation.js';
import { getPaneProjectRoot } from '../../utils/paneProject.js';
import {
  abortConflictMergeTransaction,
  getConflictMergeTransaction,
  inspectConflictMergeState,
} from '../../utils/conflictMergeTransaction.js';
import { abortMerge } from '../../utils/gitMergeOps.js';
import {
  handleNothingToMerge,
  handleMainDirty,
  handleWorktreeUncommitted,
  handleMergeConflict,
} from '../merge/issueHandlers/index.js';

/**
 * Merge a worktree into the main branch with comprehensive pre-checks.
 * Supports multi-merge: if sub-worktrees exist, merges all of them sequentially.
 */
export async function mergePane(
  pane: AumxPane,
  context: ActionContext,
  _params?: { mainBranch?: string }
): Promise<ActionResult> {
  // 1. Validation
  if (!pane.worktreePath) {
    return {
      type: 'error',
      message: 'This pane has no worktree to merge',
      dismissable: true,
    };
  }

  if (pane.role === 'review') {
    return {
      type: 'error',
      message: 'Review panes cannot be merged. They review a snapshot of another pane.',
      dismissable: true,
    };
  }

  const mergeState = await inspectConflictMergeState(pane.worktreePath);
  if (mergeState.status === 'conflicted' || mergeState.mergeHead || mergeState.unmergedFiles.length > 0) {
    const transaction = getConflictMergeTransaction(pane.worktreePath);
    return {
      type: 'choice',
      title: 'Merge Recovery Required',
      message: `An unresolved merge is already active in ${pane.slug}:\n${mergeState.unmergedFiles.join('\n')}`,
      options: [
        {
          id: 'resume',
          label: 'Resume resolution',
          description: 'Open the owning pane and continue resolving conflicts',
          default: true,
        },
        {
          id: 'abort',
          label: 'Abort merge',
          description: 'Restore a clean worktree before continuing',
          danger: true,
        },
      ],
      onSelect: async (optionId: string) => {
        if (optionId === 'resume') {
          return {
            type: 'navigation',
            title: 'Resume Conflict Resolution',
            message: 'Resolve the listed conflicts, commit the merge, then retry the merge action.',
            targetPaneId: transaction?.conflictPaneId || pane.id,
            dismissable: true,
          };
        }
        if (optionId === 'abort') {
          const result = transaction
            ? await abortConflictMergeTransaction(transaction)
            : await abortMerge(pane.worktreePath!);
          return result.success
            ? { type: 'info', message: 'Merge aborted and worktree restored', dismissable: true }
            : { type: 'error', message: `Unable to abort merge: ${result.error}`, dismissable: true };
        }
        return { type: 'info', message: 'Unknown recovery option', dismissable: true };
      },
      dismissable: false,
    };
  }

  const worktrees = await detectAllWorktrees(pane.worktreePath);
  const log = LogService.getInstance();

  log.debug(`[mergeAction] Detected ${worktrees.length} worktree(s) in ${pane.worktreePath}`, 'mergeAction');
  for (const wt of worktrees) {
    log.debug(
      `[mergeAction]   - ${wt.repoName} (${wt.branch}) at ${wt.relativePath} [depth=${wt.depth}, isRoot=${wt.isRoot}]`,
      'mergeAction',
    );
  }

  const queue = await buildMergeQueue(worktrees);

  log.debug(`[mergeAction] Merge queue has ${queue.length} item(s)`, 'mergeAction');

  // 4. Handle based on queue size
  // No changes anywhere
  if (queue.length === 0) {
    return {
      type: 'info',
      message: 'No changes to merge in any repository',
      dismissable: true,
    };
  }

  // Single root worktree = use existing flow (backwards compatible)
  if (queue.length === 1 && queue[0].worktree.isRoot) {
    log.debug('[mergeAction] Single root worktree - using existing flow', 'mergeAction');
    return executeSingleRootMerge(pane, context, pane.worktreePath);
  }

  // Multiple worktrees or only sub-worktrees = use multi-merge flow
  log.debug('[mergeAction] Multiple worktrees or sub-worktrees - using multi-merge flow', 'mergeAction');
  return executeMultiMerge(pane, context, queue);
}

/**
 * Execute single root worktree merge (original flow, backwards compatible)
 */
async function executeSingleRootMerge(
  pane: AumxPane,
  context: ActionContext,
  worktreePath: string
): Promise<ActionResult> {
  const mainRepoPath = getPaneProjectRoot(pane, worktreePath);
  const validation = await validateMerge(mainRepoPath, worktreePath, getPaneBranchName(pane));

  // Handle detected issues
  if (!validation.canMerge) {
    return handleMergeIssues(pane, context, validation, mainRepoPath);
  }

  // No issues detected, proceed with merge confirmation
  return {
    type: 'confirm',
    title: 'Merge Worktree',
    message: `Merge "${pane.slug}" into ${validation.mainBranch}?`,
    confirmLabel: 'Merge',
    cancelLabel: 'Cancel',
    onConfirm: async () => {
      // Trigger pre_merge hook before starting merge
      await triggerHook('pre_merge', mainRepoPath, pane, {
        AUMX_TARGET_BRANCH: validation.mainBranch,
      });
      return executeMerge(pane, context, validation.mainBranch, mainRepoPath);
    },
    onCancel: async () => {
      return {
        type: 'info',
        message: 'Merge cancelled',
        dismissable: true,
      };
    },
  };
}

/**
 * Handle detected merge issues by delegating to specialized handlers
 */
async function handleMergeIssues(
  pane: AumxPane,
  context: ActionContext,
  validation: MergeValidationResult,
  mainRepoPath: string
): Promise<ActionResult> {
  const { issues, mainBranch } = validation;

  // Create retry function that re-runs the merge
  const retryMerge = () => mergePane(pane, context, { mainBranch });

  // Find and handle specific issue types
  const nothingToMerge = issues.find((i: MergeIssue) => i.type === 'nothing_to_merge');
  if (nothingToMerge) {
    return handleNothingToMerge();
  }

  const mainDirty = issues.find((i: MergeIssue) => i.type === 'main_dirty');
  if (mainDirty) {
    return handleMainDirty(
      {
        type: 'main_dirty',
        message: mainDirty.message,
        files: mainDirty.files ?? [],
      },
      mainBranch,
      mainRepoPath,
      pane,
      context,
      retryMerge,
    );
  }

  const worktreeUncommitted = issues.find((i: MergeIssue) => i.type === 'worktree_uncommitted');
  if (worktreeUncommitted) {
    return handleWorktreeUncommitted(
      {
        type: 'worktree_uncommitted',
        message: worktreeUncommitted.message,
        files: worktreeUncommitted.files ?? [],
      },
      pane,
      context,
      retryMerge,
    );
  }

  const mergeConflict = issues.find((i: MergeIssue) => i.type === 'merge_conflict');
  if (mergeConflict) {
    return handleMergeConflict(
      {
        type: 'merge_conflict',
        message: mergeConflict.message,
        files: mergeConflict.files ?? [],
      },
      mainBranch,
      mainRepoPath,
      pane,
      context,
    );
  }

  // Generic fallback for unknown issues
  return {
    type: 'error',
    title: 'Merge Issues Detected',
    message: issues.map((i: MergeIssue) => i.message).join('\n'),
    dismissable: true,
  };
}
