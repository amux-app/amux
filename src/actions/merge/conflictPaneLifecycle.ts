import type { MuxBasePane } from '../../types.js';
import {
  createConflictResolutionPane,
  disposeConflictResolutionPane,
  type ConflictResolutionPaneOptions,
} from '../../utils/conflictResolutionPane.js';
import type { ConflictMergeMetadata } from '../../types.js';
import { startConflictMonitoring } from '../../utils/conflictMonitor.js';
import {
  clearConflictMergeTransactionById,
  markConflictMergeResolvedAfterVerification,
  registerConflictMergeTransaction,
} from '../../utils/conflictMergeTransaction.js';
import type { ActionContext } from '../types.js';
import {
  disposeManagedConflictResolutionPane,
  registerManagedConflictPane,
  releaseManagedConflictPane,
} from './conflictPaneOwnership.js';

export interface ManagedConflictResolutionPaneOptions {
  context: ActionContext;
  sourcePaneId: string;
  paneOptions: ConflictResolutionPaneOptions;
  onResolved: (conflictPane: MuxBasePane) => void | Promise<void>;
  onAbandoned?: (reason: string, error?: string) => void | Promise<void>;
}

/**
 * Own the post-launch transaction: the pane is not considered created until
 * persistence, renderer notification, and identity-bound monitoring all
 * succeed. Every failure restores the exact pre-launch pane set and releases
 * the tmux, git-merge, and transcript resources.
 */
export async function launchManagedConflictResolutionPane(
  options: ManagedConflictResolutionPaneOptions,
): Promise<MuxBasePane> {
  const { context, onAbandoned, onResolved, paneOptions, sourcePaneId } = options;
  const originalPanes = [...context.panes];
  const creation = await createConflictResolutionPane(paneOptions);
  let transaction: ReturnType<typeof registerConflictMergeTransaction> | undefined;

  try {
    transaction = registerConflictMergeTransaction({
      id: `conflict-merge-${creation.pane.id}`,
      repoPath: creation.preparation.repoPath,
      mainRepoPath: paneOptions.mainRepoPath,
      sourceBranch: paneOptions.sourceBranch,
      targetBranch: paneOptions.targetBranch,
      sourceCommit: creation.preparation.sourceCommit,
      targetCommit: creation.preparation.targetCommit,
      sourcePaneId,
      conflictPaneId: creation.pane.id,
    });
    const conflictMerge: ConflictMergeMetadata = {
      conflictPaneId: transaction.conflictPaneId,
      mainRepoPath: transaction.mainRepoPath,
      repoPath: transaction.repoPath,
      sourceBranch: transaction.sourceBranch,
      sourceCommit: transaction.sourceCommit,
      sourcePaneId: transaction.sourcePaneId,
      targetBranch: transaction.targetBranch,
      targetCommit: transaction.targetCommit,
      transactionId: transaction.id,
    };
    const ownedCreation = {
      ...creation,
      pane: { ...creation.pane, conflictMerge },
    };
    await context.savePanes([...originalPanes, ownedCreation.pane]);
    await context.onPaneUpdate?.(ownedCreation.pane);
    const stopMonitoring = startConflictMonitoring({
      conflictPaneId: creation.pane.paneId,
      expectedCommits: {
        sourceCommit: creation.preparation.sourceCommit,
        targetCommit: creation.preparation.targetCommit,
      },
      onResolved: async () => {
        if (!transaction) throw new Error('Conflict merge transaction was not registered');
        if (!markConflictMergeResolvedAfterVerification(transaction.id)) {
          throw new Error('Conflict monitor reported an unverified merge resolution');
        }
        const disposal = await disposeManagedConflictResolutionPane(transaction, false, { retainRegistration: true });
        if (disposal && !disposal.success) {
          throw new Error(disposal.error || 'Conflict pane cleanup failed after resolution');
        }
        try {
          await onResolved(ownedCreation.pane);
        } finally {
          clearConflictMergeTransactionById(transaction.id);
          releaseManagedConflictPane(transaction.id);
        }
      },
      onAbandoned: async (reason) => {
        if (!transaction) throw new Error('Conflict merge transaction was not registered');
        const disposal = await disposeManagedConflictResolutionPane(transaction, true);
        if (disposal && !disposal.success) {
          await onAbandoned?.(reason, disposal.error || 'The merge could not be restored to a clean state');
          return;
        }
        await onAbandoned?.(reason);
      },
      repoPath: creation.preparation.repoPath,
    });
    registerManagedConflictPane(transaction, {
      context,
      creation: ownedCreation,
      stopMonitoring,
    });
    return ownedCreation.pane;
  } catch (error) {
    const rollbackErrors: unknown[] = [];

    try {
      await disposeConflictResolutionPane(creation);
      if (transaction) clearConflictMergeTransactionById(transaction.id);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }

    try {
      await context.savePanes(originalPanes);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }

    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `Conflict pane setup failed and rollback was incomplete: ${String(error)}`,
      );
    }
    throw error;
  }
}
