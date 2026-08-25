import { describe, expect, it, vi } from 'vitest';
import type { ActionContext } from '../../../src/actions/types.js';
import { executeMultiMerge } from '../../../src/actions/merge/multiMergeOrchestrator.js';
import type { MergeQueueItem } from '../../../src/actions/merge/types.js';
import type { MuxBasePane } from '../../../src/types.js';
import { createConflictResolutionPane } from '../../../src/utils/conflictResolutionPane.js';

vi.mock('../../../src/services/LogService.js', () => ({
  LogService: { getInstance: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn() }) },
}));

vi.mock('../../../src/shared/StateManager.js', () => ({
  StateManager: { getInstance: () => ({ getPanes: vi.fn(() => []) }) },
}));

vi.mock('../../../src/utils/worktreeDiscovery.js', () => ({
  getWorktreeDisplayLabel: vi.fn(() => 'child'),
}));

vi.mock('../../../src/utils/agentDetection.js', () => ({
  getAvailableAgents: vi.fn(async () => ['claude']),
}));

vi.mock('../../../src/utils/conflictResolutionPane.js', () => ({
  createConflictResolutionPane: vi.fn(async () => ({
    pane: {
      id: 'conflict-1',
      slug: 'resolve-child',
      prompt: 'resolve',
      paneId: '%9',
      agent: 'claude',
    },
    preparation: {
      repoPath: '/tmp/repo/child',
      sourceCommit: 'source-commit',
      targetCommit: 'target-commit',
    },
  })),
  disposeConflictResolutionPane: vi.fn(),
}));

vi.mock('../../../src/utils/conflictMonitor.js', () => ({
  startConflictMonitoring: vi.fn(),
}));

describe('multi-merge conflict telemetry', () => {
  it('threads the action-context OTLP endpoint into its conflict agent launch', async () => {
    const pane: MuxBasePane = {
      id: 'source-1',
      slug: 'source',
      prompt: 'source',
      paneId: '%1',
      projectRoot: '/tmp/repo',
    };
    const context: ActionContext = {
      panes: [pane],
      projectName: 'project',
      sessionName: 'muxbase-project',
      otlpEndpoint: 'http://127.0.0.1:4318',
      savePanes: vi.fn(async () => undefined),
    };
    const item: MergeQueueItem = {
      status: 'pending',
      worktree: {
        branch: 'feature/child',
        depth: 1,
        isRoot: false,
        mainBranch: 'main',
        parentRepoPath: '/tmp/repo',
        relativePath: 'child',
        repoName: 'child',
        worktreePath: '/tmp/repo/child',
      },
      validation: {
        canMerge: false,
        issues: [{
          canAutoResolve: false,
          files: ['src/conflict.ts'],
          message: 'conflict',
          type: 'merge_conflict',
        }],
        mainBranch: 'main',
        worktreeBranch: 'feature/child',
      },
    };

    const confirmation = await executeMultiMerge(pane, context, [item]);
    const conflictChoice = await confirmation.onConfirm?.();
    await conflictChoice?.onSelect?.('ai_merge');

    expect(createConflictResolutionPane).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'claude',
      otlpEndpoint: 'http://127.0.0.1:4318',
      sourceBranch: 'feature/child',
      sourceTmuxPaneId: '%1',
      targetBranch: 'main',
      targetRepoPath: '/tmp/repo/child',
      projectRoot: '/tmp/repo',
      terminalTranscriptDir: undefined,
    }));
  });
});
