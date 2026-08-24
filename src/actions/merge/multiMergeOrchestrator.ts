/**
 * Multi-Merge Orchestrator
 *
 * Coordinates merging multiple worktrees in sequence with proper
 * dialog handling and error recovery.
 */

import { getAgentLabel, type AgentName } from '../../agents/agent-contract.js';
import type { ActionResult, ActionContext } from '../types.js';
import type { AumxPane } from '../../types.js';
import type { WorktreeInfo, MergeQueueItem, MultiMergeResult } from './types.js';
import { getWorktreeDisplayLabel } from '../../utils/worktreeDiscovery.js';
import { LogService } from '../../services/LogService.js';
import { validateMerge } from '../../utils/mergeValidation.js';
import { handleCommitWithOptions } from './commitMessageHandler.js';
import { getAvailableAgents } from '../../utils/agentDetection.js';
import { TmuxService } from '../../services/TmuxService.js';
import { StateManager } from '../../shared/StateManager.js';
import { abortMerge, mergeMainIntoWorktree, mergeWorktreeIntoMain } from '../../utils/gitMergeOps.js';
import { clearConflictMergeTransaction } from '../../utils/conflictMergeTransaction.js';
import { triggerHook } from '../../utils/hooks.js';
import { closePane } from '../implementations/closeAction.js';
import { launchManagedConflictResolutionPane } from './conflictPaneLifecycle.js';

const log = LogService.getInstance();

/**
 * Build the merge queue from detected worktrees
 * - Runs validation on each worktree
 * - Filters to only those with changes to merge
 * - Already sorted by depth (deepest first from detectAllWorktrees)
 */
export async function buildMergeQueue(
  worktrees: WorktreeInfo[]
): Promise<MergeQueueItem[]> {
  const queue: MergeQueueItem[] = [];

  for (const worktree of worktrees) {
    const validation = await validateMerge(
      worktree.parentRepoPath,
      worktree.worktreePath,
      worktree.branch
    );

    // Include if there's something to merge (has issues that can be resolved, or can merge)
    // Exclude only if the ONLY issue is 'nothing_to_merge'
    const hasNothingToMerge = validation.issues.some(i => i.type === 'nothing_to_merge');
    const hasOnlyNothingToMerge = validation.issues.length === 1 && hasNothingToMerge;

    log.debug(
      `[buildMergeQueue] ${worktree.repoName}: canMerge=${validation.canMerge}, issues=[${validation.issues.map(i => i.type).join(', ')}], included=${!hasOnlyNothingToMerge}`,
      'multiMerge',
    );

    if (!hasOnlyNothingToMerge) {
      queue.push({
        worktree,
        validation,
        status: 'pending',
      });
    }
  }

  log.debug(`[buildMergeQueue] Final queue: ${queue.map(q => q.worktree.repoName).join(', ')}`, 'multiMerge');
  return queue;
}

/**
 * Execute multi-merge with sequential dialogs
 * Returns ActionResult that chains through each merge
 */
export async function executeMultiMerge(
  pane: AumxPane,
  context: ActionContext,
  queue: MergeQueueItem[]
): Promise<ActionResult> {
  // Start with confirmation dialog
  return showMultiMergeConfirmation(pane, context, queue);
}

/**
 * Show initial confirmation dialog listing all worktrees to merge
 */
function showMultiMergeConfirmation(
  pane: AumxPane,
  context: ActionContext,
  queue: MergeQueueItem[]
): ActionResult {
  const worktreeList = queue
    .map((item) => {
      // Use just the repo name for cleaner display
      return ` • ${item.worktree.repoName}`;
    })
    .join('\n');

  return {
    type: 'confirm',
    title: 'Multi-Repository Merge',
    message: `Changes detected in ${queue.length} repositor${queue.length === 1 ? 'y' : 'ies'}:\n\n${worktreeList}`,
    confirmLabel: 'Start Merge',
    cancelLabel: 'Cancel',
    onConfirm: async () => {
      // Initialize result tracking
      const result: MultiMergeResult = {
        totalWorktrees: queue.length,
        successful: 0,
        failed: 0,
        skipped: 0,
        results: [],
      };

      // Start processing the queue
      return processNextInQueue(pane, context, queue, 0, result);
    },
    onCancel: async () => {
      return {
        type: 'info',
        message: 'Multi-merge cancelled',
        dismissable: true,
      };
    },
  };
}

