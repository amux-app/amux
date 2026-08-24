// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react';
import type { AumxPane } from 'aumx/core';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';
import { useWorktreeStatus } from '../../src/renderer/hooks/useWorktreeStatus';
import { useWorktreeStatusStore } from '../../src/renderer/stores/worktree-status.store';

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('../../src/renderer/api/ipc', () => ipc);

const SHARED_WORKTREE = '/repo/worktrees/shared';
const OTHER_WORKTREE = '/repo/worktrees/other';

function pane(id: string, worktreePath: string): AumxPane {
  return { id, paneId: `%${id}`, prompt: 'p', slug: id, worktreePath };
}

function Harness({ panes }: Readonly<{ panes: AumxPane[] }>) {
  useWorktreeStatus(panes);
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function statusRequests(): string[] {
  return ipc.invoke.mock.calls
    .filter((call) => call[0] === IPC.GIT_STATUS)
    .map((call) => (call[1] as { worktreePath: string }).worktreePath);
}

describe('useWorktreeStatus', () => {
  beforeEach(() => {
    ipc.invoke.mockResolvedValue({
      commitsAhead: 2,
      deletions: 1,
      filesChanged: 3,
      hasChanges: true,
      insertions: 4,
    });
    useWorktreeStatusStore.setState({ statuses: {} });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('issues one git status request for every pane sharing a worktree', async () => {
    // Arrange
    const panes = ['a', 'b', 'c', 'd', 'e'].map((id) => pane(id, SHARED_WORKTREE));

    // Act
    render(<Harness panes={panes} />);
    await flush();

    // Assert
    expect(statusRequests()).toEqual([SHARED_WORKTREE]);
  });

  it('applies the shared result to every pane on that worktree', async () => {
    // Arrange
    const panes = ['a', 'b', 'c'].map((id) => pane(id, SHARED_WORKTREE));

    // Act
    render(<Harness panes={panes} />);
    await flush();

    // Assert
    const { statuses } = useWorktreeStatusStore.getState();
    expect(Object.keys(statuses).sort()).toEqual(['a', 'b', 'c']);
    expect(statuses.b?.filesChanged).toBe(3);
    expect(statuses.c?.insertions).toBe(4);
  });

  it('skips a rescan when a pane update leaves the worktree set unchanged', async () => {
    // Arrange
    const { rerender } = render(<Harness panes={[pane('a', SHARED_WORKTREE)]} />);
    await flush();

    // Act
    rerender(<Harness panes={[pane('a', SHARED_WORKTREE)]} />);
    await flush();

    // Assert
    expect(statusRequests()).toEqual([SHARED_WORKTREE]);
  });

  it('rescans as soon as a pane introduces a new worktree', async () => {
    // Arrange
    const { rerender } = render(<Harness panes={[pane('a', SHARED_WORKTREE)]} />);
    await flush();

    // Act
    rerender(<Harness panes={[pane('a', SHARED_WORKTREE), pane('b', OTHER_WORKTREE)]} />);
    await flush();

    // Assert
    expect(statusRequests()).toContain(OTHER_WORKTREE);
  });

  it('still scans distinct worktrees separately', async () => {
    // Arrange
    const panes = [pane('a', SHARED_WORKTREE), pane('b', SHARED_WORKTREE), pane('c', OTHER_WORKTREE)];

    // Act
    render(<Harness panes={panes} />);
    await flush();

    // Assert
    expect(statusRequests().sort()).toEqual([OTHER_WORKTREE, SHARED_WORKTREE]);
  });

  it('eventually scans every worktree when there are more paths than concurrency slots', async () => {
    // Arrange
    vi.useFakeTimers();
    const panes = ['/repo/a', '/repo/b', '/repo/c', '/repo/d'].map((path, index) =>
      pane(String(index), path),
    );

    try {
      render(<Harness panes={panes} />);
      await flush();
      expect(statusRequests()).toEqual(['/repo/a', '/repo/b', '/repo/c']);

      // Act
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await flush();

      // Assert
      expect(statusRequests()).toContain('/repo/d');
    } finally {
      vi.useRealTimers();
    }
  });
});
