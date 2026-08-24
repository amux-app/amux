/**
 * Tests for conflict monitoring
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockPaneExists = vi.fn();
vi.mock('../../src/services/TmuxService.js', () => ({
  TmuxService: {
    getInstance: vi.fn(() => ({ paneExists: mockPaneExists })),
  },
}));
vi.mock('../../src/utils/execAsync.js', () => ({
  execFileAsync: vi.fn(),
}));

// Need to import after mocking
import { startConflictMonitoring } from '../../src/utils/conflictMonitor.js';
import { execFileAsync as mockExecFileAsync } from '../../src/utils/execAsync.js';

const expectedCommits = {
  sourceCommit: 'source-commit',
  targetCommit: 'target-commit',
};

describe('Conflict Monitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockPaneExists.mockResolvedValue(true);
    vi.mocked(mockExecFileAsync).mockImplementation(async (_file, args) => {
      if (args.includes('MERGE_HEAD')) return 'target-commit';
      throw new Error('Unexpected git command');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('startConflictMonitoring', () => {
    it('should start monitoring with default interval', () => {
      const onResolved = vi.fn();

      const cleanup = startConflictMonitoring({
        conflictPaneId: '%99',
        expectedCommits,
        repoPath: '/test/repo',
        onResolved,
      });

      expect(typeof cleanup).toBe('function');
      expect(onResolved).not.toHaveBeenCalled();
    });

    it('should check pane existence on each interval', async () => {
      const onResolved = vi.fn();

      startConflictMonitoring({
        conflictPaneId: '%99',
        expectedCommits,
        repoPath: '/test/repo',
        onResolved,
      });

      // Advance timer
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockPaneExists).toHaveBeenCalledWith('%99');
    });

    it('should stop monitoring if pane is manually closed', async () => {
      const onResolved = vi.fn();

      // First check: pane exists
      // Second check: pane doesn't exist
      let checkCount = 0;
      mockPaneExists.mockImplementation(async () => {
        checkCount++;
        return checkCount === 1;
      });

      startConflictMonitoring({
        conflictPaneId: '%99',
        expectedCommits,
        repoPath: '/test/repo',
        onResolved,
        checkIntervalMs: 1000,
      });

      // First check - pane exists
      await vi.advanceTimersByTimeAsync(1000);

      // Second check - pane doesn't exist, should stop
      await vi.advanceTimersByTimeAsync(1000);

      // Third check - shouldn't happen
      await vi.advanceTimersByTimeAsync(1000);

      expect(onResolved).not.toHaveBeenCalled();
      expect(checkCount).toBe(2);
    });

    it('should report pane disappearance as an abandonment', async () => {
      const onResolved = vi.fn();
      const onAbandoned = vi.fn();
      mockPaneExists.mockResolvedValue(false);

      startConflictMonitoring({
        conflictPaneId: '%99',
        expectedCommits,
        repoPath: '/test/repo',
        onResolved,
        onAbandoned,
        checkIntervalMs: 1000,
      });

      await vi.advanceTimersByTimeAsync(1000);

      expect(onResolved).not.toHaveBeenCalled();
      expect(onAbandoned).toHaveBeenCalledWith(
        'Conflict resolution pane disappeared before the merge was completed',
      );
    });

    it('should stop at an explicit monitoring limit without abandoning the merge', async () => {
      const onAbandoned = vi.fn();

      startConflictMonitoring({
        conflictPaneId: '%99',
        expectedCommits,
        repoPath: '/test/repo',
        onResolved: vi.fn(),
        onAbandoned,
        checkIntervalMs: 1000,
        maxChecks: 1,
      });

      await vi.advanceTimersByTimeAsync(2000);

      expect(onAbandoned).not.toHaveBeenCalled();
      expect(mockPaneExists).toHaveBeenCalledTimes(1);
    });

    it('should continue monitoring beyond the former ten-minute default limit', async () => {
      const onAbandoned = vi.fn();

      startConflictMonitoring({
        conflictPaneId: '%99',
        expectedCommits,
        repoPath: '/test/repo',
        onResolved: vi.fn(),
        onAbandoned,
        checkIntervalMs: 1000,
      });

      await vi.advanceTimersByTimeAsync(301_000);

      expect(mockPaneExists).toHaveBeenCalledTimes(301);
      expect(onAbandoned).not.toHaveBeenCalled();
    });

    it('should detect conflict resolution and trigger callback', async () => {
      const onResolved = vi.fn();

      vi.mocked(mockExecFileAsync).mockImplementation(async (_file, args) => {
        const command = args.join(' ');
        if (command.includes('MERGE_HEAD')) throw new Error('merge committed');
        if (command.includes('diff --name-only')) return '';
        if (command.includes('rev-list --parents')) {
          return 'merge-commit source-commit target-commit';
        }
        throw new Error('Command not found');
      });

      startConflictMonitoring({
        conflictPaneId: '%99',
        expectedCommits,
        repoPath: '/test/repo',
        onResolved,
        checkIntervalMs: 1000,
      });

      // Advance timer to trigger check
      await vi.advanceTimersByTimeAsync(1000);

      expect(onResolved).toHaveBeenCalledTimes(1);
    });

    it('should not trigger callback if MERGE_HEAD still exists', async () => {
      const onResolved = vi.fn();

      startConflictMonitoring({
        conflictPaneId: '%99',
        expectedCommits,
        repoPath: '/test/repo',
        onResolved,
        checkIntervalMs: 1000,
      });

      await vi.advanceTimersByTimeAsync(1000);

      expect(onResolved).not.toHaveBeenCalled();
    });

    it('should not trigger callback if not a merge commit', async () => {
      const onResolved = vi.fn();

      vi.mocked(mockExecFileAsync).mockImplementation(async (_file, args) => {
        const command = args.join(' ');
        if (command.includes('MERGE_HEAD')) throw new Error('merge absent');
        if (command.includes('diff --name-only')) return '';
        if (command.includes('rev-list --parents')) return 'source-commit parent';
        throw new Error('Command not found');
      });

      startConflictMonitoring({
        conflictPaneId: '%99',
        expectedCommits,
        repoPath: '/test/repo',
        onResolved,
        checkIntervalMs: 1000,
      });

      await vi.advanceTimersByTimeAsync(1000);

      // Should not trigger - merge may have been aborted
      expect(onResolved).not.toHaveBeenCalled();
    });

    it('should stop monitoring after maxChecks', async () => {
      const onResolved = vi.fn();

      startConflictMonitoring({
        conflictPaneId: '%99',
        expectedCommits,
        repoPath: '/test/repo',
        onResolved,
        checkIntervalMs: 1000,
        maxChecks: 3,
      });

      // Advance through 3 checks
      await vi.advanceTimersByTimeAsync(3000);

      const callsBefore = mockPaneExists.mock.calls.length;

      // Advance further - shouldn't check anymore
      await vi.advanceTimersByTimeAsync(3000);

      const callsAfter = mockPaneExists.mock.calls.length;

      expect(callsAfter).toBe(callsBefore);
      expect(onResolved).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully and not crash', async () => {
      const onResolved = vi.fn();

      mockPaneExists.mockRejectedValue(new Error('Simulated error'));

      // Should not throw when starting
      expect(() => {
        startConflictMonitoring({
          conflictPaneId: '%99',
          expectedCommits,
          repoPath: '/test/repo',
          onResolved,
          checkIntervalMs: 1000,
        });
      }).not.toThrow();

      // Should not crash when errors occur during checks
      await vi.advanceTimersByTimeAsync(1000);

      // Callback should not be triggered when errors occur
      expect(onResolved).not.toHaveBeenCalled();
    });

    it('should allow manual cleanup via returned function', async () => {
      const onResolved = vi.fn();

      const cleanup = startConflictMonitoring({
        conflictPaneId: '%99',
        expectedCommits,
        repoPath: '/test/repo',
        onResolved,
        checkIntervalMs: 1000,
      });

      // First check
      await vi.advanceTimersByTimeAsync(1000);
      const callsBefore = mockPaneExists.mock.calls.length;

      // Call cleanup
      cleanup();

      // Advance timer - shouldn't check anymore
      await vi.advanceTimersByTimeAsync(2000);
      const callsAfter = mockPaneExists.mock.calls.length;

      expect(callsAfter).toBe(callsBefore);
      expect(onResolved).not.toHaveBeenCalled();
    });

    it('should use custom check interval', async () => {
      const onResolved = vi.fn();

      startConflictMonitoring({
        conflictPaneId: '%99',
        expectedCommits,
        repoPath: '/test/repo',
        onResolved,
        checkIntervalMs: 5000, // Custom interval
      });

      // Advance by default interval - shouldn't check
      await vi.advanceTimersByTimeAsync(2000);
      const callsBefore = mockPaneExists.mock.calls.length;

      // Advance by custom interval - should check
      await vi.advanceTimersByTimeAsync(3000);
      const callsAfter = mockPaneExists.mock.calls.length;

      expect(callsAfter).toBeGreaterThan(callsBefore);
    });

    it('should pass correct repoPath to git commands', async () => {
      const onResolved = vi.fn();

      vi.mocked(mockExecFileAsync).mockImplementation(async (_file, _args, options) => {
        expect(options?.cwd).toBe('/custom/repo/path');
        return 'target-commit';
      });

      startConflictMonitoring({
        conflictPaneId: '%99',
        expectedCommits,
        repoPath: '/custom/repo/path',
        onResolved,
        checkIntervalMs: 1000,
      });

      await vi.advanceTimersByTimeAsync(1000);
    });
  });
});
