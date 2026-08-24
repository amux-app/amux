import type { AumxPane, PreservedWorktree } from 'aumx/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({
  createWorktreeForPane: vi.fn(),
  inspectPreservedWorktreeAsync: vi.fn(),
  listPreservedWorktreesAsync: vi.fn(),
  removePreservedWorktreeAsync: vi.fn(),
  triggerHook: vi.fn(),
}));

vi.mock('aumx/core', async () => {
  const actual = await vi.importActual<typeof import('aumx/core')>('aumx/core');
  return {
    ...actual,
    createWorktreeForPane: core.createWorktreeForPane,
    inspectPreservedWorktreeAsync: core.inspectPreservedWorktreeAsync,
    listPreservedWorktreesAsync: core.listPreservedWorktreesAsync,
    removePreservedWorktreeAsync: core.removePreservedWorktreeAsync,
    triggerHook: core.triggerHook,
  };
});

import { WorktreeWorkflow } from '../../src/main/services/bridge/WorktreeWorkflow.js';

function makePane(overrides: Partial<AumxPane> = {}): AumxPane {
  return {
    id: 'pane',
    paneId: '%1',
    projectRoot: '/project',
    slug: 'feature',
    ...overrides,
  };
}

function makeWorktree(overrides: Partial<PreservedWorktree> = {}): PreservedWorktree {
  return {
    branch: 'feature-branch',
    gitStatus: 'clean',
    lastModified: new Date(1000),
    path: '/project/.worktrees/feature',
    registration: 'registered',
    slug: 'feature',
    ...overrides,
  };
}

function makeHarness(initialPanes: AumxPane[] = [makePane()], active = true) {
  let panes = initialPanes;
  const dependencies = {
    ensureValidControlPaneId: vi.fn(async () => undefined),
    getPane: vi.fn((paneId: string) => panes.find((pane) => pane.id === paneId)),
    getPanes: vi.fn(() => panes),
    getProjectName: vi.fn(() => 'project'),
    getProjectRoot: vi.fn(() => '/project'),
    getSessionName: vi.fn(() => 'aumx-project'),
    hasActiveProjectContext: vi.fn(() => active),
    killPane: vi.fn(async () => undefined),
    newWindowPane: vi.fn(async () => '%9'),
    replacePanesBestEffort: vi.fn((next: AumxPane[]) => { panes = next; }),
    resumePaneWatcher: vi.fn(),
    saveReopenedPane: vi.fn((pane: AumxPane) => { panes = [...panes, pane]; }),
    sendProgress: vi.fn(),
    sendShellCommand: vi.fn(async () => undefined),
    sendTmuxKeys: vi.fn(async () => undefined),
    sendToast: vi.fn(),
    setPaneTitleSafe: vi.fn(async () => undefined),
    setupTranscriptPiping: vi.fn(async () => '/logs/reopened.log'),
    startPaneMonitor: vi.fn(async () => undefined),
    suspendPaneWatcher: vi.fn(),
  };
  return {
    dependencies,
    getPanes: () => panes,
    workflow: new WorktreeWorkflow(dependencies),
  };
}

