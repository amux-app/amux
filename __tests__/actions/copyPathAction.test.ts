/**
 * Unit tests for copyPathAction
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { copyPath } from '../../src/actions/implementations/copyPathAction.js';
import { createMockPane, createShellPane } from '../fixtures/mockPanes.js';
import { createMockContext } from '../fixtures/mockContext.js';
import { expectSuccess, expectError, expectInfo } from '../helpers/actionAssertions.js';
import { spawnSync } from 'child_process';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

describe('copyPathAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should copy worktree path to clipboard successfully', async () => {
    const mockPane = createMockPane({
      worktreePath: '/test/project/.aumx/worktrees/my-feature',
    });
    const mockContext = createMockContext([mockPane]);

    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
    } as never);

    const result = await copyPath(mockPane, mockContext);

    // Verify clipboard copy command
    expect(spawnSync).toHaveBeenCalledWith(
      'pbcopy',
      [],
      {
        input: '/test/project/.aumx/worktrees/my-feature',
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      }
    );

    // Verify success result with path in message
    expectSuccess(result, '/test/project/.aumx/worktrees/my-feature');
  });

  it('should return error for shell pane without worktree', async () => {
    const mockPane = createShellPane();
    const mockContext = createMockContext([mockPane]);

    const result = await copyPath(mockPane, mockContext);

    expectError(result, 'no worktree');
  });

  it('should return error for pane without worktreePath', async () => {
    const mockPane = createMockPane({ worktreePath: undefined });
    const mockContext = createMockContext([mockPane]);

    const result = await copyPath(mockPane, mockContext);

    expectError(result, 'no worktree');
  });

  it('should fallback to info message when clipboard copy fails', async () => {
    const mockPane = createMockPane({
      worktreePath: '/test/path',
    });
    const mockContext = createMockContext([mockPane]);

    // Mock clipboard command failure
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'pbcopy not found',
    } as never);

    const result = await copyPath(mockPane, mockContext);

    // Should still return success but as info (showing path instead of copying)
    expectInfo(result, '/test/path');
  });

  it('should handle paths with special characters', async () => {
    const mockPane = createMockPane({
      worktreePath: '/test/project name with spaces/.aumx/worktrees/my-feature',
    });
    const mockContext = createMockContext([mockPane]);

    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
    } as never);

    await copyPath(mockPane, mockContext);

    // Verify path is properly quoted
    expect(spawnSync).toHaveBeenCalledWith(
      'pbcopy',
      [],
      expect.objectContaining({
        input: '/test/project name with spaces/.aumx/worktrees/my-feature',
      })
    );
  });

  it('should handle very long paths', async () => {
    const longPath = '/very/long/path/'.repeat(20) + 'worktree';
    const mockPane = createMockPane({ worktreePath: longPath });
    const mockContext = createMockContext([mockPane]);

    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
    } as never);

    const result = await copyPath(mockPane, mockContext);

    expectSuccess(result);
    expect(result.message).toContain(longPath);
  });
});
