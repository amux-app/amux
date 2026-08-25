// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MuxBasePane } from 'muxbase/core';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as worktreeApi from '../src/renderer/api/worktree.api';
import { WorktreeOverviewModal } from '../src/renderer/components/worktree/WorktreeOverviewModal';
import { useNotificationStore, usePaneStore } from '../src/renderer/stores';

vi.mock('../src/renderer/api/worktree.api', () => ({
  inspectPreservedWorktree: vi.fn(),
  listOrphanedWorktrees: vi.fn(),
  removePreservedWorktree: vi.fn(),
  reopenWorktree: vi.fn(),
}));

function makePane(overrides: Partial<MuxBasePane> = {}): MuxBasePane {
  return {
    agent: 'claude',
    agentStatus: 'idle',
    branchName: 'feature/live',
    id: 'pane-live',
    paneId: '%1',
    projectRoot: '/repo',
    prompt: 'live prompt',
    slug: 'live-worktree',
    type: 'worktree',
    worktreePath: '/repo/.muxbase/worktrees/live-worktree',
    ...overrides,
  };
}

describe('WorktreeOverviewModal', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    useNotificationStore.setState({ toasts: [] });
    usePaneStore.setState({
      isCreating: false,
      loaded: true,
      panes: [makePane()],
      pendingPane: null,
      selectedPaneId: null,
    });
  });

  it('lists preserved closed worktrees and reopens one without creating a new worktree', async () => {
    const onClose = vi.fn();
    const onJumpToPane = vi.fn();
    vi.mocked(worktreeApi.listOrphanedWorktrees).mockResolvedValue({
      success: true,
      worktrees: [
        {
          branch: null,
          gitStatus: 'unchecked',
          lastModifiedMs: 1_700_000_000_000,
          path: '/repo/.muxbase/worktrees/closed-worktree',
          registration: 'unchecked',
          slug: 'closed-worktree',
        },
      ],
    });
    vi.mocked(worktreeApi.reopenWorktree).mockResolvedValue({
      success: true,
      pane: makePane({
        branchName: 'feature/closed',
        id: 'pane-reopened',
        paneId: '%2',
        slug: 'closed-worktree',
        worktreePath: '/repo/.muxbase/worktrees/closed-worktree',
      }),
    });

    render(<WorktreeOverviewModal onClose={onClose} onJumpToPane={onJumpToPane} />);
    await screen.findByText('closed-worktree');
    expect(screen.getByTitle('Git status not inspected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open pane for closed-worktree' }));

    await waitFor(() => {
      expect(worktreeApi.reopenWorktree).toHaveBeenCalledWith({
        worktreePath: '/repo/.muxbase/worktrees/closed-worktree',
      });
    });
    expect(onJumpToPane).toHaveBeenCalledWith('pane-reopened');
    expect(onClose).toHaveBeenCalled();
  });

  it('shows preserved worktree age and routes row actions through one reopen path', async () => {
    // Arrange
    const onClose = vi.fn();
    const onJumpToPane = vi.fn();
    vi.mocked(worktreeApi.listOrphanedWorktrees).mockResolvedValue({
      success: true,
      worktrees: [
        {
          branch: null,
          gitStatus: 'unchecked',
          lastModifiedMs: Date.now() - (3 * 24 * 60 * 60 * 1000),
          path: '/repo/.muxbase/worktrees/closed-worktree',
          registration: 'unchecked',
          slug: 'closed-worktree',
        },
      ],
    });
    vi.mocked(worktreeApi.reopenWorktree).mockResolvedValue({
      success: true,
      pane: makePane({
        id: 'pane-reopened',
        slug: 'closed-worktree',
        worktreePath: '/repo/.muxbase/worktrees/closed-worktree',
      }),
    });

    // Act
    render(<WorktreeOverviewModal onClose={onClose} onJumpToPane={onJumpToPane} />);
    await screen.findByText('closed-worktree');
    expect(screen.getByText('3d ago')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open pane for closed-worktree' }));

    // Assert
    expect(worktreeApi.reopenWorktree).toHaveBeenCalledTimes(1);
    expect(worktreeApi.reopenWorktree).toHaveBeenCalledWith({
      worktreePath: '/repo/.muxbase/worktrees/closed-worktree',
    });
  });

  it('shows an error toast when reopening a preserved worktree fails', async () => {
    // Arrange
    const onClose = vi.fn();
    const onJumpToPane = vi.fn();
    vi.mocked(worktreeApi.listOrphanedWorktrees).mockResolvedValue({
      success: true,
      worktrees: [
        {
          branch: null,
          gitStatus: 'unchecked',
          lastModifiedMs: 1_700_000_000_000,
          path: '/repo/.muxbase/worktrees/closed-worktree',
          registration: 'unchecked',
          slug: 'closed-worktree',
        },
      ],
    });
    vi.mocked(worktreeApi.reopenWorktree).mockResolvedValue({
      success: false,
      error: 'Worktree is already reopening',
    });

    // Act
    render(<WorktreeOverviewModal onClose={onClose} onJumpToPane={onJumpToPane} />);
    await screen.findByText('closed-worktree');
    fireEvent.click(screen.getByRole('button', { name: 'Open pane for closed-worktree' }));

    // Assert
    await waitFor(() => {
      expect(useNotificationStore.getState().toasts).toContainEqual(expect.objectContaining({
        message: 'Worktree is already reopening',
        severity: 'error',
      }));
    });
    expect(onJumpToPane).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('inspects and explicitly confirms removal of a dirty preserved worktree', async () => {
    const onClose = vi.fn();
    const onJumpToPane = vi.fn();
    const worktreePath = '/repo/.muxbase/worktrees/closed-worktree';
    vi.mocked(worktreeApi.listOrphanedWorktrees).mockResolvedValue({
      success: true,
      worktrees: [{
        branch: null,
        gitStatus: 'unchecked',
        lastModifiedMs: 1_700_000_000_000,
        path: worktreePath,
        registration: 'unchecked',
        slug: 'closed-worktree',
      }],
    });
    vi.mocked(worktreeApi.inspectPreservedWorktree).mockResolvedValue({
      success: true,
      worktree: {
        branch: 'feature/closed',
        gitStatus: 'dirty',
        lastModifiedMs: 1_700_000_000_000,
        path: worktreePath,
        registration: 'registered',
        slug: 'closed-worktree',
      },
    });
    vi.mocked(worktreeApi.removePreservedWorktree).mockResolvedValue({
      success: true,
    });

    render(<WorktreeOverviewModal onClose={onClose} onJumpToPane={onJumpToPane} />);
    await screen.findByText('closed-worktree');
    fireEvent.click(screen.getByRole('button', { name: 'Remove preserved worktree closed-worktree' }));

    expect(await screen.findByText(/uncommitted changes/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete worktree' }));

    await waitFor(() => {
      expect(worktreeApi.removePreservedWorktree).toHaveBeenCalledWith({
        allowDataLoss: true,
        expectedState: {
          branch: 'feature/closed',
          gitStatus: 'dirty',
          registration: 'registered',
        },
        worktreePath,
      });
    });
    expect(screen.queryByText('closed-worktree')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('warns before removing a clean detached worktree', async () => {
    const worktreePath = '/repo/.muxbase/worktrees/detached-worktree';
    vi.mocked(worktreeApi.listOrphanedWorktrees).mockResolvedValue({
      success: true,
      worktrees: [{
        branch: null,
        gitStatus: 'unchecked',
        lastModifiedMs: 1_700_000_000_000,
        path: worktreePath,
        registration: 'unchecked',
        slug: 'detached-worktree',
      }],
    });
    vi.mocked(worktreeApi.inspectPreservedWorktree).mockResolvedValue({
      success: true,
      worktree: {
        branch: null,
        gitStatus: 'clean',
        lastModifiedMs: 1_700_000_000_000,
        path: worktreePath,
        registration: 'registered',
        slug: 'detached-worktree',
      },
    });
    vi.mocked(worktreeApi.removePreservedWorktree).mockResolvedValue({ success: true });

    render(<WorktreeOverviewModal onClose={vi.fn()} onJumpToPane={vi.fn()} />);
    await screen.findByText('detached-worktree');
    fireEvent.click(screen.getByRole('button', {
      name: 'Remove preserved worktree detached-worktree',
    }));

    expect(await screen.findByText(/detached HEAD/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete worktree' }));

    await waitFor(() => {
      expect(worktreeApi.removePreservedWorktree).toHaveBeenCalledWith({
        allowDataLoss: true,
        expectedState: {
          branch: null,
          gitStatus: 'clean',
          registration: 'registered',
        },
        worktreePath,
      });
    });
  });

  it('does not allow a clean inspection to silently delete newly dirty work', async () => {
    const onClose = vi.fn();
    const onJumpToPane = vi.fn();
    const worktreePath = '/repo/.muxbase/worktrees/closed-worktree';
    vi.mocked(worktreeApi.listOrphanedWorktrees).mockResolvedValue({
      success: true,
      worktrees: [{
        branch: null,
        gitStatus: 'unchecked',
        lastModifiedMs: 1_700_000_000_000,
        path: worktreePath,
        registration: 'unchecked',
        slug: 'closed-worktree',
      }],
    });
    vi.mocked(worktreeApi.inspectPreservedWorktree).mockResolvedValue({
      success: true,
      worktree: {
        branch: 'feature/closed',
        gitStatus: 'clean',
        lastModifiedMs: 1_700_000_000_000,
        path: worktreePath,
        registration: 'registered',
        slug: 'closed-worktree',
      },
    });
    vi.mocked(worktreeApi.removePreservedWorktree).mockResolvedValue({
      success: false,
      error: 'Worktree now has uncommitted changes',
    });

    render(<WorktreeOverviewModal onClose={onClose} onJumpToPane={onJumpToPane} />);
    await screen.findByText('closed-worktree');
    fireEvent.click(screen.getByRole('button', { name: 'Remove preserved worktree closed-worktree' }));
    await screen.findByText(/remove the preserved worktree/i);
    fireEvent.click(screen.getByRole('button', { name: 'Delete worktree' }));

    await waitFor(() => {
      expect(worktreeApi.removePreservedWorktree).toHaveBeenCalledWith({
        allowDataLoss: false,
        expectedState: {
          branch: 'feature/closed',
          gitStatus: 'clean',
          registration: 'registered',
        },
        worktreePath,
      });
      expect(useNotificationStore.getState().toasts).toContainEqual(expect.objectContaining({
        message: 'Worktree now has uncommitted changes',
        severity: 'error',
      }));
    });
    expect(screen.getByText('closed-worktree')).toBeTruthy();
  });

  it('cancels only the confirmation when its backdrop is clicked', async () => {
    const onClose = vi.fn();
    const worktreePath = '/repo/.muxbase/worktrees/closed-worktree';
    vi.mocked(worktreeApi.listOrphanedWorktrees).mockResolvedValue({
      success: true,
      worktrees: [{
        branch: null,
        gitStatus: 'unchecked',
        lastModifiedMs: 1_700_000_000_000,
        path: worktreePath,
        registration: 'unchecked',
        slug: 'closed-worktree',
      }],
    });
    vi.mocked(worktreeApi.inspectPreservedWorktree).mockResolvedValue({
      success: true,
      worktree: {
        branch: 'feature/closed',
        gitStatus: 'dirty',
        lastModifiedMs: 1_700_000_000_000,
        path: worktreePath,
        registration: 'registered',
        slug: 'closed-worktree',
      },
    });

    render(<WorktreeOverviewModal onClose={onClose} onJumpToPane={vi.fn()} />);
    await screen.findByText('closed-worktree');
    fireEvent.click(screen.getByRole('button', {
      name: 'Remove preserved worktree closed-worktree',
    }));
    const confirmation = await screen.findByRole('dialog', {
      name: 'Remove preserved worktree?',
    });
    fireEvent.click(confirmation.parentElement!);

    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Remove preserved worktree?' })).toBeNull();
    });
  });

  it('prevents overlapping worktree actions while an inspection is running', async () => {
    let resolveInspection!: (value: Awaited<ReturnType<
      typeof worktreeApi.inspectPreservedWorktree
    >>) => void;
    const inspection = new Promise<Awaited<ReturnType<
      typeof worktreeApi.inspectPreservedWorktree
    >>>((resolve) => {
      resolveInspection = resolve;
    });
    vi.mocked(worktreeApi.listOrphanedWorktrees).mockResolvedValue({
      success: true,
      worktrees: ['first', 'second'].map((slug) => ({
        branch: null,
        gitStatus: 'unchecked' as const,
        lastModifiedMs: 1_700_000_000_000,
        path: `/repo/.muxbase/worktrees/${slug}`,
        registration: 'unchecked' as const,
        slug,
      })),
    });
    vi.mocked(worktreeApi.inspectPreservedWorktree).mockReturnValue(inspection);

    render(<WorktreeOverviewModal onClose={vi.fn()} onJumpToPane={vi.fn()} />);
    await screen.findByText('first');
    fireEvent.click(screen.getByRole('button', {
      name: 'Remove preserved worktree first',
    }));
    await waitFor(() => {
      expect(worktreeApi.inspectPreservedWorktree).toHaveBeenCalledTimes(1);
    });

    const secondRemove = screen.getByRole('button', {
      name: 'Remove preserved worktree second',
    }) as HTMLButtonElement;
    expect(secondRemove.disabled).toBe(true);

    resolveInspection({
      success: false,
      error: 'inspection cancelled by test',
    });
    await waitFor(() => {
      expect(secondRemove.disabled).toBe(false);
    });
  });
});