/**
 * Process the next item in the merge queue
 */
async function processNextInQueue(
  pane: AumxPane,
  context: ActionContext,
  queue: MergeQueueItem[],
  currentIndex: number,
  result: MultiMergeResult
): Promise<ActionResult> {
  // Check if we're done
  if (currentIndex >= queue.length) {
    return showMultiMergeSummary(pane, context, result);
  }

  const item = queue[currentIndex];
  const worktreeLabel = getWorktreeDisplayLabel(item.worktree);

  // Show progress
  log.debug(`[multiMerge] Processing ${currentIndex + 1}/${queue.length}: ${worktreeLabel}`, 'multiMerge');

  // Update status
  item.status = 'in_progress';

  // Execute the merge for this worktree
  return executeSingleWorktreeMerge(
    pane,
    context,
    item,
    currentIndex,
    queue,
    result,
    async (success: boolean, error?: string) => {
      // Record result
      if (success) {
        item.status = 'completed';
        result.successful++;
        result.results.push({
          worktree: item.worktree,
          status: 'completed',
        });
      } else if (error === 'skipped') {
        item.status = 'skipped';
        result.skipped++;
        result.results.push({
          worktree: item.worktree,
          status: 'skipped',
        });
      } else {
        item.status = 'failed';
        item.error = error;
        result.failed++;
        result.results.push({
          worktree: item.worktree,
          status: 'failed',
          error,
        });
      }

      // Process next item
      return processNextInQueue(pane, context, queue, currentIndex + 1, result);
    }
  );
}

/**
 * Execute merge for a single worktree in the queue
 */
async function executeSingleWorktreeMerge(
  pane: AumxPane,
  context: ActionContext,
  item: MergeQueueItem,
  currentIndex: number,
  queue: MergeQueueItem[],
  result: MultiMergeResult,
  onComplete: (success: boolean, error?: string) => Promise<ActionResult>
): Promise<ActionResult> {
  const { validation, worktree } = item;
  const worktreeLabel = getWorktreeDisplayLabel(worktree);
  const progressPrefix = `[${currentIndex + 1}/${queue.length}] ${worktreeLabel}`;

  // Handle issues first (same as single merge flow)
  if (!validation.canMerge) {
    return handleWorktreeMergeIssues(
      pane,
      context,
      item,
      progressPrefix,
      queue,
      currentIndex,
      result,
      onComplete
    );
  }

  // No issues - show confirmation for this worktree
  return {
    type: 'confirm',
    title: progressPrefix,
    message: `Merge "${worktree.branch}" into ${validation.mainBranch}?`,
    confirmLabel: 'Merge',
    cancelLabel: 'Skip',
    onConfirm: async () => {
      return performWorktreeMerge(pane, context, item, progressPrefix, onComplete, queue, currentIndex, result);
    },
    onCancel: async () => {
      // Skip this worktree, continue with others
      return onComplete(false, 'skipped');
    },
  };
}

/**
 * Handle merge issues for a single worktree in multi-merge context
 */
