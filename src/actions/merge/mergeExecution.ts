/**
 * Merge Execution - UI logic for merge execution workflows
 *
 * This module handles ActionResult flows for executing merges with
 * conflict handling, cleanup, and post-merge actions.
 */

import type { ActionResult, ActionContext } from "../types.js"
import type { AumxPane } from "../../types.js"
import { triggerHook } from "../../utils/hooks.js"
import { getPaneBranchName } from "../../utils/git.js"
import { LogService } from "../../services/LogService.js"
import {
  abortMerge,
  mergeMainIntoWorktree,
  mergeWorktreeIntoMain,
} from "../../utils/gitMergeOps.js"
import { createConflictResolutionPaneForMerge } from "./conflictResolution.js"
import { closePane } from "../implementations/closeAction.js"
import {
  abortConflictMerge,
  prepareConflictMerge,
} from "../../utils/conflictMergePreparation.js"
import {
  abortConflictMergeTransaction,
  clearConflictMergeTransaction,
  getConflictMergeTransaction,
  markConflictMergeResolved,
  registerConflictMergeTransaction,
  verifyPreparedConflictMerge,
  verifyResolvedConflictMerge,
  inspectConflictMergeState,
} from "../../utils/conflictMergeTransaction.js"

async function rollbackPreparedManualMerge(
  repoPath: string,
  transaction: ReturnType<typeof registerConflictMergeTransaction> | undefined,
): Promise<{ success: boolean; error?: string }> {
  if (transaction) return abortConflictMergeTransaction(transaction)

  try {
    const abortResult = await abortConflictMerge(repoPath)
    const state = await inspectConflictMergeState(repoPath)
    if (state.status === 'clean') return { success: true }

    const details = abortResult.stderr || state.error || 'repository is not clean after rollback'
    return { success: false, error: details }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function prepareManualResolution(
  pane: AumxPane,
  mainBranch: string,
  mainRepoPath: string,
): Promise<ActionResult> {
  const repoPath = pane.worktreePath!
  if (getConflictMergeTransaction(repoPath)) {
    return {
      type: 'error',
      message: 'A conflict merge transaction is already active for this worktree',
      dismissable: true,
    }
  }

  let transaction: ReturnType<typeof registerConflictMergeTransaction> | undefined;
  try {
    const preparation = await prepareConflictMerge(repoPath, mainBranch)
    transaction = registerConflictMergeTransaction({
      id: `conflict-merge-manual-${pane.id}`,
      repoPath,
      mainRepoPath,
      sourceBranch: getPaneBranchName(pane),
      targetBranch: mainBranch,
      sourceCommit: preparation.sourceCommit,
      targetCommit: preparation.targetCommit,
      sourcePaneId: pane.id,
      conflictPaneId: pane.id,
    })
    const prepared = await verifyPreparedConflictMerge(transaction)
    if (prepared.status !== 'conflicted') {
      const rollback = await rollbackPreparedManualMerge(repoPath, transaction)
      if (!rollback.success) {
        return {
          type: 'error',
          message: `Unable to prepare manual conflict resolution and restore the worktree: ${rollback.error}`,
          dismissable: true,
        }
      }
      return {
        type: 'error',
        message: prepared.error || 'Unable to prepare manual conflict resolution',
        dismissable: true,
      }
    }
    return {
      type: 'navigation',
      title: 'Manual Conflict Resolution',
      message: `Conflicts in: ${prepared.unmergedFiles.join(', ')}. Resolve them in the pane, then try merge again.`,
      targetPaneId: pane.id,
      dismissable: true,
    }
  } catch (error) {
    const rollback = await rollbackPreparedManualMerge(repoPath, transaction)
    const rollbackMessage = rollback.success
      ? ''
      : ` Worktree rollback also failed: ${rollback.error}`
    return {
      type: 'error',
      message: `Unable to prepare manual conflict resolution: ${error instanceof Error ? error.message : String(error)}${rollbackMessage}`,
      dismissable: true,
    }
  }
}

/**
 * Execute merge with conflict handling
 */
export async function executeMergeWithConflictHandling(
  pane: AumxPane,
  context: ActionContext,
  mainBranch: string,
  mainRepoPath: string,
  strategy: "manual" | "ai"
): Promise<ActionResult> {
  const result = await mergeMainIntoWorktree(pane.worktreePath!, mainBranch)

  if (!result.success && result.needsManualResolution) {
    if (strategy === "ai") {
      return createConflictResolutionPaneForMerge(pane, context, mainBranch, mainRepoPath)
    } else {
      return prepareManualResolution(pane, mainBranch, mainRepoPath)
    }
  }

  if (!result.success) {
    return {
      type: "error",
      message: `Merge failed: ${result.error}`,
      dismissable: true,
    }
  }

  // No conflicts, proceed with the main merge
  return executeMerge(pane, context, mainBranch, mainRepoPath)
}

/**
 * Execute the actual merge operation (called after all pre-checks pass)
 * This implements the 2-phase merge:
 * 1. Merge main INTO worktree (to get latest changes and detect conflicts)
 * 2. Merge worktree INTO main (to bring changes back)
 *
 * @param skipWorktreeMerge - Set to true when resuming after conflict resolution (step 1 already done)
 */
export async function executeMerge(
  pane: AumxPane,
  context: ActionContext,
  mainBranch: string,
  mainRepoPath: string,
  skipWorktreeMerge: boolean = false
): Promise<ActionResult> {
  const log = LogService.getInstance()
  const transaction = pane.worktreePath ? getConflictMergeTransaction(pane.worktreePath) : undefined

  if (transaction) {
    if (transaction.state === 'active' && !await markConflictMergeResolved(transaction.id)) {
      const prepared = await verifyPreparedConflictMerge(transaction)
      if (prepared.status === 'conflicted') {
        return {
          type: 'navigation',
          title: 'Manual Conflict Resolution',
          message: `Conflicts in: ${prepared.unmergedFiles.join(', ')}. Resolve them in the pane, then try merge again.`,
          targetPaneId: pane.id,
          dismissable: true,
        }
      }
      return {
        type: 'error',
        message: prepared.error || 'Conflict merge transaction is no longer valid',
        dismissable: true,
      }
    }
    if (transaction.state === 'resolved' && !await verifyResolvedConflictMerge(transaction)) {
      return {
        type: 'error',
        message: 'Conflict resolution is not verified; refusing to merge or clean up the worktree',
        dismissable: true,
      }
    }
  }

  // Skip the main→worktree pull when resuming after agent-driven conflict resolution.
  if (!skipWorktreeMerge) {
    const step1 = await mergeMainIntoWorktree(pane.worktreePath!, mainBranch)

    if (!step1.success) {
      // Check if this is a conflict that needs manual resolution
      if (
        step1.needsManualResolution &&
        step1.conflictFiles &&
        step1.conflictFiles.length > 0
      ) {
        // Offer AI/manual conflict resolution
        return {
          type: "choice",
          title: "Merge Conflicts Detected",
          message: `Conflicts occurred while merging ${mainBranch} into worktree:\n${step1.conflictFiles
            .slice(0, 5)
            .join("\n")}${step1.conflictFiles.length > 5 ? "\n..." : ""}`,
          options: [
            {
              id: "ai_merge",
              label: "Try AI-assisted merge",
              description: "Let AI intelligently combine both versions",
              default: true,
            },
            {
              id: "manual_merge",
              label: "Manual resolution",
              description: "Resolve conflicts yourself in the pane",
            },
            {
              id: "abort",
              label: "Abort merge",
              description: "Cancel and clean up",
            },
          ],
          onSelect: async (optionId: string) => {
            if (optionId === "abort") {
              await abortMerge(pane.worktreePath!)
              return {
                type: "info",
                message: "Merge aborted",
                dismissable: true,
              }
            }

            if (optionId === "manual_merge") {
              return prepareManualResolution(pane, mainBranch, mainRepoPath)
            }

            if (optionId === "ai_merge") {
              return createConflictResolutionPaneForMerge(
                pane,
                context,
                mainBranch,
                mainRepoPath
              )
            }

            return {
              type: "info",
              message: "Unknown option",
              dismissable: true,
            }
          },
          dismissable: true,
        }
      }

      // Non-conflict error (e.g., permission denied, git failure)
      return {
        type: "error",
        title: "Merge Failed",
        message: `Failed to merge ${mainBranch} into worktree: ${step1.error}`,
        dismissable: true,
      }
    }
  }

  const step2 = await mergeWorktreeIntoMain(mainRepoPath, getPaneBranchName(pane))

  if (!step2.success) {
    return {
      type: "error",
      title: "Merge Failed",
      message: `Failed to merge into ${mainBranch}: ${step2.error}`,
      dismissable: true,
    }
  }

  if (transaction) clearConflictMergeTransaction(transaction.repoPath)

  // Trigger post_merge hook after successful merge
  log.debug(`[mergeExecution] About to trigger post_merge hook for ${pane.slug}`, "mergeExecution")
  await triggerHook("post_merge", mainRepoPath, pane, {
    AUMX_TARGET_BRANCH: mainBranch,
  })
  log.debug(`[mergeExecution] post_merge hook completed for ${pane.slug}`, "mergeExecution")

  // Merge successful! Show cleanup options using the existing closePane dialog
  // This reuses the CLOSE action which handles everything properly:
  // - Hooks (before_pane_close, before_worktree_remove, worktree_removed, pane_closed)
  // - Layout recalculation after pane removal
  // - Last pane handling (recreates welcome pane)
  // - Terminal clearing to prevent artifacts
  log.debug(`[mergeExecution] Merge complete for ${pane.slug}, showing cleanup options via closePane`, "mergeExecution")
  log.debug(
    `[mergeExecution] Context has ${context.panes.length} panes: ${context.panes.map(p => p.id).join(', ')}`,
    "mergeExecution",
  )
  log.debug(`[mergeExecution] Pane to close: ${pane.id} (slug: ${pane.slug})`, "mergeExecution")

  const closeResult = await closePane(pane, context)
  log.debug(`[mergeExecution] closePane returned result type: ${closeResult.type}`, "mergeExecution")
  return closeResult
}
