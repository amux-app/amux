import { TmuxService } from '../../services/TmuxService.js';
import { StateManager } from '../../shared/StateManager.js';
import type { ActionContext } from '../types.js';
import type { ConflictResolutionPaneCreation } from '../../utils/conflictResolutionPane.js';
import {
  abortConflictMergeTransaction,
  clearConflictMergeTransactionById,
  type ConflictMergeTransaction,
} from '../../utils/conflictMergeTransaction.js';
import { removePaneTranscript } from '../../utils/tmuxTranscript.js';

interface ManagedConflictPaneOwner {
  context: ActionContext;
  creation: ConflictResolutionPaneCreation;
  stopMonitoring: () => void;
  disposed: boolean;
  disposal?: Promise<{ success: boolean; error?: string }>;
}

const owners = new Map<string, ManagedConflictPaneOwner>();

export function registerManagedConflictPane(
  transaction: ConflictMergeTransaction,
  owner: Omit<ManagedConflictPaneOwner, 'disposed' | 'disposal'>,
): void {
  if (owners.has(transaction.id)) return;
  owners.set(transaction.id, { ...owner, disposed: false });
}

export function hasManagedConflictPane(transactionId: string): boolean {
  return owners.has(transactionId);
}

export function releaseManagedConflictPane(transactionId: string): void {
  owners.delete(transactionId);
}

export async function disposeManagedConflictResolutionPane(
  transaction: ConflictMergeTransaction,
  abortMerge: boolean,
  options: { retainRegistration?: boolean } = {},
): Promise<{ success: boolean; error?: string } | undefined> {
  const owner = owners.get(transaction.id);
  if (!owner) return undefined;
  if (owner.disposal) return owner.disposal;

  owner.disposal = (async () => {
    if (owner.disposed) return { success: true };
    owner.disposed = true;
    owner.stopMonitoring();

    if (abortMerge && transaction.state === 'active') {
      const abortResult = await abortConflictMergeTransaction(transaction, { retainRegistration: true });
      if (!abortResult.success) {
        owner.disposed = false;
        owner.disposal = undefined;
        return abortResult;
      }
    }

    try {
      const tmuxService = TmuxService.getInstance();
      if (await tmuxService.paneExists(owner.creation.pane.paneId)) {
        await tmuxService.killPane(owner.creation.pane.paneId);
      }
      const stateManager = StateManager.getInstance();
      const currentPanes = stateManager.getPanes();
      const remainingPanes = currentPanes.filter((pane) => (
        pane.id !== owner.creation.pane.id
        && pane.conflictMerge?.transactionId !== transaction.id
      ));
      await owner.context.savePanes(remainingPanes);
      if (typeof stateManager.updatePanes === 'function') {
        stateManager.updatePanes(remainingPanes);
      }
      removePaneTranscript(owner.creation.pane.terminalTranscriptPath);
      if (!options.retainRegistration) {
        clearConflictMergeTransactionById(transaction.id);
        owners.delete(transaction.id);
      }
      return { success: true };
    } catch (error) {
      owner.disposed = false;
      owner.disposal = undefined;
      return {
        success: false,
        error: `Conflict pane cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  })();

  return owner.disposal;
}