async function handleWorktreeMergeIssues(
  pane: AumxPane,
  context: ActionContext,
  item: MergeQueueItem,
  progressPrefix: string,
  queue: MergeQueueItem[],
  currentIndex: number,
  result: MultiMergeResult,
  onComplete: (success: boolean, error?: string) => Promise<ActionResult>
): Promise<ActionResult> {
  const { validation, worktree } = item;
  const { issues, mainBranch } = validation;

  const retryMerge = async (): Promise<ActionResult> => {
    item.validation = await validateMerge(
      worktree.parentRepoPath,
      worktree.worktreePath,
      worktree.branch
    );

    if (item.validation.canMerge) {
      return performWorktreeMerge(pane, context, item, progressPrefix, onComplete, queue, currentIndex, result);
    } else {
      return handleWorktreeMergeIssues(pane, context, item, progressPrefix, queue, currentIndex, result, onComplete);
    }
  };

  // Check for nothing to merge
  const nothingToMerge = issues.find(i => i.type === 'nothing_to_merge');
  if (nothingToMerge) {
    return onComplete(false, 'skipped');
  }

  // Check for main dirty
  const mainDirty = issues.find(i => i.type === 'main_dirty');
  if (mainDirty) {
    return handleMainDirtyForWorktree(
      item,
      progressPrefix,
      mainBranch,
      retryMerge,
      onComplete
    );
  }

  // Check for worktree uncommitted
  const worktreeUncommitted = issues.find(i => i.type === 'worktree_uncommitted');
  if (worktreeUncommitted) {
    return handleUncommittedForWorktree(
      item,
      progressPrefix,
      retryMerge,
      onComplete
    );
  }

  // Check for merge conflict
  const mergeConflict = issues.find(i => i.type === 'merge_conflict');
  if (mergeConflict) {
    return handleConflictForWorktree(
      pane,
      context,
      item,
      progressPrefix,
      mainBranch,
      queue,
      currentIndex,
      result,
      onComplete
    );
  }

  // Unknown issue - skip with error
  return onComplete(false, issues.map(i => i.message).join('; '));
}

/**
 * Handle main branch dirty for a worktree in multi-merge
 */
async function handleMainDirtyForWorktree(
  item: MergeQueueItem,
  progressPrefix: string,
  mainBranch: string,
  retryMerge: () => Promise<ActionResult>,
  onComplete: (success: boolean, error?: string) => Promise<ActionResult>
): Promise<ActionResult> {
  const { worktree, validation } = item;
  const issue = validation.issues.find(i => i.type === 'main_dirty')!;
  const files = issue.files || [];

  log.debug(
    `[multiMerge] handleMainDirtyForWorktree - parentRepoPath: ${worktree.parentRepoPath}, worktreePath: ${worktree.worktreePath}`,
    'multiMerge',
  );

  return {
    type: 'choice',
    title: `${progressPrefix}: Main Branch Has Changes`,
    message: `${mainBranch} in ${worktree.repoName} has uncommitted changes:\n${files.slice(0, 3).map(f => ` • ${f}`).join('\n')}${files.length > 3 ? '\n  ...' : ''}`,
    options: [
      {
        id: 'commit_automatic',
        label: 'AI commit (automatic)',
        description: 'Auto-generate and commit immediately',
        default: true,
      },
      {
        id: 'commit_ai_editable',
        label: 'AI commit (editable)',
        description: 'Generate message, edit before commit',
      },
      {
        id: 'commit_manual',
        label: 'Manual commit message',
        description: 'Write your own commit message',
      },
      {
        id: 'skip',
        label: 'Skip this repo',
        description: 'Continue with other repositories',
      },
    ],
    onSelect: async (optionId: string) => {
      if (optionId === 'skip') {
        return onComplete(false, 'skipped');
      }

      if (
        optionId === 'commit_automatic' ||
        optionId === 'commit_ai_editable' ||
        optionId === 'commit_manual'
      ) {
        return handleCommitWithOptions(
          worktree.parentRepoPath,
          optionId as 'commit_automatic' | 'commit_ai_editable' | 'commit_manual',
          retryMerge
        );
      }

      return onComplete(false, 'Unknown option');
    },
    dismissable: false,
  };
}

