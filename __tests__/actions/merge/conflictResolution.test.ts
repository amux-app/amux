/**
 * Tests for conflict resolution
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createConflictResolutionPaneForMerge } from '../../../src/actions/merge/conflictResolution.js';
import type { MuxBasePane } from '../../../src/types.js';
import type { ActionContext } from '../../../src/actions/types.js';

// Mock agent detection
vi.mock('../../../src/utils/agentDetection.js', () => {
  const findClaudeCommand = vi.fn(() => Promise.resolve<unknown>(true));
  const findOpencodeCommand = vi.fn(() => Promise.resolve<unknown>(true));
  const findCodexCommand = vi.fn(() => Promise.resolve<unknown>(false));
  return {
    findClaudeCommand,
    findOpencodeCommand,
    findCodexCommand,
    findAgentCommand: vi.fn((agent: 'claude' | 'opencode' | 'codex') => {
      if (agent === 'claude') return findClaudeCommand();
      if (agent === 'opencode') return findOpencodeCommand();
      return findCodexCommand();
    }),
    getAvailableAgents: vi.fn(async () => {
      const agents: Array<'claude' | 'opencode' | 'codex'> = [];
      if (await findClaudeCommand()) agents.push('claude');
      if (await findOpencodeCommand()) agents.push('opencode');
      if (await findCodexCommand()) agents.push('codex');
      return agents;
    }),
  };
});

// Mock conflict resolution pane creation
vi.mock('../../../src/utils/conflictResolutionPane.js', () => ({
  createConflictResolutionPane: vi.fn(() =>
    Promise.resolve({
      pane: {
        id: 'conflict-pane-1',
        slug: 'resolve-conflicts',
        prompt: 'Resolve merge conflicts',
        paneId: '%99',
      },
      preparation: {
        repoPath: '/test/worktree',
        sourceCommit: 'source-commit',
        targetCommit: 'target-commit',
      },
    })
  ),
  disposeConflictResolutionPane: vi.fn(),
}));

// Mock conflict monitor
vi.mock('../../../src/utils/conflictMonitor.js', () => ({
  startConflictMonitoring: vi.fn(() => vi.fn()), // Returns cleanup function
}));

// Mock merge execution
vi.mock('../../../src/actions/merge/mergeExecution.js', () => ({
  executeMerge: vi.fn(() =>
    Promise.resolve({
      type: 'confirm',
      title: 'Merge Complete',
      message: 'Successfully merged',
    })
  ),
  executeMergeWithConflictHandling: vi.fn(() =>
    Promise.resolve({
      type: 'navigation',
      message: 'Manual resolution',
    })
  ),
}));

// Mock child_process for tmux commands
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

describe('Conflict Resolution', () => {
  const mockPane: MuxBasePane = {
    id: 'test-1',
    slug: 'test-branch',
    prompt: 'test prompt',
    paneId: '%1',
    projectRoot: '/test/main-project',
    worktreePath: '/test/worktree',
  };

  const mockContext: ActionContext = {
    projectName: 'test-project',
    sessionName: 'muxbase-test-project',
    panes: [mockPane],
    otlpEndpoint: 'http://127.0.0.1:4318',
    savePanes: vi.fn(),
    onPaneUpdate: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    const { findClaudeCommand, findOpencodeCommand, findCodexCommand } = await import('../../../src/utils/agentDetection.js');
    vi.mocked(findClaudeCommand).mockResolvedValue(true);
    vi.mocked(findOpencodeCommand).mockResolvedValue(true);
    vi.mocked(findCodexCommand).mockResolvedValue(false);

    const { createConflictResolutionPane } = await import('../../../src/utils/conflictResolutionPane.js');
    vi.mocked(createConflictResolutionPane).mockResolvedValue({
      pane: {
        id: 'conflict-pane-1',
        slug: 'resolve-conflicts',
        prompt: 'Resolve merge conflicts',
        paneId: '%99',
      },
      preparation: {
        repoPath: '/test/worktree',
        sourceCommit: 'source-commit',
        targetCommit: 'target-commit',
      },
    });

    const { startConflictMonitoring } = await import('../../../src/utils/conflictMonitor.js');
    vi.mocked(startConflictMonitoring).mockReturnValue(vi.fn());
  });

  describe('createConflictResolutionPaneForMerge', () => {
    it('should return error when no agents available', async () => {
      const { findClaudeCommand, findOpencodeCommand, findCodexCommand } = await import('../../../src/utils/agentDetection.js');
      vi.mocked(findClaudeCommand).mockResolvedValue(false);
      vi.mocked(findOpencodeCommand).mockResolvedValue(false);
      vi.mocked(findCodexCommand).mockResolvedValue(false);

      const result = await createConflictResolutionPaneForMerge(mockPane, mockContext, 'main', '/test/main');

      expect(result.type).toBe('error');
      expect(result.message).toContain('No AI agents available');
    });

    it('should prompt for agent choice when multiple agents available', async () => {
      const { findClaudeCommand, findOpencodeCommand } = await import('../../../src/utils/agentDetection.js');
      vi.mocked(findClaudeCommand).mockResolvedValue(true);
      vi.mocked(findOpencodeCommand).mockResolvedValue(true);

      const result = await createConflictResolutionPaneForMerge(mockPane, mockContext, 'main', '/test/main');

      expect(result.type).toBe('choice');
      expect(result.title).toBe('Choose AI Agent for Conflict Resolution');
      expect(result.options).toHaveLength(2);
      expect(result.options?.map(o => o.id)).toEqual(['claude', 'opencode']);
    });

    it('should include codex in agent choice when available', async () => {
      const { findClaudeCommand, findOpencodeCommand, findCodexCommand } = await import('../../../src/utils/agentDetection.js');
      vi.mocked(findClaudeCommand).mockResolvedValue(true);
      vi.mocked(findOpencodeCommand).mockResolvedValue(false);
      vi.mocked(findCodexCommand).mockResolvedValue(true);

      const result = await createConflictResolutionPaneForMerge(mockPane, mockContext, 'main', '/test/main');

      expect(result.type).toBe('choice');
      expect(result.options?.map(o => o.id)).toEqual(['claude', 'codex']);
    });

    it('should use only available agent directly', async () => {
      const { findClaudeCommand, findOpencodeCommand } = await import('../../../src/utils/agentDetection.js');
      const { createConflictResolutionPane } = await import('../../../src/utils/conflictResolutionPane.js');
      vi.mocked(findClaudeCommand).mockResolvedValue(true);
      vi.mocked(findOpencodeCommand).mockResolvedValue(false);

      const result = await createConflictResolutionPaneForMerge(mockPane, mockContext, 'main', '/test/main');

      expect(result.type).toBe('navigation');
      expect(result.title).toBe('Conflict Resolution Pane Created');
      expect(createConflictResolutionPane).toHaveBeenCalledWith({
        sourceTmuxPaneId: '%1',
        otlpEndpoint: 'http://127.0.0.1:4318',
        sourceBranch: 'test-branch',
        projectRoot: '/test/main-project',
        targetBranch: 'main',
        targetRepoPath: '/test/worktree', // Bug #10 fix: use worktree, not main repo
        mainRepoPath: '/test/main',
        terminalTranscriptDir: undefined,
        agent: 'claude',
      });
    });

    it('should use codex directly when it is the only available agent', async () => {
      const { findClaudeCommand, findOpencodeCommand, findCodexCommand } = await import('../../../src/utils/agentDetection.js');
      const { createConflictResolutionPane } = await import('../../../src/utils/conflictResolutionPane.js');
      const { startConflictMonitoring } = await import('../../../src/utils/conflictMonitor.js');

      vi.mocked(findClaudeCommand).mockResolvedValue(false);
      vi.mocked(findOpencodeCommand).mockResolvedValue(false);
      vi.mocked(findCodexCommand).mockResolvedValue(true);

      const result = await createConflictResolutionPaneForMerge(mockPane, mockContext, 'main', '/test/main');

      expect(result.type).toBe('navigation');
      expect(createConflictResolutionPane).toHaveBeenCalledWith({
        sourceTmuxPaneId: '%1',
        otlpEndpoint: 'http://127.0.0.1:4318',
        sourceBranch: 'test-branch',
        projectRoot: '/test/main-project',
        targetBranch: 'main',
        targetRepoPath: '/test/worktree',
        mainRepoPath: '/test/main',
        terminalTranscriptDir: undefined,
        agent: 'codex',
      });
      expect(startConflictMonitoring).toHaveBeenCalledWith(
        expect.objectContaining({
          conflictPaneId: '%99',
          repoPath: '/test/worktree',
          onResolved: expect.any(Function),
        })
      );
    });

    it('should create conflict pane and update state', async () => {
      const { findClaudeCommand, findOpencodeCommand } = await import('../../../src/utils/agentDetection.js');
      vi.mocked(findClaudeCommand).mockResolvedValue(true);
      vi.mocked(findOpencodeCommand).mockResolvedValue(false);

      const result = await createConflictResolutionPaneForMerge(mockPane, mockContext, 'main', '/test/main');

      expect(result.type).toBe('navigation');
      expect(result.targetPaneId).toBe('conflict-pane-1');
      expect(mockContext.savePanes).toHaveBeenCalledWith([
        mockPane,
        expect.objectContaining({
          id: 'conflict-pane-1',
          slug: 'resolve-conflicts',
          prompt: 'Resolve merge conflicts',
          paneId: '%99',
          // No worktreePath - conflict pane operates in targetRepoPath
          conflictMerge: expect.objectContaining({
            repoPath: '/test/worktree',
            sourcePaneId: mockPane.id,
            sourceCommit: 'source-commit',
            targetCommit: 'target-commit',
          }),
        }),
      ]);
      expect(mockContext.onPaneUpdate).toHaveBeenCalledWith(expect.objectContaining({
        id: 'conflict-pane-1',
        slug: 'resolve-conflicts',
        prompt: 'Resolve merge conflicts',
        paneId: '%99',
        // No worktreePath - operates in targetRepoPath
        conflictMerge: expect.objectContaining({
          repoPath: '/test/worktree',
          sourcePaneId: mockPane.id,
          sourceCommit: 'source-commit',
          targetCommit: 'target-commit',
        }),
      }));
    });

    it('should start conflict monitoring with correct worktree path', async () => {
      const { findClaudeCommand, findOpencodeCommand } = await import('../../../src/utils/agentDetection.js');
      const { startConflictMonitoring } = await import('../../../src/utils/conflictMonitor.js');

      vi.mocked(findClaudeCommand).mockResolvedValue(true);
      vi.mocked(findOpencodeCommand).mockResolvedValue(false);

      await createConflictResolutionPaneForMerge(mockPane, mockContext, 'main', '/test/main');

      expect(startConflictMonitoring).toHaveBeenCalledWith(
        expect.objectContaining({
          conflictPaneId: '%99',
          repoPath: '/test/worktree', // Should monitor the WORKTREE, not main repo
          onResolved: expect.any(Function),
        })
      );
    });

    it('should pass targetRepoPath (worktree) to createConflictResolutionPane', async () => {
      const { findClaudeCommand, findOpencodeCommand } = await import('../../../src/utils/agentDetection.js');
      const { createConflictResolutionPane } = await import('../../../src/utils/conflictResolutionPane.js');

      vi.mocked(findClaudeCommand).mockResolvedValue(true);
      vi.mocked(findOpencodeCommand).mockResolvedValue(false);

      await createConflictResolutionPaneForMerge(mockPane, mockContext, 'main', '/test/main');

      expect(createConflictResolutionPane).toHaveBeenCalledWith({
        sourceTmuxPaneId: '%1',
        otlpEndpoint: 'http://127.0.0.1:4318',
        sourceBranch: 'test-branch',
        projectRoot: '/test/main-project',
        targetBranch: 'main',
        targetRepoPath: '/test/worktree', // Bug #10 fix: pass worktree path, not main repo
        mainRepoPath: '/test/main',
        terminalTranscriptDir: undefined,
        agent: 'claude',
      });
    });

    it('should handle agent selection for multiple agents', async () => {
      const { findClaudeCommand, findOpencodeCommand } = await import('../../../src/utils/agentDetection.js');
      const { createConflictResolutionPane } = await import('../../../src/utils/conflictResolutionPane.js');

      vi.mocked(findClaudeCommand).mockResolvedValue(true);
      vi.mocked(findOpencodeCommand).mockResolvedValue(true);

      const result = await createConflictResolutionPaneForMerge(mockPane, mockContext, 'main', '/test/main');

      if (result.type === 'choice' && result.onSelect) {
        const selectedResult = await result.onSelect('opencode');

        expect(selectedResult.type).toBe('navigation');
        expect(createConflictResolutionPane).toHaveBeenCalledWith({
          sourceTmuxPaneId: '%1',
          otlpEndpoint: 'http://127.0.0.1:4318',
          sourceBranch: 'test-branch',
          projectRoot: '/test/main-project',
          targetBranch: 'main',
          targetRepoPath: '/test/worktree', // Bug #10 fix: pass worktree path
          mainRepoPath: '/test/main',
          terminalTranscriptDir: undefined,
          agent: 'opencode',
        });
      }
    });

    it('should handle codex selection for multiple agents', async () => {
      const { findClaudeCommand, findOpencodeCommand, findCodexCommand } = await import('../../../src/utils/agentDetection.js');
      const { createConflictResolutionPane } = await import('../../../src/utils/conflictResolutionPane.js');
      const { startConflictMonitoring } = await import('../../../src/utils/conflictMonitor.js');

      vi.mocked(findClaudeCommand).mockResolvedValue(true);
      vi.mocked(findOpencodeCommand).mockResolvedValue(true);
      vi.mocked(findCodexCommand).mockResolvedValue(true);

      const result = await createConflictResolutionPaneForMerge(mockPane, mockContext, 'main', '/test/main');

      if (result.type === 'choice' && result.onSelect) {
        const selectedResult = await result.onSelect('codex');

        expect(selectedResult.type).toBe('navigation');
        expect(createConflictResolutionPane).toHaveBeenCalledWith({
          sourceTmuxPaneId: '%1',
          otlpEndpoint: 'http://127.0.0.1:4318',
          sourceBranch: 'test-branch',
          projectRoot: '/test/main-project',
          targetBranch: 'main',
          targetRepoPath: '/test/worktree',
          mainRepoPath: '/test/main',
          terminalTranscriptDir: undefined,
          agent: 'codex',
        });
        expect(startConflictMonitoring).toHaveBeenCalledWith(
          expect.objectContaining({
            conflictPaneId: '%99',
            repoPath: '/test/worktree',
            onResolved: expect.any(Function),
          })
        );
      }
    });

    it('should handle errors during pane creation', async () => {
      const { findClaudeCommand, findOpencodeCommand } = await import('../../../src/utils/agentDetection.js');
      const { createConflictResolutionPane } = await import('../../../src/utils/conflictResolutionPane.js');

      vi.mocked(findClaudeCommand).mockResolvedValue(true);
      vi.mocked(findOpencodeCommand).mockResolvedValue(false);
      vi.mocked(createConflictResolutionPane).mockRejectedValue(new Error('Pane creation failed'));

      const result = await createConflictResolutionPaneForMerge(mockPane, mockContext, 'main', '/test/main');

      expect(result.type).toBe('error');
      expect(result.message).toContain('Failed to create conflict resolution pane');
      expect(result.message).toContain('Pane creation failed');
    });

    // NOTE: Full integration tests for onActionResult and monitoring callbacks
    // are better suited for E2E tests. The unit behavior is covered by:
    // - conflictMonitor.test.ts (monitoring logic)
    // - mergeExecution.test.ts (runtime conflict handling)
    // - Above tests (conflict pane creation flow)

    // NOTE: The onResolved callback behavior tests are integration-level tests
    // that are complex to test with mocks due to dynamic imports. The critical
    // behavior is tested at the conflictMonitor.test.ts level. The integration
    // of monitoring → pane kill → cleanup dialog is best tested manually or
    // with E2E tests.
  });
});
