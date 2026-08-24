import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerWorktreeHandlers } from '../../src/main/ipc/worktree.handlers.js';
import { IPC } from '../../src/shared/ipc-channels.js';

const secureHandleMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/ipc/ipc-security.js', () => ({
  secureHandle: (channel: string, handler: unknown) => secureHandleMock(channel, handler),
}));
vi.mock('../../src/main/services/Logger.js', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const registration = secureHandleMock.mock.calls.find(([name]) => name === channel);
  if (!registration) throw new Error(`No handler for ${channel}`);
  return registration[1] as (...args: unknown[]) => Promise<unknown>;
}

describe('worktree IPC handlers', () => {
  beforeEach(() => secureHandleMock.mockClear());

  it('returns inspect and list success and failure shapes', async () => {
    const bridge = {
      inspectPreservedWorktree: vi.fn().mockResolvedValue({ success: true, worktree: { path: '/repo/wt' } }),
      listOrphanedWorktrees: vi.fn().mockResolvedValue({ success: true, worktrees: [] }),
    };
    registerWorktreeHandlers(bridge as never);
    await expect(
      handler(IPC.WORKTREE_ORPHAN_INSPECT)(undefined, {
        worktreePath: '/repo/wt',
      }),
    ).resolves.toEqual({ success: true, worktree: { path: '/repo/wt' } });
    await expect(handler(IPC.WORKTREE_ORPHANS_LIST)()).resolves.toEqual({
      success: true,
      worktrees: [],
    });

    bridge.inspectPreservedWorktree.mockRejectedValueOnce(new Error('gone'));
    bridge.listOrphanedWorktrees.mockRejectedValueOnce(new Error('scan failed'));
    await expect(
      handler(IPC.WORKTREE_ORPHAN_INSPECT)(undefined, {
        worktreePath: '/repo/wt',
      }),
    ).resolves.toEqual({ error: 'gone', success: false });
    await expect(handler(IPC.WORKTREE_ORPHANS_LIST)()).resolves.toEqual({
      error: 'scan failed',
      success: false,
      worktrees: [],
    });
  });

  it('runs removal through the project mutation coordinator and forwards concurrency fields', async () => {
    const runProjectMutation = vi.fn((operation: () => Promise<unknown>) => operation());
    const removePreservedWorktree = vi.fn().mockResolvedValue({ success: true });
    const expectedState = {
      branch: 'feature',
      gitStatus: 'clean',
      registration: 'registered',
    };
    registerWorktreeHandlers({
      removePreservedWorktree,
      runProjectMutation,
    } as never);
    await expect(
      handler(IPC.WORKTREE_REMOVE)(undefined, {
        allowDataLoss: true,
        expectedState,
        worktreePath: '/repo/wt',
      }),
    ).resolves.toEqual({ success: true });
    expect(removePreservedWorktree).toHaveBeenCalledWith('/repo/wt', true, expectedState);
    expect(runProjectMutation).toHaveBeenCalledOnce();

    runProjectMutation.mockRejectedValueOnce(new Error('stale project'));
    await expect(
      handler(IPC.WORKTREE_REMOVE)(undefined, {
        allowDataLoss: false,
        worktreePath: '/repo/wt',
      }),
    ).resolves.toEqual({ error: 'stale project', success: false });
  });

  it('runs reopen through the mutation coordinator and normalizes bridge failures', async () => {
    const runProjectMutation = vi.fn((operation: () => Promise<unknown>) => operation());
    const reopenWorktreePane = vi.fn().mockResolvedValue({ success: true, pane: { id: 'pane-1' } });
    registerWorktreeHandlers({
      reopenWorktreePane,
      runProjectMutation,
    } as never);
    await expect(handler(IPC.WORKTREE_REOPEN)(undefined, { worktreePath: '/repo/wt' })).resolves.toEqual({
      success: true,
      pane: { id: 'pane-1' },
    });
    expect(reopenWorktreePane).toHaveBeenCalledWith('/repo/wt');
    reopenWorktreePane.mockRejectedValueOnce(new Error('reopen failed'));
    await expect(handler(IPC.WORKTREE_REOPEN)(undefined, { worktreePath: '/repo/wt' })).resolves.toEqual({
      error: 'reopen failed',
      success: false,
    });
  });
});