/**
 * Handle uncommitted changes in worktree for multi-merge
 */
async function handleUncommittedForWorktree(
  item: MergeQueueItem,
  progressPrefix: string,
  retryMerge: () => Promise<ActionResult>,
  onComplete: (success: boolean, error?: string) => Promise<ActionResult>
): Promise<ActionResult> {
  const { worktree, validation } = item;
  const issue = validation.issues.find(i => i.type === 'worktree_uncommitted')!;
  const files = issue.files || [];

  log.debug(
    `[multiMerge] handleUncommittedForWorktree - worktreePath: ${worktree.worktreePath}, parentRepoPath: ${worktree.parentRepoPath}`,
    'multiMerge',
  );

  return {
    type: 'choice',
    title: `${progressPrefix}: Uncommitted Changes`,
    message: `${worktree.repoName} worktree has uncommitted changes:\n${files.slice(0, 3).map(f => ` • ${f}`).join('\n')}${files.length > 3 ? '\n  ...' : ''}`,
    options: [
      {
        id: 'commit_automatic',
        label: 'AI commit (automatic)',
        description: 'Auto-generate and commit immediately',
        default: true,
      },
      {
        id: 'commit_ai_editable',
        label: 'AI commit (editable)',
        description: 'Generate message, edit before commit',
      },
      {
        id: 'commit_manual',
        label: 'Manual commit message',
        description: 'Write your own commit message',
      },
      {
        id: 'skip',
        label: 'Skip this repo',
        description: 'Continue with other repositories',
      },
    ],
    onSelect: async (optionId: string) => {
      if (optionId === 'skip') {
        return onComplete(false, 'skipped');
      }

      if (
        optionId === 'commit_automatic' ||
        optionId === 'commit_ai_editable' ||
        optionId === 'commit_manual'
      ) {
        log.debug(`[multiMerge] Committing to worktree path: ${worktree.worktreePath}`, 'multiMerge');
        return handleCommitWithOptions(
          worktree.worktreePath,
          optionId as 'commit_automatic' | 'commit_ai_editable' | 'commit_manual',
          retryMerge
        );
      }

      return onComplete(false, 'Unknown option');
    },
    dismissable: false,
  };
}

/**
 * Handle merge conflict for a worktree in multi-merge
 */
async function handleConflictForWorktree(
  pane: AumxPane,
  context: ActionContext,
  item: MergeQueueItem,
  progressPrefix: string,
  mainBranch: string,
  queue: MergeQueueItem[],
  currentIndex: number,
  result: MultiMergeResult,
  onComplete: (success: boolean, error?: string) => Promise<ActionResult>
): Promise<ActionResult> {
  const { worktree, validation } = item;
  const issue = validation.issues.find(i => i.type === 'merge_conflict')!;
  const files = issue.files || [];

  const hasRealFiles = files.length > 0;

  const conflictMessage = hasRealFiles
    ? `Conflicts detected in ${worktree.repoName}:\n${files.slice(0, 3).map(f => ` • ${f}`).join('\n')}${files.length > 3 ? '\n  ...' : ''}`
    : `Potential conflicts detected in ${worktree.repoName} between ${mainBranch} and ${worktree.branch}.\n\nThe branches have diverged and may have conflicting changes.`;

  return {
    type: 'choice',
    title: `${progressPrefix}: Merge Conflicts`,
    message: conflictMessage,
    options: [
      {
        id: 'ai_merge',
        label: 'AI-assisted merge',
        description: 'Launch agent to resolve conflicts, then continue',
        default: true,
      },
      {
        id: 'skip',
        label: 'Skip this repo',
        description: 'Resolve conflicts manually later',
      },
      {
        id: 'abort',
        label: 'Stop multi-merge',
        description: 'Abort remaining merges',
      },
    ],
    onSelect: async (optionId: string) => {
      if (optionId === 'skip') {
        return onComplete(false, 'skipped');
      }
      if (optionId === 'abort') {
        return {
          type: 'info',
          title: 'Multi-Merge Aborted',
          message: `Stopped at ${worktree.repoName} due to conflicts.`,
          dismissable: true,
        };
      }
      if (optionId === 'ai_merge') {
        return launchConflictResolutionForSubWorktree(
          pane,
          context,
          item,
          queue,
          currentIndex,
          result
        );
      }
      return onComplete(false, 'Unknown option');
    },
    dismissable: false,
  };
}

