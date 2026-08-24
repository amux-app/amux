import { beforeEach, describe, expect, it, vi } from 'vitest';
import { launchManagedConflictResolutionPane } from '../../src/actions/merge/conflictPaneLifecycle.js';
import { executeMultiMerge } from '../../src/actions/merge/multiMergeOrchestrator.js';
import type { MergeQueueItem } from '../../src/actions/merge/types.js';
import type { ActionContext } from '../../src/actions/types.js';
import type { AumxPane } from '../../src/types.js';
import { getAvailableAgents } from '../../src/utils/agentDetection.js';

const killPaneMock = vi.hoisted(() => vi.fn());
const mergeWorktreeIntoMainMock = vi.hoisted(() => vi.fn());
const triggerHookMock = vi.hoisted(() => vi.fn());
const statePanes = vi.hoisted(() => [] as AumxPane[]);

vi.mock('../../src/actions/merge/conflictPaneLifecycle.js', () => ({
  launchManagedConflictResolutionPane: vi.fn(),
}));

vi.mock('../../src/services/LogService.js', () => ({
  LogService: {
    getInstance: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    }),
  },
}));

vi.mock('../../src/shared/StateManager.js', () => ({
  StateManager: { getInstance: () => ({ getPanes: vi.fn(() => statePanes) }) },
}));

vi.mock('../../src/services/TmuxService.js', () => ({
  TmuxService: { getInstance: () => ({ killPane: killPaneMock }) },
}));

vi.mock('../../src/utils/gitMergeOps.js', () => ({
  abortMerge: vi.fn(),
  mergeMainIntoWorktree: vi.fn(),
  mergeWorktreeIntoMain: mergeWorktreeIntoMainMock,
}));

vi.mock('../../src/utils/hooks.js', () => ({
  triggerHook: triggerHookMock,
}));

vi.mock('../../src/utils/agentDetection.js', () => ({
  getAvailableAgents: vi.fn(),
}));

const sourcePane: AumxPane = {
  id: 'source',
  slug: 'feature',
  prompt: 'feature',
  paneId: '%1',
  projectRoot: '/workspace/main-project',
  worktreePath: '/workspace/worktrees/feature',
};

const conflictPane: AumxPane = {
  id: 'conflict',
  slug: 'merge-nested-feature-into-main',
  prompt: 'resolve',
  paneId: '%9',
  projectRoot: '/workspace/main-project',
  worktreePath: '/workspace/worktrees/feature/packages/nested',
  agent: 'claude',
};

function makeQueue(): MergeQueueItem[] {
  return [{
    status: 'pending',
    validation: {
      canMerge: false,
      issues: [{
        canAutoResolve: false,
        files: ['src/conflicted.ts'],
        message: 'conflict',
        type: 'merge_conflict',
      }],
      mainBranch: 'main',
      worktreeBranch: 'nested-feature',
    },
    worktree: {
      branch: 'nested-feature',
      depth: 1,
      isRoot: false,
      mainBranch: 'main',
      parentRepoPath: '/workspace/main-project/packages/nested',
      relativePath: 'packages/nested',
      repoName: 'nested',
      worktreePath: '/workspace/worktrees/feature/packages/nested',
    },
  }];
}

function makeSecondQueueItem(): MergeQueueItem {
  return {
    status: 'pending',
    validation: {
      canMerge: true,
      issues: [],
      mainBranch: 'main',
      worktreeBranch: 'other-feature',
    },
    worktree: {
      branch: 'other-feature',
      depth: 1,
      isRoot: false,
      mainBranch: 'main',
      parentRepoPath: '/workspace/main-project',
      relativePath: 'other',
      repoName: 'other',
      worktreePath: '/workspace/worktrees/other',
    },
  };
}

function makeContext(): ActionContext {
  return {
    panes: [sourcePane],
    projectName: 'main-project',
    savePanes: vi.fn(),
    sessionName: 'aumx-main-project',
    terminalTranscriptDir: '/logs/terminal',
    onActionResult: vi.fn(),
  };
}

async function selectAiMerge(context: ActionContext, queue: MergeQueueItem[] = makeQueue()) {
  const confirmation = await executeMultiMerge(sourcePane, context, queue);
  const conflictChoice = await confirmation.onConfirm!();
  return conflictChoice.onSelect!('ai_merge');
}

