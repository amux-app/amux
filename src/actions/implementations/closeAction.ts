/**
 * CLOSE Action - Close a pane with various cleanup options
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import type { AumxPane, AumxConfig } from '../../types.js';
import type { ActionResult, ActionContext, ActionOption } from '../types.js';
import { StateManager } from '../../shared/StateManager.js';
import { PaneLifecycleManager } from '../../services/PaneLifecycleManager.js';
import { triggerHook, triggerHookSync } from '../../utils/hooks.js';
import { LogService } from '../../services/LogService.js';
import { WorktreeCleanupService } from '../../services/WorktreeCleanupService.js';
import { TMUX_SPLIT_DELAY } from '../../constants/timing.js';
import { deriveProjectRootFromWorktreePath, getPaneProjectRoot } from '../../utils/paneProject.js';
import { cleanupPromptFilesForSlug } from '../../utils/promptStore.js';
import { deleteRegisteredSession } from '../../utils/claudeSessionRegistry.js';
import { getTerminalDimensions } from '../../utils/tmux.js';
import { abortMerge } from '../../utils/gitMergeOps.js';
import { handleLastPaneRemoved } from '../../utils/postPaneCleanup.js';
import { recalculateAndApplyLayout } from '../../utils/layoutManager.js';
import {
  abortConflictMergeTransaction,
  clearConflictMergeTransactionById,
  conflictMergeTransactionFromMetadata,
  findConflictMergeTransactionByPane,
  getConflictMergeTransaction,
  inspectConflictMergeState,
  registerConflictMergeTransaction,
} from '../../utils/conflictMergeTransaction.js';
import {
  disposeManagedConflictResolutionPane,
  hasManagedConflictPane,
  registerManagedConflictPane,
} from '../merge/conflictPaneOwnership.js';
import { getProjectConfigPath } from '../../utils/worktreePaths.js';

const TMUX_DEFAULT_TIMEOUT_MS = 5000;
const TMUX_INTERRUPT_TIMEOUT_MS = 2000;
const TMUX_CLOSE_VERIFY_DELAY_MS = 100;

function getTrackedPanes(pane: AumxPane, context: ActionContext): AumxPane[] {
  const stateManager = StateManager.getInstance();
  if (typeof stateManager.getPanes !== 'function') return context.panes;
  const statePanes = stateManager.getPanes();
  return statePanes.some((candidate) => candidate.id === pane.id) ? statePanes : context.panes;
}

function isWorktreeMissing(worktreePath: string): boolean {
  try {
    fs.statSync(worktreePath);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

function runTmux(args: string[], timeout = TMUX_DEFAULT_TIMEOUT_MS): string {
  const output = execFileSync('tmux', args, {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout,
  });
  return String(output);
}

function tmuxPaneExists(paneId: string): boolean {
  try {
    return runTmux(['display-message', '-p', '-t', paneId, '#{pane_id}']).trim() === paneId;
  } catch {
    LogService.getInstance().debug(`Could not verify pane ${paneId} exists, treating as already closed`, 'paneActions');
    return false;
  }
}

async function waitForTmux(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function closeTmuxPane(pane: AumxPane): Promise<void> {
  if (!tmuxPaneExists(pane.paneId)) {
    LogService.getInstance().debug(`Pane ${pane.paneId} already gone, skipping kill`, 'paneActions');
    return;
  }

  try {
    try {
      runTmux(['send-keys', '-t', pane.paneId, 'C-c'], TMUX_INTERRUPT_TIMEOUT_MS);
      await waitForTmux(TMUX_SPLIT_DELAY);
    } catch {
      LogService.getInstance().debug(`Pane ${pane.paneId} did not accept interrupt before close`, 'paneActions');
    }

    runTmux(['kill-pane', '-t', pane.paneId]);

    await waitForTmux(TMUX_CLOSE_VERIFY_DELAY_MS);
    if (tmuxPaneExists(pane.paneId)) {
      LogService.getInstance().warn(`Pane ${pane.paneId} still exists after kill attempt`, 'paneActions', pane.id);
    }
  } catch (killError) {
    const msg = `Error killing pane ${pane.paneId}`;
    LogService.getInstance().error(msg, 'paneActions', pane.id, killError instanceof Error ? killError : undefined);
  }
}

function getSessionPaneIds(sessionName: string): string[] {
  try {
    return runTmux(['list-panes', '-s', '-t', sessionName, '-F', '#{pane_id}'])
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

function recalculateLayoutAfterClose(
  panesFile: string,
  sessionName: string,
  updatedPanes: AumxPane[]
): void {
  try {
    const config: AumxConfig = JSON.parse(fs.readFileSync(panesFile, 'utf-8'));
    if (!config.controlPaneId || updatedPanes.length === 0) {
      return;
    }

    const currentPaneIds = getSessionPaneIds(sessionName);
    if (!currentPaneIds.includes(config.controlPaneId)) {
      LogService.getInstance().debug(
        `Control pane ${config.controlPaneId} no longer exists, skipping layout recalc`,
        'paneActions'
      );
      return;
    }

    const validPaneIds = updatedPanes
      .map(p => p.paneId)
      .filter(id => currentPaneIds.includes(id));

    if (validPaneIds.length === 0) {
      return;
    }

    const dimensions = getTerminalDimensions();
    recalculateAndApplyLayout(
      config.controlPaneId,
      validPaneIds,
      dimensions.width,
      dimensions.height
    );

    LogService.getInstance().debug(
      `Recalculated layout after closing pane: ${validPaneIds.length} panes remaining`,
      'paneActions'
    );
  } catch {
    LogService.getInstance().debug('Failed to recalculate layout after pane close', 'paneActions');
  }
}

/**
 * Close a pane - presents options for how to close
 */