/**
 * Launch AI-assisted conflict resolution for a sub-worktree
 * Creates a new pane with an agent to resolve conflicts, then continues the multi-merge
 */
async function launchConflictResolutionForSubWorktree(
  pane: AumxPane,
  context: ActionContext,
  item: MergeQueueItem,
  queue: MergeQueueItem[],
  currentIndex: number,
  result: MultiMergeResult
): Promise<ActionResult> {
  const { worktree } = item;
  const availableAgents = await getAvailableAgents();

  if (availableAgents.length === 0) {
    return {
      type: 'error',
      message: 'No AI agents available. Please install a supported coding agent.',
      dismissable: true,
    };
  }

  // Helper to create pane with chosen agent
  const createPaneWithAgent = async (agent: AgentName): Promise<ActionResult> => {
    return createAndMonitorConflictPane(
      pane,
      context,
      item,
      queue,
      currentIndex,
      result,
      agent,
    );
  };

  // If multiple agents available, ask user to choose
  if (availableAgents.length > 1) {
    return {
      type: 'choice',
      title: 'Choose AI Agent for Conflict Resolution',
      message: `Which agent should resolve conflicts in ${worktree.repoName}?`,
      options: availableAgents.map(agent => ({
        id: agent,
        label: getAgentLabel(agent),
        description: agent === 'pi' ? 'Multi-provider coding agent' : 'Coding agent',
        default: agent === 'claude',
      })),
      onSelect: async (agentId: string) => {
        return createPaneWithAgent(agentId as AgentName);
      },
      dismissable: true,
    };
  }

  // Only one agent available, use it directly
  return createPaneWithAgent(availableAgents[0]);
}

/**
 * Create a conflict resolution pane and monitor for completion
 */