describe('multi-merge conflict pane lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statePanes.splice(0, statePanes.length, sourcePane, conflictPane);
    killPaneMock.mockResolvedValue(undefined);
    mergeWorktreeIntoMainMock.mockResolvedValue({ success: true });
    triggerHookMock.mockResolvedValue(undefined);
    vi.mocked(getAvailableAgents).mockResolvedValue(['claude']);
    vi.mocked(launchManagedConflictResolutionPane).mockResolvedValue(conflictPane);
  });

  it('uses the main project profile for a nested worktree conflict pane', async () => {
    const context = makeContext();

    const result = await selectAiMerge(context);

    expect(result).toMatchObject({ type: 'navigation', targetPaneId: 'conflict' });
    expect(launchManagedConflictResolutionPane).toHaveBeenCalledWith({
      context,
      sourcePaneId: sourcePane.id,
      paneOptions: expect.objectContaining({
        agent: 'claude',
        otlpEndpoint: undefined,
        projectRoot: '/workspace/main-project',
        sourceBranch: 'nested-feature',
        sourceTmuxPaneId: '%1',
        targetBranch: 'main',
        targetRepoPath: '/workspace/worktrees/feature/packages/nested',
        terminalTranscriptDir: '/logs/terminal',
      }),
      onResolved: expect.any(Function),
      onAbandoned: expect.any(Function),
    });
  });

  it('returns an error after shared lifecycle rollback fails setup', async () => {
    vi.mocked(launchManagedConflictResolutionPane).mockRejectedValueOnce(
      new Error('save failed; resources rolled back'),
    );

    const result = await selectAiMerge(makeContext());

    expect(result).toMatchObject({
      type: 'error',
      message: expect.stringContaining('resources rolled back'),
    });
  });

  it('records success only after cleanup and the final merge, then delivers the summary', async () => {
    const context = makeContext();
    const queue = makeQueue();
    const result = await selectAiMerge(context, queue);
    const lifecycle = vi.mocked(launchManagedConflictResolutionPane).mock.calls[0]?.[0];

    await lifecycle.onResolved(conflictPane);

    expect(killPaneMock).toHaveBeenCalledWith('%9');
    expect(context.savePanes).toHaveBeenCalledWith([sourcePane]);
    expect(mergeWorktreeIntoMainMock).toHaveBeenCalledWith('/workspace/main-project/packages/nested', 'nested-feature');
    expect(triggerHookMock).toHaveBeenCalledTimes(1);
    expect(context.onActionResult).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Completed: 1'),
      title: 'Multi-Merge Complete',
    }));
    expect(queue[0].status).toBe('completed');
    expect(result).toMatchObject({ type: 'navigation', targetPaneId: 'conflict' });
  });

  it.each([
    ['kill pane', 'kill', 'kill failed'],
    ['save panes', 'save', 'save failed'],
    ['final merge', 'merge', 'merge failed'],
    ['thrown final merge', 'throw', 'merge threw'],
  ] as const)('records a visible failure when %s fails', async (_name, failure, expectedError) => {
    const context = makeContext();
    if (failure === 'save') {
      vi.mocked(context.savePanes).mockRejectedValue(new Error('save failed'));
    } else if (failure === 'kill') {
      killPaneMock.mockRejectedValue(new Error('kill failed'));
    } else if (failure === 'merge') {
      mergeWorktreeIntoMainMock.mockResolvedValue({ error: 'merge failed', success: false });
    } else {
      mergeWorktreeIntoMainMock.mockRejectedValue(new Error('merge threw'));
    }
    await selectAiMerge(context);
    const lifecycle = vi.mocked(launchManagedConflictResolutionPane).mock.calls[0]?.[0];

    await lifecycle.onResolved(conflictPane);

    expect(context.onActionResult).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining(expectedError),
      title: 'Multi-Merge Partial',
    }));
    expect(mergeWorktreeIntoMainMock).toHaveBeenCalledTimes(failure === 'merge' || failure === 'throw' ? 1 : 0);
    expect(triggerHookMock).not.toHaveBeenCalled();
  });

  it('records a resolved callback exactly once even if the monitor reports it twice', async () => {
    const context = makeContext();
    await selectAiMerge(context);
    const lifecycle = vi.mocked(launchManagedConflictResolutionPane).mock.calls[0]?.[0];

    await lifecycle.onResolved(conflictPane);
    await lifecycle.onResolved(conflictPane);

    expect(mergeWorktreeIntoMainMock).toHaveBeenCalledTimes(1);
    expect(context.onActionResult).toHaveBeenCalledTimes(1);
  });

  it('delivers the next item instead of stalling after a successful conflict resolution', async () => {
    const context = makeContext();
    const queue = [...makeQueue(), makeSecondQueueItem()];
    await selectAiMerge(context, queue);
    const lifecycle = vi.mocked(launchManagedConflictResolutionPane).mock.calls[0]?.[0];

    await lifecycle.onResolved(conflictPane);

    expect(context.onActionResult).toHaveBeenCalledWith(expect.objectContaining({
      type: 'confirm',
      title: '[2/2] other (other-feature) - other',
    }));
    expect(queue[0].status).toBe('completed');
  });
});