export async function closePane(
  pane: AumxPane,
  context: ActionContext
): Promise<ActionResult> {
  const trackedPanes = getTrackedPanes(pane, context);
  const persistedMetadata = pane.conflictMerge
    || trackedPanes.find((candidate) => candidate.conflictMerge?.sourcePaneId === pane.id)?.conflictMerge;
  const persistedTransaction = persistedMetadata
    ? getConflictMergeTransaction(persistedMetadata.repoPath)
      || registerConflictMergeTransaction(conflictMergeTransactionFromMetadata(persistedMetadata))
    : undefined;
  const conflictTransaction = (pane.worktreePath && getConflictMergeTransaction(pane.worktreePath))
    || findConflictMergeTransactionByPane(pane.id)
    || persistedTransaction;
  if (conflictTransaction && !hasManagedConflictPane(conflictTransaction.id)) {
    const conflictPane = trackedPanes.find((candidate) => candidate.id === conflictTransaction.conflictPaneId);
    if (conflictPane) {
      registerManagedConflictPane(conflictTransaction, {
        context,
        creation: {
          pane: conflictPane,
          preparation: {
            repoPath: conflictTransaction.repoPath,
            sourceCommit: conflictTransaction.sourceCommit,
            targetCommit: conflictTransaction.targetCommit,
          },
        },
        stopMonitoring: () => undefined,
      });
    }
  }
  const activeConflictTransaction = conflictTransaction?.state === 'active' ? conflictTransaction : undefined;
  const mergeState = pane.worktreePath && !activeConflictTransaction
    ? await inspectConflictMergeState(pane.worktreePath)
    : undefined;
  const failedInspectionOfMissingWorktree = Boolean(
    pane.worktreePath
    && mergeState?.status === 'failed'
    && isWorktreeMissing(pane.worktreePath)
  );
  const strandedMerge = Boolean(mergeState && (
    mergeState.status === 'conflicted'
    || mergeState.mergeHead
    || mergeState.unmergedFiles.length > 0
    || (mergeState.status === 'failed' && !failedInspectionOfMissingWorktree)
  ));
  if (activeConflictTransaction || strandedMerge) {
    return {
      type: 'confirm',
      title: 'Merge Resolution In Progress',
      message: activeConflictTransaction
        ? 'This pane owns an active conflict merge. Abort the merge before closing it.'
        : 'This pane has an unresolved merge from an earlier session. Abort the merge before closing it.',
      confirmLabel: 'Abort merge and close',
      cancelLabel: 'Keep open',
      onConfirm: async () => {
        const repoPath = activeConflictTransaction?.repoPath || pane.worktreePath;
        const managedDisposal = activeConflictTransaction
          ? await disposeManagedConflictResolutionPane(activeConflictTransaction, true)
          : undefined;
        const abortResult = managedDisposal
          || (activeConflictTransaction
            ? await abortConflictMergeTransaction(activeConflictTransaction)
            : await abortMerge(pane.worktreePath!));
        if (managedDisposal && !managedDisposal.success) {
          return {
            type: 'error',
            message: `Cannot close while the merge is active: ${managedDisposal.error}`,
            dismissable: true,
          };
        }
        if (!abortResult.success) {
          return {
            type: 'error',
            message: `Cannot close while the merge is active: ${abortResult.error}`,
            dismissable: true,
          };
        }
        const cleanState = await inspectConflictMergeState(repoPath!);
        if (cleanState.status !== 'clean') {
          return {
            type: 'error',
            message: `Cannot close while the merge is active: ${cleanState.error || 'repository is not clean'}`,
            dismissable: true,
          };
        }
        return executeCloseOption(pane, context, 'kill_only');
      },
      onCancel: async () => ({
        type: 'info',
        message: 'Merge resolution remains active',
        dismissable: true,
      }),
    };
  }

  // For shell panes (no worktree), close immediately without options
  if (pane.type === 'shell' || !pane.worktreePath) {
    return executeCloseOption(pane, context, 'kill_only');
  }

  // Review panes are throwaway snapshots — never merged — so closing one removes
  // its worktree and the synthetic review branch automatically (no prompt).
  if (pane.role === 'review') {
    return executeCloseOption(pane, context, 'kill_clean_branch');
  }

  // For worktree panes, present options
  const options: ActionOption[] = [
    {
      id: 'kill_only',
      label: 'Just close pane',
      description: 'Keep worktree and branch',
      default: true,
    },
    {
      id: 'kill_and_clean',
      label: 'Close and remove worktree',
      description: 'Delete worktree but keep branch',
      danger: true,
    },
    {
      id: 'kill_clean_branch',
      label: 'Close and delete everything',
      description: 'Remove worktree and delete branch',
      danger: true,
    },
  ];

  return {
    type: 'choice',
    title: 'Close Pane',
    message: `How do you want to close "${pane.slug}"?`,
    options,
    onSelect: async (optionId: string) => {
      return executeCloseOption(pane, context, optionId);
    },
    dismissable: true,
  };
}