async function createAndMonitorConflictPane(
  pane: AumxPane,
  context: ActionContext,
  item: MergeQueueItem,
  queue: MergeQueueItem[],
  currentIndex: number,
  result: MultiMergeResult,
  agent: AgentName
): Promise<ActionResult> {
  const { worktree, validation } = item;
  const { mainBranch } = validation;
  let terminalRecorded = false;
  let callbackClaimed = false;

  const claimCallback = (): boolean => {
    if (callbackClaimed) return false;
    callbackClaimed = true;
    return true;
  };

  const continueQueue = async (success: boolean, error?: string): Promise<void> => {
    if (terminalRecorded) return;
    terminalRecorded = true;

    if (success) {
      item.status = 'completed';
      result.successful++;
      result.results.push({ worktree: item.worktree, status: 'completed' });
    } else {
      item.status = 'failed';
      item.error = error;
      result.failed++;
      result.results.push({ worktree: item.worktree, status: 'failed', error });
    }

    const nextResult = await processNextInQueue(pane, context, queue, currentIndex + 1, result);
    try {
      await context.onActionResult?.(nextResult);
    } catch (deliveryError) {
      log.error(
        `[multiMerge] Could not deliver continuation result: ${deliveryError instanceof Error ? deliveryError.message : String(deliveryError)}`,
        'multiMerge',
      );
    }
  };

  try {
    if (!pane.projectRoot) {
      throw new Error(`Pane ${pane.id} is missing its main project root`);
    }

    // For sub-worktrees, the worktree path is the merge target.
    const conflictPane = await launchManagedConflictResolutionPane({
      context,
      sourcePaneId: pane.id,
      paneOptions: {
        sourceTmuxPaneId: pane.paneId,
        otlpEndpoint: context.otlpEndpoint,
        projectRoot: pane.projectRoot,
        sourceBranch: worktree.branch,
        targetBranch: mainBranch,
        targetRepoPath: worktree.worktreePath,
        mainRepoPath: worktree.parentRepoPath,
        terminalTranscriptDir: context.terminalTranscriptDir,
        agent,
      },
      onResolved: async (resolvedConflictPane) => {
        if (!claimCallback()) return;
        try {
          log.info(`[multiMerge] Conflicts resolved for ${worktree.repoName}, cleaning up conflict pane`, 'multiMerge');
          const tmuxService = TmuxService.getInstance();

          // Kill the conflict pane
          await tmuxService.killPane(resolvedConflictPane.paneId);

          const stateManager = StateManager.getInstance();
          const currentPanes = stateManager.getPanes();
          const panesWithoutConflictPane = currentPanes.filter((p: AumxPane) => p.id !== resolvedConflictPane.id);
          await context.savePanes(panesWithoutConflictPane);

          const mergeResult = await mergeWorktreeIntoMain(worktree.parentRepoPath, worktree.branch);

          if (!mergeResult.success) {
            log.error(
              `[multiMerge] Failed to merge ${worktree.branch} into ${mainBranch}: ${mergeResult.error}`,
              'multiMerge',
            );
            await continueQueue(false, mergeResult.error || 'Final merge failed');
            return;
          } else {
            clearConflictMergeTransaction(worktree.worktreePath);
            // Trigger post_merge hook
            await triggerHook('post_merge', worktree.parentRepoPath, pane, {
              AUMX_TARGET_BRANCH: mainBranch,
              AUMX_WORKTREE_PATH: worktree.worktreePath,
              AUMX_REPO_NAME: worktree.repoName,
            });
          }
          await continueQueue(true);
        } catch (error) {
          const resolvedError = error instanceof Error ? error : new Error(String(error));
          log.error('[multiMerge] Error in conflict resolution onResolved', 'multiMerge', undefined, resolvedError);
          await continueQueue(false, resolvedError.message);
        }
      },
      onAbandoned: async (reason, error) => {
        if (!claimCallback()) return;
        await continueQueue(false, error || reason);
      },
    });

    return {
      type: 'navigation',
      title: 'Conflict Resolution Started',
      message: `Created pane "${conflictPane.slug}" with ${agent} to resolve conflicts in ${worktree.repoName}.\n\nMulti-merge will continue automatically when conflicts are resolved.`,
      targetPaneId: conflictPane.id,
      dismissable: true,
    };
  } catch (error) {
    return {
      type: 'error',
      message: `Failed to create conflict resolution pane: ${error instanceof Error ? error.message : String(error)}`,
      dismissable: true,
    };
  }
}

/**
 * Actually perform the merge for a worktree
 */
