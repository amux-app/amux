import { describe, expect, it, vi } from 'vitest';
import {
  createDiscardUnsavedChangesOptions,
  runGuardedApplicationQuit,
  runGuardedRendererAction,
  runSingleFlight,
  shouldBypassQuitDiscardPrompt,
  type QuitShutdownResult,
} from '../../src/main/services/UnsavedChangesGuard';

describe('UnsavedChangesGuard', () => {
  it('runs the action after the renderer saves successfully', async () => {
    const confirmDiscard = vi.fn();
    const perform = vi.fn();

    await expect(runGuardedRendererAction({
      confirmDiscard,
      perform,
      requestFlush: vi.fn().mockResolvedValue(true),
    })).resolves.toBe(true);

    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(perform).toHaveBeenCalledOnce();
  });

  it('does not reload when saving fails and the user cancels', async () => {
    const perform = vi.fn();

    await expect(runGuardedRendererAction({
      confirmDiscard: vi.fn().mockResolvedValue(false),
      perform,
      requestFlush: vi.fn().mockResolvedValue(false),
    })).resolves.toBe(false);

    expect(perform).not.toHaveBeenCalled();
  });

  it('reloads when saving fails and the user explicitly discards the draft', async () => {
    const perform = vi.fn();

    await expect(runGuardedRendererAction({
      confirmDiscard: vi.fn().mockResolvedValue(true),
      perform,
      requestFlush: vi.fn().mockResolvedValue(false),
    })).resolves.toBe(true);

    expect(perform).toHaveBeenCalledOnce();
  });

  it('awaits an asynchronous guarded action before reporting success', async () => {
    let finishPerform!: () => void;
    const perform = vi.fn(() => new Promise<void>((resolve) => {
      finishPerform = resolve;
    }));
    let settled = false;

    const result = runGuardedRendererAction({
      confirmDiscard: vi.fn(),
      perform,
      requestFlush: vi.fn().mockResolvedValue(true),
    }).finally(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(perform).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    finishPerform();
    await expect(result).resolves.toBe(true);
  });

  it('runs the complete quit path after the renderer saves successfully', async () => {
    const finishQuit = vi.fn();
    const forceExit = vi.fn();
    const shutdown = vi.fn().mockResolvedValue('complete');

    await expect(runGuardedApplicationQuit({
      confirmDiscard: vi.fn(),
      finishQuit,
      forceExit,
      requestFlush: vi.fn().mockResolvedValue(true),
      shutdown,
      shutdownTimeoutMs: 5_000,
    })).resolves.toBe(true);

    expect(shutdown).toHaveBeenCalledOnce();
    expect(finishQuit).toHaveBeenCalledOnce();
    expect(forceExit).not.toHaveBeenCalled();
  });

  it('keeps the app running when shutdown cancels for an active conflict merge', async () => {
    const finishQuit = vi.fn();
    const forceExit = vi.fn();

    await expect(runGuardedApplicationQuit({
      confirmDiscard: vi.fn(),
      finishQuit,
      forceExit,
      requestFlush: vi.fn().mockResolvedValue(true),
      shutdown: vi.fn().mockResolvedValue('cancelled'),
      shutdownTimeoutMs: 5_000,
    })).resolves.toBe(false);

    expect(finishQuit).not.toHaveBeenCalled();
    expect(forceExit).not.toHaveBeenCalled();
  });

  it('keeps the app running when a dirty draft cannot be saved and discard is cancelled', async () => {
    const finishQuit = vi.fn();
    const shutdown = vi.fn();

    await expect(runGuardedApplicationQuit({
      confirmDiscard: vi.fn().mockResolvedValue(false),
      finishQuit,
      forceExit: vi.fn(),
      requestFlush: vi.fn().mockResolvedValue(false),
      shutdown,
      shutdownTimeoutMs: 5_000,
    })).resolves.toBe(false);

    expect(shutdown).not.toHaveBeenCalled();
    expect(finishQuit).not.toHaveBeenCalled();
  });

  it('uses the force-exit path when graceful shutdown times out', async () => {
    const finishQuit = vi.fn();
    const forceExit = vi.fn();

    await expect(runGuardedApplicationQuit({
      confirmDiscard: vi.fn().mockResolvedValue(true),
      finishQuit,
      forceExit,
      requestFlush: vi.fn().mockResolvedValue(false),
      shutdown: vi.fn().mockResolvedValue('force-exit'),
      shutdownTimeoutMs: 5_000,
    })).resolves.toBe(true);

    expect(forceExit).toHaveBeenCalledOnce();
    expect(finishQuit).not.toHaveBeenCalled();
  });

  it('force-exits when any part of graceful shutdown exceeds the global deadline', async () => {
    vi.useFakeTimers();
    try {
      const finishQuit = vi.fn();
      const forceExit = vi.fn();
      const shutdown = vi.fn(() => new Promise<QuitShutdownResult>(() => {}));
      const result = runGuardedApplicationQuit({
        confirmDiscard: vi.fn(),
        finishQuit,
        forceExit,
        requestFlush: vi.fn().mockResolvedValue(true),
        shutdown,
        shutdownTimeoutMs: 5_000,
      });

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(result).resolves.toBe(true);
      expect(shutdown).toHaveBeenCalledOnce();
      expect(forceExit).toHaveBeenCalledOnce();
      expect(finishQuit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never starts the shutdown deadline before the renderer flush settles', async () => {
    vi.useFakeTimers();
    try {
      let resolveFlush!: (success: boolean) => void;
      const requestFlush = vi.fn(() => new Promise<boolean>((resolve) => {
        resolveFlush = resolve;
      }));
      const forceExit = vi.fn();
      const shutdown = vi.fn(() => new Promise<QuitShutdownResult>(() => {}));
      const result = runGuardedApplicationQuit({
        confirmDiscard: vi.fn(),
        finishQuit: vi.fn(),
        forceExit,
        requestFlush,
        shutdown,
        shutdownTimeoutMs: 5_000,
      });

      await vi.advanceTimersByTimeAsync(30_000);
      expect(shutdown).not.toHaveBeenCalled();
      expect(forceExit).not.toHaveBeenCalled();

      resolveFlush(true);
      await Promise.resolve();
      expect(shutdown).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(result).resolves.toBe(true);
      expect(forceExit).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bypasses only the quit discard modal during automated Electron teardown', () => {
    expect(shouldBypassQuitDiscardPrompt({
      AUMX_E2E: '1',
      NODE_ENV: 'test',
    }, false)).toBe(true);
    expect(shouldBypassQuitDiscardPrompt({
      AUMX_E2E: '0',
      NODE_ENV: 'test',
    }, false)).toBe(false);
    expect(shouldBypassQuitDiscardPrompt({
      AUMX_E2E: '1',
      NODE_ENV: 'production',
    }, false)).toBe(false);
    expect(shouldBypassQuitDiscardPrompt({
      AUMX_E2E: '1',
      NODE_ENV: 'test',
    }, true)).toBe(false);
  });

  it('coalesces repeated guarded actions until the first attempt settles', async () => {
    let finishAction!: () => void;
    const action = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        finishAction = resolve;
      }))
      .mockResolvedValueOnce(undefined);
    const run = runSingleFlight(action);

    const first = run(false);
    const second = run(true);

    expect(second).toBe(first);
    expect(action).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledWith(false);

    finishAction();
    await first;
    await run(true);

    expect(action).toHaveBeenCalledTimes(2);
    expect(action).toHaveBeenLastCalledWith(true);
  });

  it('uses action-specific wording for quit, reload, and update-restart prompts', () => {
    expect(createDiscardUnsavedChangesOptions('quit')).toMatchObject({
      buttons: ['Cancel', 'Discard and Quit'],
      detail: expect.stringContaining('Quitting now'),
    });
    expect(createDiscardUnsavedChangesOptions('reload')).toMatchObject({
      buttons: ['Cancel', 'Discard and Reload'],
      detail: expect.stringContaining('Reloading now'),
    });
    expect(createDiscardUnsavedChangesOptions('update')).toMatchObject({
      buttons: ['Cancel', 'Discard, Restart, and Update'],
      detail: expect.stringContaining('Restarting to update now'),
    });
  });
});
