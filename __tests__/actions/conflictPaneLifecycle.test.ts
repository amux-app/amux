import { beforeEach, describe, expect, it, vi } from 'vitest';
import { launchManagedConflictResolutionPane } from '../../src/actions/merge/conflictPaneLifecycle.js';
import type { ActionContext } from '../../src/actions/types.js';
import type { MuxBasePane } from '../../src/types.js';
import {
  createConflictResolutionPane,
  disposeConflictResolutionPane,
} from '../../src/utils/conflictResolutionPane.js';
import { startConflictMonitoring } from '../../src/utils/conflictMonitor.js';

vi.mock('../../src/utils/conflictResolutionPane.js', () => ({
  createConflictResolutionPane: vi.fn(),
  disposeConflictResolutionPane: vi.fn(async () => undefined),
}));

vi.mock('../../src/utils/conflictMonitor.js', () => ({
  startConflictMonitoring: vi.fn(() => vi.fn()),
}));

const sourcePane: MuxBasePane = {
  id: 'source-pane',
  slug: 'feature',
  prompt: 'source',
  paneId: '%1',
  projectRoot: '/workspace/main-project',
  worktreePath: '/workspace/worktrees/feature',
};

const conflictPane: MuxBasePane = {
  id: 'conflict-pane',
  slug: 'merge-feature-into-main',
  prompt: 'resolve',
  paneId: '%9',
  projectRoot: '/workspace/main-project',
  worktreePath: '/workspace/worktrees/feature',
  agent: 'claude',
};

const creation = {
  pane: conflictPane,
  preparation: {
    repoPath: '/workspace/worktrees/feature',
    sourceCommit: 'source-commit',
    targetCommit: 'target-commit',
  },
};

function makeContext(): ActionContext {
  return {
    panes: [sourcePane],
    projectName: 'main-project',
    savePanes: vi.fn(async () => undefined),
    sessionName: 'muxbase-main-project',
    onPaneUpdate: vi.fn(),
  };
}

function lifecycleOptions(context: ActionContext) {
  return {
    context,
    sourcePaneId: sourcePane.id,
    paneOptions: {
      agent: 'claude' as const,
      projectRoot: '/workspace/main-project',
      sourceBranch: 'feature',
      sourceTmuxPaneId: '%1',
      targetBranch: 'main',
      targetRepoPath: '/workspace/worktrees/feature',
    },
    onResolved: vi.fn(),
  };
}

describe('launchManagedConflictResolutionPane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createConflictResolutionPane).mockResolvedValue(creation);
    vi.mocked(disposeConflictResolutionPane).mockResolvedValue(undefined);
    vi.mocked(startConflictMonitoring).mockReturnValue(vi.fn());
  });

  it('persists, announces, and monitors one fully prepared pane', async () => {
    const context = makeContext();
    const onResolved = vi.fn();

    const pane = await launchManagedConflictResolutionPane({
      ...lifecycleOptions(context),
      onResolved,
    });

    expect(pane).toMatchObject({ id: conflictPane.id, conflictMerge: expect.objectContaining({
      conflictPaneId: conflictPane.id,
      repoPath: creation.preparation.repoPath,
      sourceCommit: creation.preparation.sourceCommit,
      sourcePaneId: sourcePane.id,
      targetCommit: creation.preparation.targetCommit,
    }) });
    expect(context.savePanes).toHaveBeenCalledWith([
      sourcePane,
      expect.objectContaining({ id: conflictPane.id, conflictMerge: expect.any(Object) }),
    ]);
    expect(context.onPaneUpdate).toHaveBeenCalledWith(expect.objectContaining({
      id: conflictPane.id,
      conflictMerge: expect.any(Object),
    }));
    expect(startConflictMonitoring).toHaveBeenCalledWith({
      conflictPaneId: '%9',
      expectedCommits: {
        sourceCommit: 'source-commit',
        targetCommit: 'target-commit',
      },
      onResolved: expect.any(Function),
      onAbandoned: expect.any(Function),
      repoPath: '/workspace/worktrees/feature',
    });
    const registeredCallback = vi.mocked(startConflictMonitoring).mock.calls[0][0].onResolved;
    await registeredCallback();
    expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({
      id: conflictPane.id,
      conflictMerge: expect.any(Object),
    }));
  });

  it('rolls back the pane, merge, and state when the initial save fails', async () => {
    const context = makeContext();
    vi.mocked(context.savePanes)
      .mockRejectedValueOnce(new Error('save failed'))
      .mockResolvedValueOnce(undefined);

    await expect(launchManagedConflictResolutionPane(lifecycleOptions(context)))
      .rejects.toThrow('save failed');

    expect(disposeConflictResolutionPane).toHaveBeenCalledWith(creation);
    expect(context.savePanes).toHaveBeenLastCalledWith([sourcePane]);
    expect(startConflictMonitoring).not.toHaveBeenCalled();
  });

  it('rolls back persisted state when pane notification fails', async () => {
    const context = makeContext();
    vi.mocked(context.onPaneUpdate!).mockImplementation(() => {
      throw new Error('update failed');
    });

    await expect(launchManagedConflictResolutionPane(lifecycleOptions(context)))
      .rejects.toThrow('update failed');

    expect(disposeConflictResolutionPane).toHaveBeenCalledWith(creation);
    expect(context.savePanes).toHaveBeenNthCalledWith(1, [
      sourcePane,
      expect.objectContaining({ id: conflictPane.id, conflictMerge: expect.any(Object) }),
    ]);
    expect(context.savePanes).toHaveBeenNthCalledWith(2, [sourcePane]);
    expect(startConflictMonitoring).not.toHaveBeenCalled();
  });

  it('stops and rolls back everything when monitor registration fails', async () => {
    const context = makeContext();
    vi.mocked(startConflictMonitoring).mockImplementation(() => {
      throw new Error('monitor failed');
    });

    await expect(launchManagedConflictResolutionPane(lifecycleOptions(context)))
      .rejects.toThrow('monitor failed');

    expect(disposeConflictResolutionPane).toHaveBeenCalledWith(creation);
    expect(context.savePanes).toHaveBeenNthCalledWith(2, [sourcePane]);
  });
});