async function performWorktreeMerge(
  pane: AumxPane,
  context: ActionContext,
  item: MergeQueueItem,
  progressPrefix: string,
  onComplete: (success: boolean, error?: string) => Promise<ActionResult>,
  queue?: MergeQueueItem[],
  currentIndex?: number,
  result?: MultiMergeResult
): Promise<ActionResult> {
  const { worktree, validation } = item;
  const { mainBranch } = validation;

  await triggerHook('pre_merge', worktree.parentRepoPath, pane, {
    AUMX_TARGET_BRANCH: mainBranch,
    AUMX_WORKTREE_PATH: worktree.worktreePath,
    AUMX_REPO_NAME: worktree.repoName,
  });

  const step1 = await mergeMainIntoWorktree(worktree.worktreePath, mainBranch);

  if (!step1.success) {
    if (step1.needsManualResolution && step1.conflictFiles?.length) {
      // Conflict occurred during merge - offer AI resolution if queue info available
      const hasQueueInfo = queue && typeof currentIndex === 'number' && result;

      const options: Array<{id: string; label: string; description: string; default?: boolean}> = [];

      if (hasQueueInfo) {
        options.push({
          id: 'ai_merge',
          label: 'AI-assisted merge',
          description: 'Launch agent to resolve conflicts, then continue',
          default: true,
        });
      }

      options.push({
        id: 'skip',
        label: 'Skip this repo',
        description: 'Abort this merge, continue with others',
        default: !hasQueueInfo, // Default if no AI option
      });

      options.push({
        id: 'abort_all',
        label: 'Stop multi-merge',
        description: 'Stop processing remaining repos',
      });

      return {
        type: 'choice',
        title: `${progressPrefix}: Merge Conflict`,
        message: `Conflict while merging ${mainBranch} into worktree:\n${step1.conflictFiles.slice(0, 3).map(f => ` • ${f}`).join('\n')}`,
        options,
        onSelect: async (optionId: string) => {
          if (optionId === 'ai_merge' && hasQueueInfo) {
            // Don't abort - let the agent resolve the conflicts that are already in place
            return launchConflictResolutionForSubWorktree(
              pane,
              context,
              item,
              queue,
              currentIndex,
              result
            );
          }

          await abortMerge(worktree.worktreePath);

          if (optionId === 'abort_all') {
            return {
              type: 'info',
              title: 'Multi-Merge Aborted',
              message: `Stopped due to conflicts in ${worktree.repoName}`,
              dismissable: true,
            };
          }
          return onComplete(false, 'skipped');
        },
        dismissable: false,
      };
    }

    return onComplete(false, `Merge failed: ${step1.error}`);
  }

  const step2 = await mergeWorktreeIntoMain(worktree.parentRepoPath, worktree.branch);

  if (!step2.success) {
    return onComplete(false, `Failed to merge into ${mainBranch}: ${step2.error}`);
  }

  // Trigger post_merge hook
  await triggerHook('post_merge', worktree.parentRepoPath, pane, {
    AUMX_TARGET_BRANCH: mainBranch,
    AUMX_WORKTREE_PATH: worktree.worktreePath,
    AUMX_REPO_NAME: worktree.repoName,
  });

  log.info(`[multiMerge] Successfully merged ${worktree.repoName}`, 'multiMerge');
  return onComplete(true);
}

/**
 * Show final summary of multi-merge operation
 */
function showMultiMergeSummary(
  pane: AumxPane,
  context: ActionContext,
  result: MultiMergeResult
): ActionResult {
  const summaryLines = result.results.map(r => {
    const name = r.worktree.repoName;
    const icon = r.status === 'completed' ? '✓' : r.status === 'skipped' ? '○' : '✗';
    const suffix = r.error && r.status === 'failed' ? `: ${r.error}` : '';
    return ` ${icon} ${name}${suffix}`;
  });

  const message = [
    `Completed: ${result.successful}`,
    result.skipped > 0 ? `Skipped: ${result.skipped}` : null,
    result.failed > 0 ? `Failed: ${result.failed}` : null,
    '',
    ...summaryLines,
  ]
    .filter(Boolean)
    .join('\n');

  // If all successful, offer to close pane
  if (result.failed === 0 && result.successful > 0) {
    return {
      type: 'confirm',
      title: 'Multi-Merge Complete',
      message,
      confirmLabel: 'Close Pane',
      cancelLabel: 'Keep Open',
      onConfirm: async () => {
        return closePane(pane, context);
      },
      onCancel: async () => {
        return {
          type: 'success',
          message: 'Merges complete. Pane kept open.',
          dismissable: true,
        };
      },
    };
  }

  // Some failures - just show info
  return {
    type: 'info',
    title: result.failed > 0 ? 'Multi-Merge Partial' : 'Multi-Merge Complete',
    message,
    dismissable: true,
  };
}
