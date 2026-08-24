import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disposeManagedConflictResolutionPane,
  registerManagedConflictPane,
} from '../../src/actions/merge/conflictPaneOwnership.js';
import type { ActionContext } from '../../src/actions/types.js';
import type { ConflictResolutionPaneCreation } from '../../src/utils/conflictResolutionPane.js';
import type { ConflictMergeTransaction } from '../../src/utils/conflictMergeTransaction.js';

const tmux = vi.hoisted(() => ({
  killPane: vi.fn(async () => undefined),
  paneExists: vi.fn(async () => true),
}));
const state = vi.hoisted(() => ({
  getPanes: vi.fn(),
  updatePanes: vi.fn(),
}));
const abortTransaction = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const clearTransaction = vi.hoisted(() => vi.fn());
const removeTranscript = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/TmuxService.js', () => ({
  TmuxService: { getInstance: () => tmux },
}));
vi.mock('../../src/shared/StateManager.js', () => ({
  StateManager: { getInstance: () => state },
}));
vi.mock('../../src/utils/conflictMergeTransaction.js', () => ({
  abortConflictMergeTransaction: abortTransaction,
  clearConflictMergeTransactionById: clearTransaction,
}));
vi.mock('../../src/utils/tmuxTranscript.js', () => ({
  removePaneTranscript: removeTranscript,
}));

const transaction: ConflictMergeTransaction = {
  conflictPaneId: 'conflict',
  id: 'transaction-1',
  mainRepoPath: '/workspace/main',
  repoPath: '/workspace/worktree',
  sourceBranch: 'feature',
  sourceCommit: 'source',
  sourcePaneId: 'source',
  state: 'active',
  targetBranch: 'main',
  targetCommit: 'target',
};

const creation = {
  pane: {
    id: 'conflict',
    paneId: '%9',
    projectRoot: '/workspace/main',
    prompt: 'resolve',
    slug: 'merge-feature-into-main',
  },
  preparation: {
    repoPath: '/workspace/worktree',
    sourceCommit: 'source',
    targetCommit: 'target',
  },
} as ConflictResolutionPaneCreation;

describe('managed conflict pane ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.getPanes.mockReturnValue([
      { id: 'source', paneId: '%1', prompt: 'source', slug: 'source' },
      creation.pane,
    ]);
  });

  it('disposes active merge resources exactly once under concurrent close paths', async () => {
    const stopMonitoring = vi.fn();
    const savePanes = vi.fn(async () => undefined);
    const context: ActionContext = {
      panes: [],
      projectName: 'main',
      savePanes,
      sessionName: 'aumx-main',
    };
    registerManagedConflictPane(transaction, { context, creation, stopMonitoring });

    const [first, second] = await Promise.all([
      disposeManagedConflictResolutionPane(transaction, true),
      disposeManagedConflictResolutionPane(transaction, true),
    ]);

    expect(first).toEqual({ success: true });
    expect(second).toEqual({ success: true });
    expect(stopMonitoring).toHaveBeenCalledTimes(1);
    expect(abortTransaction).toHaveBeenCalledTimes(1);
    expect(clearTransaction).toHaveBeenCalledWith(transaction.id);
    expect(tmux.killPane).toHaveBeenCalledTimes(1);
    expect(savePanes).toHaveBeenCalledWith([{ id: 'source', paneId: '%1', prompt: 'source', slug: 'source' }]);
    expect(state.updatePanes).toHaveBeenCalledWith([
      { id: 'source', paneId: '%1', prompt: 'source', slug: 'source' },
    ]);
    expect(removeTranscript).toHaveBeenCalledWith(undefined);
  });
});
