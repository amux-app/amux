/**
 * Conflict Resolution - UI logic for conflict resolution workflows
 *
 * This module handles ActionResult flows for creating conflict resolution panes
 * with AI agents to help resolve merge conflicts.
 */

import type { ActionResult, ActionContext } from '../types.js';
import { getAgentLabel, type AgentName } from '../../agents/agent-contract.js';
import type { AumxPane } from '../../types.js';
import { LogService } from '../../services/LogService.js';
import { getPaneBranchName } from '../../utils/git.js';
import { getAvailableAgents } from '../../utils/agentDetection.js';
import { StateManager } from '../../shared/StateManager.js';
import { executeMerge } from './mergeExecution.js';
import { launchManagedConflictResolutionPane } from './conflictPaneLifecycle.js';

/**
 * Create a new pane for AI-assisted conflict resolution
 */
export async function createConflictResolutionPaneForMerge(
  pane: AumxPane,
  context: ActionContext,
  targetBranch: string,
  targetRepoPath: string
): Promise<ActionResult> {
  const availableAgents = await getAvailableAgents();

  if (availableAgents.length === 0) {
    return {
      type: 'error',
      message: 'No AI agents available. Please install a supported coding agent.',
      dismissable: true,
    };
  }

  // If multiple agents available, ask user to choose
  if (availableAgents.length > 1) {
    return {
      type: 'choice',
      title: 'Choose AI Agent for Conflict Resolution',
      message: 'Which agent would you like to use to resolve merge conflicts?',
      options: availableAgents.map(agent => ({
        id: agent,
        label: getAgentLabel(agent),
        description: agent === 'pi' ? 'Multi-provider coding agent' : 'Coding agent',
        default: agent === 'claude',
      })),
      onSelect: async (agentId: string) => {
        return createAndLaunchConflictPane(
          pane,
          context,
          targetBranch,
          targetRepoPath,
          agentId as AgentName
        );
      },
      dismissable: true,
    };
  }

  // Only one agent available, use it directly
  return createAndLaunchConflictPane(
    pane,
    context,
    targetBranch,
    targetRepoPath,
    availableAgents[0]
  );
}

/**
 * Actually create and launch the conflict resolution pane
 */
async function createAndLaunchConflictPane(
  pane: AumxPane,
  context: ActionContext,
  targetBranch: string,
  targetRepoPath: string,
  agent: AgentName
): Promise<ActionResult> {
  const log = LogService.getInstance();
  try {
    if (!pane.projectRoot) {
      throw new Error(`Pane ${pane.id} is missing its main project root`);
    }

    // Conflicts live in the worktree, not the main repo.
    const conflictPane = await launchManagedConflictResolutionPane({
      context,
      sourcePaneId: pane.id,
      paneOptions: {
        sourceTmuxPaneId: pane.paneId,
        otlpEndpoint: context.otlpEndpoint,
        projectRoot: pane.projectRoot,
        sourceBranch: getPaneBranchName(pane),
        targetBranch,
        targetRepoPath: pane.worktreePath!, // CRITICAL: Use worktree, not main repo
        mainRepoPath: targetRepoPath,
        terminalTranscriptDir: context.terminalTranscriptDir,
        agent,
      },
      onResolved: async (resolvedConflictPane) => {
        // The managed lifecycle owns pane, transcript, and persisted-state cleanup
        // before this continuation runs.
        try {
          log.info(
            `[conflictResolution] Conflicts resolved for ${pane.slug}, cleaning up conflict pane ${resolvedConflictPane.id}`,
            'conflictResolution',
          );
          const stateManager = StateManager.getInstance();
          const currentPanes = stateManager.getPanes();
          log.debug(
            `[conflictResolution] Current panes: ${currentPanes.map(p => p.id).join(', ')}`,
            'conflictResolution',
          );

          const panesWithoutConflictPane = currentPanes.filter((p: AumxPane) => p.id !== resolvedConflictPane.id);
          log.debug(
            `[conflictResolution] Removing conflict pane ${resolvedConflictPane.id}, remaining: ${panesWithoutConflictPane.map(p => p.id).join(', ')}`,
            'conflictResolution',
          );
          const updatedContext = {
            ...context,
            panes: panesWithoutConflictPane,
          };

          // Re-run executeMerge which will now succeed (conflicts are resolved)
          // This will return the cleanup confirmation dialog
          // IMPORTANT: Pass skipWorktreeMerge=true because agent already resolved conflicts
          log.debug(
            `[conflictResolution] Executing merge for original pane ${pane.id} (${pane.slug})`,
            'conflictResolution',
          );
          const result = await executeMerge(pane, updatedContext, targetBranch, targetRepoPath, true);

          // If we have the onActionResult callback, use it to show the dialog
          if (context.onActionResult) {
            log.debug('[conflictResolution] Showing merge result dialog to user', 'conflictResolution');
            await context.onActionResult(result);
          }
        } catch (error) {
          const resolvedError = error instanceof Error ? error : new Error(String(error));
          log.error('[conflictResolution] Error in onResolved', 'conflictResolution', undefined, resolvedError);
          try {
            await context.onActionResult?.({
              type: 'error',
              message: `Conflict resolution continuation failed: ${resolvedError.message}`,
              dismissable: true,
            });
          } catch (notificationError) {
            log.error(
              '[conflictResolution] Failed to surface onResolved error',
              'conflictResolution',
              undefined,
              notificationError instanceof Error ? notificationError : new Error(String(notificationError)),
            );
          }
          throw resolvedError;
        }
      },
      onAbandoned: async (reason, error) => {
        if (context.onActionResult) {
          await context.onActionResult({
            type: 'error',
            message: error
              ? `Conflict resolution abandoned: ${error}`
              : `Conflict resolution abandoned: ${reason}`,
            dismissable: true,
          });
        }
      },
    });

    return {
      type: 'navigation',
      title: 'Conflict Resolution Pane Created',
      message: `Created pane "${conflictPane.slug}" with ${agent} to help resolve conflicts. Switch to it to see the AI working.`,
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