describe('WorktreeWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    core.triggerHook.mockResolvedValue(undefined);
  });

  it('rejects listing without an active project context', async () => {
    const harness = makeHarness([], false);

    await expect(harness.workflow.list()).resolves.toEqual({
      success: false,
      worktrees: [],
      error: 'Choose or create a project before starting panes.',
    });
    expect(core.listPreservedWorktreesAsync).not.toHaveBeenCalled();
  });

  it('maps preserved worktrees to the IPC representation', async () => {
    const harness = makeHarness();
    core.listPreservedWorktreesAsync.mockResolvedValue([makeWorktree()]);

    await expect(harness.workflow.list()).resolves.toMatchObject({
      success: true,
      worktrees: [{ lastModifiedMs: 1000, path: '/project/.worktrees/feature' }],
    });
  });

  it('inspects preserved worktrees and normalizes inspection failures', async () => {
    const harness = makeHarness();
    core.inspectPreservedWorktreeAsync.mockResolvedValueOnce(makeWorktree());

    await expect(harness.workflow.inspect('/project/.worktrees/feature')).resolves.toMatchObject({
      success: true,
      worktree: { branch: 'feature-branch', lastModifiedMs: 1000 },
    });

    core.inspectPreservedWorktreeAsync.mockRejectedValueOnce(new Error('worktree disappeared'));
    await expect(harness.workflow.inspect('/project/.worktrees/missing')).resolves.toEqual({
      success: false,
      error: 'worktree disappeared',
    });
  });

  it('removes a preserved worktree and releases its mutation lock', async () => {
    const harness = makeHarness();
    core.removePreservedWorktreeAsync.mockResolvedValue(undefined);
    const expectedState = {
      branch: 'feature-branch',
      gitStatus: 'clean' as const,
      registration: 'registered' as const,
    };

    await expect(harness.workflow.remove('/project/wt', false, expectedState))
      .resolves.toEqual({ success: true });
    await expect(harness.workflow.remove('/project/wt', false, expectedState))
      .resolves.toEqual({ success: true });

    expect(core.removePreservedWorktreeAsync).toHaveBeenCalledTimes(2);
    expect(core.removePreservedWorktreeAsync).toHaveBeenCalledWith({
      activeWorktreePaths: [],
      allowDataLoss: false,
      expectedState,
      projectRoot: '/project',
      worktreePath: '/project/wt',
    });
    expect(harness.dependencies.sendToast)
      .toHaveBeenCalledWith('Removed preserved worktree "wt"', 'success');
  });

  it('releases the removal lock and reports removal failures', async () => {
    const harness = makeHarness();
    core.removePreservedWorktreeAsync
      .mockRejectedValueOnce(new Error('worktree is dirty'))
      .mockResolvedValueOnce(undefined);
    const expectedState = {
      branch: 'feature-branch',
      gitStatus: 'dirty' as const,
      registration: 'registered' as const,
    };

    await expect(harness.workflow.remove('/project/wt', false, expectedState)).resolves.toEqual({
      success: false,
      error: 'worktree is dirty',
    });
    await expect(harness.workflow.remove('/project/wt', true, expectedState))
      .resolves.toEqual({ success: true });
  });

  it('creates pane worktree metadata and changes the live tmux directory', async () => {
    const harness = makeHarness();
    core.createWorktreeForPane.mockResolvedValue({
      branchName: 'feature-branch',
      worktreePath: '/project/.worktrees/feature',
    });

    await expect(harness.workflow.createForPane('pane')).resolves.toEqual({
      success: true,
      branchName: 'feature-branch',
      worktreePath: '/project/.worktrees/feature',
    });
    expect(harness.getPanes()[0]).toMatchObject({ branchName: 'feature-branch' });
    expect(harness.dependencies.sendShellCommand)
      .toHaveBeenCalledWith('%1', "cd '/project/.worktrees/feature'");
    expect(harness.dependencies.sendTmuxKeys).toHaveBeenCalledWith('%1', 'Enter');
  });

  it('returns an already attached worktree without inspecting or mutating it', async () => {
    const pane = makePane({ branchName: 'feature-branch', worktreePath: '/project/wt' });
    const harness = makeHarness([pane]);

    await expect(harness.workflow.attachToPane('pane', '/project/wt')).resolves.toEqual({
      success: true,
      branchName: 'feature-branch',
      worktreePath: '/project/wt',
    });
    expect(core.inspectPreservedWorktreeAsync).not.toHaveBeenCalled();
  });

  it('keeps a pre-existing mutation lock when rejecting duplicate removal', async () => {
    const harness = makeHarness();
    const mutationPaths = new Set(['/project/wt']);
    const workflow = new WorktreeWorkflow(harness.dependencies, mutationPaths);

    await expect(workflow.remove('/project/wt', false, {
      branch: 'feature',
      gitStatus: 'clean',
      registration: 'registered',
    })).resolves.toEqual({
      success: false,
      error: 'Worktree is already being modified',
    });
    expect(mutationPaths.has('/project/wt')).toBe(true);
    expect(core.removePreservedWorktreeAsync).not.toHaveBeenCalled();
  });

  it('restores watcher and progress state when reopening fails after suspension', async () => {
    const harness = makeHarness();
    core.inspectPreservedWorktreeAsync.mockResolvedValue(makeWorktree());
    harness.dependencies.newWindowPane.mockRejectedValue(new Error('tmux unavailable'));

    await expect(harness.workflow.reopen('/project/.worktrees/feature')).resolves.toEqual({
      success: false,
      error: 'tmux unavailable',
    });
    expect(harness.dependencies.suspendPaneWatcher).toHaveBeenCalledOnce();
    expect(harness.dependencies.resumePaneWatcher).toHaveBeenCalledOnce();
    expect(harness.dependencies.sendProgress)
      .toHaveBeenLastCalledWith('Reopening worktree...', false);
  });

  it('reopens an inspected worktree and restores watcher state after success', async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness();
      core.inspectPreservedWorktreeAsync.mockResolvedValue(makeWorktree());

      const resultPromise = harness.workflow.reopen('/project/.worktrees/feature');
      await vi.runAllTimersAsync();

      await expect(resultPromise).resolves.toMatchObject({
        success: true,
        pane: {
          branchName: 'feature-branch',
          paneId: '%9',
          terminalTranscriptPath: '/logs/reopened.log',
          type: 'worktree',
          worktreePath: '/project/.worktrees/feature',
        },
      });
      expect(harness.dependencies.saveReopenedPane).toHaveBeenCalledOnce();
      expect(harness.dependencies.startPaneMonitor).toHaveBeenCalledOnce();
      expect(harness.dependencies.resumePaneWatcher).toHaveBeenCalledOnce();
      expect(harness.dependencies.sendProgress)
        .toHaveBeenLastCalledWith('Reopening worktree...', false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('kills an uncommitted reopened pane when post-allocation setup fails', async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness();
      core.inspectPreservedWorktreeAsync.mockResolvedValue(makeWorktree());
      harness.dependencies.setupTranscriptPiping.mockRejectedValue(new Error('pipe failed'));

      const resultPromise = harness.workflow.reopen('/project/.worktrees/feature');
      await vi.runAllTimersAsync();

      await expect(resultPromise).resolves.toEqual({ success: false, error: 'pipe failed' });
      expect(harness.dependencies.killPane).toHaveBeenCalledWith('%9');
      expect(harness.dependencies.saveReopenedPane).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports success and retains a reopened pane when monitor refresh fails after persistence', async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness();
      core.inspectPreservedWorktreeAsync.mockResolvedValue(makeWorktree());
      harness.dependencies.startPaneMonitor.mockRejectedValue(new Error('monitor unavailable'));

      const resultPromise = harness.workflow.reopen('/project/.worktrees/feature');
      await vi.runAllTimersAsync();

      await expect(resultPromise).resolves.toMatchObject({
        success: true,
        pane: { paneId: '%9', type: 'worktree' },
      });
      expect(harness.dependencies.killPane).not.toHaveBeenCalled();
      expect(harness.dependencies.saveReopenedPane).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('attaches an inspected worktree even when the live pane cannot change directory', async () => {
    const harness = makeHarness();
    core.inspectPreservedWorktreeAsync.mockResolvedValue(makeWorktree());
    harness.dependencies.sendShellCommand.mockRejectedValue(new Error('pane exited'));

    await expect(harness.workflow.attachToPane('pane', '/project/.worktrees/feature'))
      .resolves.toEqual({
        success: true,
        branchName: 'feature-branch',
        worktreePath: '/project/.worktrees/feature',
      });
    expect(harness.getPanes()[0]).toMatchObject({
      branchName: 'feature-branch',
      worktreePath: '/project/.worktrees/feature',
    });
    expect(harness.dependencies.sendToast)
      .toHaveBeenCalledWith('Attached worktree "feature" to "feature"', 'success');
  });
});
