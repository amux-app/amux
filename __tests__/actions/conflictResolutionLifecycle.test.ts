import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConflictResolutionPaneForMerge } from '../../src/actions/merge/conflictResolution.js';
import { launchManagedConflictResolutionPane } from '../../src/actions/merge/conflictPaneLifecycle.js';
import type { ActionContext } from '../../src/actions/types.js';
import type { AumxPane } from '../../src/types.js';
import { getAvailableAgents } from '../../src/utils/agentDetection.js';

vi.mock('../../src/actions/merge/conflictPaneLifecycle.js', () => ({
  launchManagedConflictResolutionPane: vi.fn(),
}));

vi.mock('../../src/actions/merge/mergeExecution.js', () => ({
  executeMerge: vi.fn(),
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

vi.mock('../../src/services/TmuxService.js', () => ({
  TmuxService: { getInstance: () => ({ killPane: vi.fn() }) },
}));

vi.mock('../../src/shared/StateManager.js', () => ({
  StateManager: { getInstance: () => ({ getPanes: vi.fn(() => []) }) },
}));

vi.mock('../../src/utils/agentDetection.js', () => ({
  getAvailableAgents: vi.fn(),
}));

vi.mock('../../src/utils/git.js', () => ({
  getPaneBranchName: vi.fn(() => 'feature'),
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
  slug: 'merge-feature-into-main',
  prompt: 'resolve',
  paneId: '%9',
  projectRoot: '/workspace/main-project',
  worktreePath: '/workspace/worktrees/feature',
  agent: 'claude',
};

function makeContext(): ActionContext {
  return {
    panes: [sourcePane],
    projectName: 'main-project',
    savePanes: vi.fn(),
    sessionName: 'aumx-main-project',
    terminalTranscriptDir: '/logs/terminal',
  };
}

describe('single-merge conflict pane lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAvailableAgents).mockResolvedValue(['claude']);
    vi.mocked(launchManagedConflictResolutionPane).mockResolvedValue(conflictPane);
  });

  it('uses main-project settings while launching and monitoring the worktree', async () => {
    const context = makeContext();

    const result = await createConflictResolutionPaneForMerge(
      sourcePane,
      context,
      'main',
      '/workspace/main-project',
    );

    expect(result).toMatchObject({ type: 'navigation', targetPaneId: 'conflict' });
    expect(launchManagedConflictResolutionPane).toHaveBeenCalledWith({
      context,
      sourcePaneId: sourcePane.id,
      paneOptions: expect.objectContaining({
        agent: 'claude',
        mainRepoPath: '/workspace/main-project',
        otlpEndpoint: undefined,
        projectRoot: '/workspace/main-project',
        sourceBranch: 'feature',
        sourceTmuxPaneId: '%1',
        targetBranch: 'main',
        targetRepoPath: '/workspace/worktrees/feature',
        terminalTranscriptDir: '/logs/terminal',
      }),
      onAbandoned: expect.any(Function),
      onResolved: expect.any(Function),
    });
  });

  it('surfaces transactional setup failure without returning an orphan pane', async () => {
    vi.mocked(launchManagedConflictResolutionPane).mockRejectedValueOnce(
      new Error('monitor setup failed; resources rolled back'),
    );

    const result = await createConflictResolutionPaneForMerge(
      sourcePane,
      makeContext(),
      'main',
      '/workspace/main-project',
    );

    expect(result).toMatchObject({
      type: 'error',
      message: expect.stringContaining('resources rolled back'),
    });
  });
});
