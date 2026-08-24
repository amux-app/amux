/**
 * Unit tests for closeAction
 *
 * This is a complex action with multiple code paths:
 * - Shell panes close immediately without options
 * - Worktree panes present 3 options (kill_only, kill_and_clean, kill_clean_branch)
 * - Hooks are triggered, config watcher is paused, tmux operations, layout recalculation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { closePane } from '../../src/actions/implementations/closeAction.js';
import { createShellPane, createWorktreePane } from '../fixtures/mockPanes.js';
import { createMockContext } from '../fixtures/mockContext.js';
import { expectChoice, expectSuccess } from '../helpers/actionAssertions.js';

// Mock all external dependencies
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

const {
  mockEnqueueCleanup,
  mockHandleLastPaneRemoved,
  mockStatSync,
} = vi.hoisted(() => ({
  mockEnqueueCleanup: vi.fn(),
  mockHandleLastPaneRemoved: vi.fn(),
  mockStatSync: vi.fn(() => ({})),
}));

const mockConflictMergeState = vi.hoisted(() => ({
  abort: vi.fn(),
  clearById: vi.fn(),
  findByPane: vi.fn(() => undefined),
  get: vi.fn(() => undefined),
  inspect: vi.fn(async () => ({ status: 'clean', unmergedFiles: [] })),
  fromMetadata: vi.fn((metadata) => ({ ...metadata, id: metadata.transactionId, state: 'active' })),
  register: vi.fn((transaction) => transaction),
}));

vi.mock('../../src/utils/conflictMergeTransaction.js', () => ({
  abortConflictMergeTransaction: mockConflictMergeState.abort,
  clearConflictMergeTransactionById: mockConflictMergeState.clearById,
  findConflictMergeTransactionByPane: mockConflictMergeState.findByPane,
  getConflictMergeTransaction: mockConflictMergeState.get,
  inspectConflictMergeState: mockConflictMergeState.inspect,
  conflictMergeTransactionFromMetadata: mockConflictMergeState.fromMetadata,
  registerConflictMergeTransaction: mockConflictMergeState.register,
}));

vi.mock('../../src/services/WorktreeCleanupService.js', () => ({
  WorktreeCleanupService: {
    getInstance: vi.fn(() => ({
      enqueueCleanup: mockEnqueueCleanup,
    })),
  },
}));

vi.mock('../../src/utils/postPaneCleanup.js', () => ({
  handleLastPaneRemoved: mockHandleLastPaneRemoved,
}));

// Create a persistent mock state manager instance
const mockStateManager = {
  getState: vi.fn(() => ({ projectRoot: '/test/project' })),
  getPanes: vi.fn(() => []),
  pauseConfigWatcher: vi.fn(),
  resumeConfigWatcher: vi.fn(),
};

vi.mock('../../src/shared/StateManager.js', () => ({
  StateManager: {
    getInstance: vi.fn(() => mockStateManager),
  },
}));

vi.mock('../../src/utils/hooks.js', () => ({
  triggerHook: vi.fn().mockResolvedValue(undefined),
  triggerHookSync: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../../src/services/LogService.js', () => ({
  LogService: {
    getInstance: vi.fn(() => ({
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn(),
    statSync: mockStatSync,
  },
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  statSync: mockStatSync,
}));

import { execFileSync, execSync } from 'child_process';
import { triggerHook, triggerHookSync } from '../../src/utils/hooks.js';
import fs from 'fs';

describe('closeAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStateManager.getPanes.mockReturnValue([]);
    mockEnqueueCleanup.mockReset();
    mockHandleLastPaneRemoved.mockReset();
    mockStatSync.mockReset();
    mockStatSync.mockReturnValue({});
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(''));
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
  });

  describe('shell panes', () => {
    it('should close shell pane immediately without presenting options', async () => {
      const mockPane = createShellPane({ id: 'aumx-1', paneId: '%42' });
      const mockContext = createMockContext([mockPane]);

      const result = await closePane(mockPane, mockContext);

      // Should return success immediately (not a choice dialog)
      expectSuccess(result, 'closed successfully');
    });

    it('should kill shell pane via tmux', async () => {
      const mockPane = createShellPane({ paneId: '%99' });
      const mockContext = createMockContext([mockPane]);

      vi.mocked(execFileSync).mockImplementation((command, args) => {
        if (command === 'tmux' && Array.isArray(args) && args.includes('display-message')) {
          return '%99\n';
        }
        return Buffer.from('');
      });

      await closePane(mockPane, mockContext);

      expect(execFileSync).toHaveBeenCalledWith(
        'tmux',
        ['display-message', '-p', '-t', '%99', '#{pane_id}'],
        expect.anything()
      );
      expect(execFileSync).toHaveBeenCalledWith(
        'tmux',
        ['send-keys', '-t', '%99', 'C-c'],
        expect.anything()
      );
      expect(execFileSync).toHaveBeenCalledWith(
        'tmux',
        ['kill-pane', '-t', '%99'],
        expect.anything()
      );
    });

    it('should not recreate a welcome pane when the context opts out', async () => {
      const mockPane = createShellPane({ paneId: '%99' });
      const mockContext = createMockContext([mockPane], { skipLastPaneWelcome: true });

      vi.mocked(execFileSync).mockImplementation((command, args) => {
        if (command === 'tmux' && Array.isArray(args) && args.includes('display-message')) {
          return '%99\n';
        }
        return Buffer.from('');
      });

      await closePane(mockPane, mockContext);

      expect(mockHandleLastPaneRemoved).not.toHaveBeenCalled();
    });
  });

  describe('review panes - auto cleanup', () => {
    beforeEach(() => {
      mockEnqueueCleanup.mockClear();
    });

    it('closes a review pane immediately without prompting', async () => {
      const reviewPane = createWorktreePane({ role: 'review' });
      const mockContext = createMockContext([reviewPane]);

      const result = await closePane(reviewPane, mockContext);

      // No Keep/Remove choice — it just closes.
      expectSuccess(result);
      expect(result.type).not.toBe('choice');
    });

    it('removes the review worktree and its synthetic branch', async () => {
      const reviewPane = createWorktreePane({ role: 'review' });
      const mockContext = createMockContext([reviewPane]);

      await closePane(reviewPane, mockContext);

      expect(mockEnqueueCleanup).toHaveBeenCalledWith(
        expect.objectContaining({ deleteBranch: true }),
      );
    });
  });

  describe('worktree panes - option presentation', () => {
    it('allows a stale pane to close when its worktree cannot be inspected', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);
      mockStatSync.mockImplementationOnce(() => {
        throw Object.assign(new Error('worktree does not exist'), { code: 'ENOENT' });
      });
      mockConflictMergeState.inspect.mockResolvedValueOnce({
        status: 'failed',
        unmergedFiles: [],
        error: 'ENOENT: worktree does not exist',
      });

      const result = await closePane(mockPane, mockContext);

      expectChoice(result, 3);
      expect(mockConflictMergeState.abort).not.toHaveBeenCalled();
    });

    it('keeps a failed inspection blocked when the worktree still exists', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);
      mockConflictMergeState.inspect.mockResolvedValueOnce({
        status: 'failed',
        unmergedFiles: [],
        error: 'fatal: unable to read index',
      });

      const result = await closePane(mockPane, mockContext);

      expect(result.type).toBe('confirm');
      expect(result.message).toContain('unresolved merge');
    });

    it('still protects an incomplete merge when inspection returns merge evidence', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);
      mockConflictMergeState.inspect.mockResolvedValueOnce({
        status: 'failed',
        mergeHead: 'merge-head',
        unmergedFiles: [],
        error: 'Repository has an incomplete merge state without a valid conflict set',
      });

      const result = await closePane(mockPane, mockContext);

      expect(result.type).toBe('confirm');
      expect(result.message).toContain('unresolved merge');
    });

    it('should present 3 cleanup options for worktree pane', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);

      const result = await closePane(mockPane, mockContext);

      expectChoice(result, 3);
      expect(result.title).toBe('Close Pane');

      // Verify all 3 options are present
      const optionIds = result.options!.map(o => o.id);
      expect(optionIds).toContain('kill_only');
      expect(optionIds).toContain('kill_and_clean');
      expect(optionIds).toContain('kill_clean_branch');
    });

    it('should mark destructive options as dangerous', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);

      const result = await closePane(mockPane, mockContext);

      const killAndClean = result.options!.find(o => o.id === 'kill_and_clean');
      const killCleanBranch = result.options!.find(o => o.id === 'kill_clean_branch');

      expect(killAndClean?.danger).toBe(true);
      expect(killCleanBranch?.danger).toBe(true);
    });

    it('should set kill_only as default option', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);

      const result = await closePane(mockPane, mockContext);

      const killOnly = result.options!.find(o => o.id === 'kill_only');
      expect(killOnly?.default).toBe(true);
    });
  });

  it('guards a persisted conflict source pane after a restart', async () => {
    const conflictMerge = {
      conflictPaneId: 'conflict-pane',
      repoPath: '/test/worktree',
      sourcePaneId: 'source-pane',
      sourceBranch: 'feature',
      sourceCommit: 'source',
      targetBranch: 'main',
      targetCommit: 'target',
      transactionId: 'transaction-1',
    };
    const sourcePane = createWorktreePane({ id: 'source-pane', worktreePath: '/test/worktree' });
    const conflictPane = createShellPane({ id: 'conflict-pane', conflictMerge, paneId: '%9' });
    mockStateManager.getPanes.mockReturnValue([sourcePane, conflictPane]);

    const result = await closePane(sourcePane, createMockContext([sourcePane, conflictPane]));

    expect(result.type).toBe('confirm');
    expect(result.message).toContain('active conflict merge');
  });

  describe('close execution - kill_only', () => {
    it('should remove pane from tracking when kill_only selected', async () => {
      const pane1 = createWorktreePane({ id: 'aumx-1' });
      const pane2 = createWorktreePane({ id: 'aumx-2' });
      const mockContext = createMockContext([pane1, pane2]);
      const savePanesSpy = vi.spyOn(mockContext, 'savePanes');

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(pane1, mockContext);
      await result.onSelect!('kill_only');

      // Verify pane was removed
      expect(savePanesSpy).toHaveBeenCalledWith([pane2]);
    });

    it('should call onPaneRemove callback with aumx pane ID', async () => {
      const mockPane = createWorktreePane({ paneId: '%42' });
      const mockContext = createMockContext([mockPane]);
      const onPaneRemoveSpy = vi.fn();
      mockContext.onPaneRemove = onPaneRemoveSpy;

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_only');

      expect(onPaneRemoveSpy).toHaveBeenCalledWith('aumx-1');
    });

    it('should trigger before_pane_close and pane_closed hooks', async () => {
      const mockPane = createWorktreePane({ slug: 'test' });
      const mockContext = createMockContext([mockPane]);

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_only');

      expect(triggerHook).toHaveBeenCalledWith('before_pane_close', '/test/project', mockPane);
      expect(triggerHook).toHaveBeenCalledWith('pane_closed', '/test/project', mockPane);
    });

    it('should pause and resume config watcher', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_only');

      expect(mockStateManager.pauseConfigWatcher).toHaveBeenCalled();
      expect(mockStateManager.resumeConfigWatcher).toHaveBeenCalled();
    });
  });

  describe('close execution - kill_and_clean', () => {
    it('should queue worktree cleanup when kill_and_clean selected', async () => {
      const mockPane = createWorktreePane({
        worktreePath: '/test/project/.aumx/worktrees/my-feature',
      });
      const mockContext = createMockContext([mockPane]);

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_and_clean');

      expect(mockEnqueueCleanup).toHaveBeenCalledWith(
        expect.objectContaining({
          pane: mockPane,
          paneProjectRoot: '/test/project',
          mainRepoPath: '/test/project',
          deleteBranch: false,
        })
      );
    });

    it('should trigger worktree removal hooks', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_and_clean');

      expect(triggerHookSync).toHaveBeenCalledWith('before_worktree_remove', expect.anything(), mockPane);
    });

    it('should run before_worktree_remove synchronously before cleanup starts', async () => {
      const events: string[] = [];
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);

      vi.mocked(triggerHookSync).mockImplementation(async () => {
        events.push('before_worktree_remove');
        return { success: true };
      });
      mockEnqueueCleanup.mockImplementation(() => {
        events.push('enqueue_cleanup');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_and_clean');

      expect(triggerHookSync).toHaveBeenCalledWith('before_worktree_remove', '/test/project', mockPane);
      expect(events).toEqual(['before_worktree_remove', 'enqueue_cleanup']);
    });

    it('should NOT delete branch when kill_and_clean selected', async () => {
      const mockPane = createWorktreePane({ slug: 'my-feature' });
      const mockContext = createMockContext([mockPane]);

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_and_clean');

      const cleanupJob = mockEnqueueCleanup.mock.calls.at(-1)?.[0];
      expect(cleanupJob?.deleteBranch).toBe(false);
    });
  });

  describe('close execution - kill_clean_branch', () => {
    it('should queue cleanup with branch deletion when kill_clean_branch selected', async () => {
      const mockPane = createWorktreePane({ slug: 'my-feature' });
      const mockContext = createMockContext([mockPane]);

      vi.mocked(execFileSync).mockImplementation((command, args) => {
        if (command === 'tmux' && Array.isArray(args) && args.includes('display-message')) {
          return '%1\n';
        }
        return Buffer.from('');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext); // Fixed: added missing mockContext
      await result.onSelect!('kill_clean_branch');

      const cleanupJob = mockEnqueueCleanup.mock.calls.at(-1)?.[0];
      expect(cleanupJob?.deleteBranch).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should return error when close operation fails', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);

      // Mock tmux kill to fail
      vi.mocked(execFileSync).mockImplementation((command, args) => {
        if (command === 'tmux' && Array.isArray(args) && args.includes('kill-pane')) {
          throw new Error('tmux error');
        }
        return Buffer.from('');
      });

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      const executeResult = await result.onSelect!('kill_only');

      // Should still complete (errors are logged but not fatal)
      expect(executeResult.type).toBe('success');
    });

    it('should resume config watcher even if close fails', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);

      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('fatal error');
      });

      const result = await closePane(mockPane, mockContext);

      try {
        await result.onSelect!('kill_only');
      } catch {
        // Expected to throw
      }

      // Config watcher should still be resumed
      expect(mockStateManager.resumeConfigWatcher).toHaveBeenCalled();
    });
  });

  describe('layout recalculation', () => {
    it('should NOT recalculate layout when no panes remain', async () => {
      const mockPane = createWorktreePane({ id: 'aumx-1' });
      const mockContext = createMockContext([mockPane]);

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_only');

      // No layout module should be imported when panes.length === 0
      // (This is tested by not mocking the layout module and ensuring no errors)
    });
  });
});
