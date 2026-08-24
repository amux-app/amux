import { describe, it, expect, vi } from 'vitest';
import { renamePane } from '../../src/actions/implementations/renameAction.js';
import { createMockPane } from '../fixtures/mockPanes.js';
import { createMockContext } from '../fixtures/mockContext.js';

describe('renameAction', () => {
  it('should return error when no name provided', async () => {
    const mockPane = createMockPane({ slug: 'test-pane' });
    const mockContext = createMockContext([mockPane]);

    const result = await renamePane(mockPane, mockContext);
    expect(result.type).toBe('error');
  });

  it('should rename pane slug via onPaneUpdate', async () => {
    const mockPane = createMockPane({ slug: 'old-name' });
    const onPaneUpdate = vi.fn();
    const mockContext = createMockContext([mockPane], { onPaneUpdate });

    const result = await renamePane(mockPane, mockContext, 'new-name');

    expect(result.type).toBe('success');
    expect(onPaneUpdate).toHaveBeenCalledOnce();
    expect(onPaneUpdate.mock.calls[0][0].slug).toBe('new-name');
  });

  it('should preserve original slug as branchName when worktree exists', async () => {
    const mockPane = createMockPane({ slug: 'feat-branch', worktreePath: '/tmp/wt' });
    const onPaneUpdate = vi.fn();
    const mockContext = createMockContext([mockPane], { onPaneUpdate });

    await renamePane(mockPane, mockContext, 'renamed');

    const updatedPane = onPaneUpdate.mock.calls[0][0];
    expect(updatedPane.slug).toBe('renamed');
    expect(updatedPane.branchName).toBe('feat-branch');
  });

  it('should not overwrite existing branchName on rename', async () => {
    const mockPane = createMockPane({ slug: 'display', branchName: 'actual-branch', worktreePath: '/tmp/wt' });
    const onPaneUpdate = vi.fn();
    const mockContext = createMockContext([mockPane], { onPaneUpdate });

    await renamePane(mockPane, mockContext, 'renamed');

    const updatedPane = onPaneUpdate.mock.calls[0][0];
    expect(updatedPane.slug).toBe('renamed');
    expect(updatedPane.branchName).toBe('actual-branch');
  });

  it('should not set branchName for panes without worktree', async () => {
    const mockPane = createMockPane({ slug: 'shell-pane', worktreePath: undefined });
    const onPaneUpdate = vi.fn();
    const mockContext = createMockContext([mockPane], { onPaneUpdate });

    await renamePane(mockPane, mockContext, 'renamed');

    const updatedPane = onPaneUpdate.mock.calls[0][0];
    expect(updatedPane.slug).toBe('renamed');
    expect(updatedPane.branchName).toBeUndefined();
  });

  it('should trim whitespace from new name', async () => {
    const mockPane = createMockPane({ slug: 'old' });
    const onPaneUpdate = vi.fn();
    const mockContext = createMockContext([mockPane], { onPaneUpdate });

    await renamePane(mockPane, mockContext, '  trimmed  ');

    expect(onPaneUpdate.mock.calls[0][0].slug).toBe('trimmed');
  });

  it('should reject names longer than the supported display limit', async () => {
    const mockPane = createMockPane({ slug: 'old' });
    const onPaneUpdate = vi.fn();
    const mockContext = createMockContext([mockPane], { onPaneUpdate });

    const result = await renamePane(mockPane, mockContext, 'a'.repeat(81));

    expect(result).toEqual({ type: 'error', message: 'Name must be 80 characters or fewer' });
    expect(onPaneUpdate).not.toHaveBeenCalled();
  });

  it('should reject control characters in pane names', async () => {
    const mockPane = createMockPane({ slug: 'old' });
    const onPaneUpdate = vi.fn();
    const mockContext = createMockContext([mockPane], { onPaneUpdate });

    const result = await renamePane(mockPane, mockContext, 'line one\nline two');

    expect(result).toEqual({ type: 'error', message: 'Name cannot contain control characters' });
    expect(onPaneUpdate).not.toHaveBeenCalled();
  });
});