/**
 * Execute the selected close option
 */
async function executeCloseOption(
  pane: AumxPane,
  context: ActionContext,
  option: string
): Promise<ActionResult> {
  const lifecycleManager = PaneLifecycleManager.getInstance();
  const stateManager = StateManager.getInstance();
  const state = stateManager.getState();
  const sessionProjectRoot = state.projectRoot || process.cwd();
  const paneProjectRoot = getPaneProjectRoot(pane, sessionProjectRoot);
  const panesFile = state.panesFile || getProjectConfigPath(sessionProjectRoot);

  try {
    const resolvedConflictTransaction = findConflictMergeTransactionByPane(pane.id);
    if (resolvedConflictTransaction?.state === 'resolved') {
      const managedDisposal = await disposeManagedConflictResolutionPane(resolvedConflictTransaction, false);
      if (managedDisposal && !managedDisposal.success) {
        return {
          type: 'error',
          message: managedDisposal.error || 'Conflict pane cleanup failed',
          dismissable: true,
        };
      }
      clearConflictMergeTransactionById(resolvedConflictTransaction.id);
    }

    // CRITICAL: Mark pane as closing FIRST to prevent race condition with polling
    // This prevents usePanes from recreating the pane while we're closing it
    await lifecycleManager.beginClose(pane.id, `close action: ${option}`);
    // Also mark by paneId in case polling checks that
    await lifecycleManager.beginClose(pane.paneId, `close action: ${option}`);

    // Trigger before_pane_close hook
    await triggerHook('before_pane_close', paneProjectRoot, pane);

    // CRITICAL: Pause ConfigWatcher to prevent race condition where
    // the watcher reloads the pane list from disk before our save completes
    stateManager.pauseConfigWatcher();

    try {
      let startedBackgroundCleanup = false;

      // CRITICAL: Remove from config FIRST, before killing tmux pane
      // This prevents the race condition where polling detects "missing" pane
      // and recreates it before we finish closing
      const trackedPanes = getTrackedPanes(pane, context);
      const updatedPanes = trackedPanes.filter(p => p.id !== pane.id);
      await context.savePanes(updatedPanes);

      deleteRegisteredSession(pane.id);

      await closeTmuxPane(pane);

      // Best-effort cleanup of any stored prompt files for this pane slug
      // (including leftovers from interrupted launches).
      try {
        const promptCleanupRoot = pane.worktreePath
          ? (deriveProjectRootFromWorktreePath(pane.worktreePath) || paneProjectRoot)
          : paneProjectRoot;
        await cleanupPromptFilesForSlug(promptCleanupRoot, pane.slug);
      } catch {
        // Ignore prompt cleanup errors
      }

      // Handle worktree cleanup based on option
      if (pane.worktreePath && (option === 'kill_and_clean' || option === 'kill_clean_branch')) {
        const mainRepoPath = deriveProjectRootFromWorktreePath(pane.worktreePath) || paneProjectRoot;

        await triggerHookSync('before_worktree_remove', paneProjectRoot, pane);

        try {
          WorktreeCleanupService.getInstance().enqueueCleanup({
            pane,
            paneProjectRoot,
            mainRepoPath,
            deleteBranch: option === 'kill_clean_branch',
          });
          startedBackgroundCleanup = true;
        } catch {
          LogService.getInstance().warn(
            `Failed to start background cleanup for pane ${pane.id}`,
            'paneActions',
            pane.id
          );
        }
      }

      if (context.onPaneRemove) {
        context.onPaneRemove(pane.id);
      }

      recalculateLayoutAfterClose(panesFile, context.sessionName, updatedPanes);

      // Trigger pane_closed hook (after everything is cleaned up)
      await triggerHook('pane_closed', paneProjectRoot, pane);

      // If we just closed the last pane, recreate the welcome pane and recalculate layout
      if (updatedPanes.length === 0 && !context.skipLastPaneWelcome) {
        await handleLastPaneRemoved(sessionProjectRoot);
      }

      return {
        type: 'success',
        message: startedBackgroundCleanup
          ? `Pane "${pane.slug}" closed successfully (cleanup running in background)`
          : `Pane "${pane.slug}" closed successfully`,
        dismissable: true,
      };
    } finally {
      // CRITICAL: Always resume watcher, even if there was an error
      stateManager.resumeConfigWatcher();

      // Complete the lifecycle close (releases lock)
      // Do this AFTER resume to ensure the config is stable
      await lifecycleManager.completeClose(pane.id);
      await lifecycleManager.completeClose(pane.paneId);
    }
  } catch (error) {
    // Release lifecycle lock on error
    await lifecycleManager.completeClose(pane.id);
    await lifecycleManager.completeClose(pane.paneId);

    return {
      type: 'error',
      message: `Failed to close pane: ${error}`,
      dismissable: true,
    };
  }
}
