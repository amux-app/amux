/**
 * Conflict Monitor - Monitors a pane for merge conflict resolution completion
 *
 * When conflicts are resolved and merge commit is made, automatically:
 * 1. Closes the conflict resolution pane
 * 2. Triggers cleanup flow
 */

import { LogService } from '../services/LogService.js';
import { TmuxService } from '../services/TmuxService.js';
import { execFileAsync } from './execAsync.js';

export interface ConflictMonitorOptions {
  conflictPaneId: string;  // tmux pane ID to monitor
  repoPath: string;        // Repository path to check git status
  expectedCommits: ExpectedConflictCommits;
  onResolved: () => void | Promise<void>;  // Callback when conflicts are resolved
  onAbandoned?: (reason: string) => void | Promise<void>;
  checkIntervalMs?: number;
  maxChecks?: number;
}

export interface ExpectedConflictCommits {
  sourceCommit: string;
  targetCommit: string;
}

/**
 * Start monitoring a pane for conflict resolution completion
 * Returns a cleanup function to stop monitoring
 */
export function startConflictMonitoring(options: ConflictMonitorOptions): () => void {
  const {
    conflictPaneId,
    expectedCommits,
    repoPath,
    onResolved,
    onAbandoned,
    checkIntervalMs = 2000, // Check every 2 seconds
    maxChecks,
  } = options;

  if (!expectedCommits?.sourceCommit || !expectedCommits.targetCommit) {
    throw new Error('Conflict monitoring requires the prepared commit identities');
  }

  const tmuxService = TmuxService.getInstance();
  let checkCount = 0;
  let checkInFlight = false;
  let stopped = false;
  let abandonmentDelivered = false;

  const abandon = async (reason: string): Promise<void> => {
    if (abandonmentDelivered) return;
    abandonmentDelivered = true;
    await onAbandoned?.(reason);
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(checkInterval);
  };

  const checkInterval = setInterval(async () => {
    if (stopped || checkInFlight) return;
    if (maxChecks !== undefined && checkCount >= maxChecks) {
      stop();
      LogService.getInstance().warn(
        `Conflict monitoring stopped after ${maxChecks} checks without abandoning the active merge`,
        'conflictMonitor',
      );
      return;
    }

    checkInFlight = true;
    checkCount++;

    try {
      // Check if pane still exists
      const paneExists = await checkPaneExists(conflictPaneId, tmuxService);
      if (stopped) return;
      if (!paneExists) {
        // Pane was manually closed, stop monitoring
        stop();
        await abandon('Conflict resolution pane disappeared before the merge was completed');
        return;
      }

      // Check if conflicts are resolved
      const conflictsResolved = await isConflictResolutionCommitted(repoPath, expectedCommits);

      if (conflictsResolved) {
        // Stop before awaiting user code so no queued timer can deliver the
        // resolution twice.
        stop();
        await onResolved();
      }
    } catch (error) {
      LogService.getInstance().warn(`Conflict monitor check failed: ${error instanceof Error ? error.message : String(error)}`, 'conflictMonitor');
    } finally {
      checkInFlight = false;
    }
  }, checkIntervalMs);

  // Return cleanup function
  return stop;
}

/**
 * Check if a tmux pane exists
 */
async function checkPaneExists(paneId: string, tmuxService: TmuxService): Promise<boolean> {
  return await tmuxService.paneExists(paneId);
}

/**
 * Check if merge conflicts are resolved in a repository
 * Returns true if:
 * - MERGE_HEAD is gone and no unmerged index entries remain
 * - HEAD moved to a merge commit containing both commits captured at preparation
 */
export async function isConflictResolutionCommitted(
  repoPath: string,
  expectedCommits: ExpectedConflictCommits,
): Promise<boolean> {
  if (!expectedCommits.sourceCommit || !expectedCommits.targetCommit) return false;

  // A successful commit removes MERGE_HEAD. Its continued presence means the
  // index is still in the prepared merge transaction.
  if (await runGit(repoPath, ['rev-parse', '--verify', '-q', 'MERGE_HEAD']) !== null) {
    return false;
  }

  const unresolvedFiles = await runGit(
    repoPath,
    ['diff', '--name-only', '--diff-filter=U', '--'],
  );
  if (unresolvedFiles === null || unresolvedFiles.length > 0) return false;

  const headWithParents = await runGit(repoPath, ['rev-list', '--parents', '-n', '1', 'HEAD']);
  if (headWithParents === null) return false;

  const [head, ...parents] = headWithParents.split(/\s+/);
  return head !== expectedCommits.sourceCommit
    && parents.length >= 2
    && parents.includes(expectedCommits.sourceCommit)
    && parents.includes(expectedCommits.targetCommit);
}

async function runGit(repoPath: string, args: string[]): Promise<string | null> {
  try {
    return await execFileAsync('git', args, {
      cwd: repoPath,
    });
  } catch {
    return null;
  }
}
