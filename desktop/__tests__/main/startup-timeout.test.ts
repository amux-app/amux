import { describe, expect, it, vi } from 'vitest';
import {
  StartupTimeoutError,
  waitForOperationSettlement,
  withStartupTimeout,
} from '../../src/main/services/startup-timeout';

describe('withStartupTimeout', () => {
  it('returns the operation result and clears its watchdog', async () => {
    await expect(withStartupTimeout(Promise.resolve('ready'), 100, 'Workspace startup'))
      .resolves.toBe('ready');
  });

  it('rejects a stalled operation with an actionable startup error', async () => {
    vi.useFakeTimers();
    try {
      const stalled = new Promise<never>(() => {});
      const result = withStartupTimeout(stalled, 30_000, 'Workspace startup');
      const rejection = expect(result).rejects.toEqual(
        new StartupTimeoutError('Workspace startup', 30_000),
      );

      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('waitForOperationSettlement', () => {
  it('reports a completed startup operation', async () => {
    await expect(waitForOperationSettlement(Promise.resolve(), 100))
      .resolves.toBe('settled');
  });

  it('bounds shutdown when startup ignores cancellation', async () => {
    vi.useFakeTimers();
    try {
      const stalled = new Promise<never>(() => {});
      const result = waitForOperationSettlement(stalled, 3_000);

      await vi.advanceTimersByTimeAsync(3_000);
      await expect(result).resolves.toBe('timed-out');
    } finally {
      vi.useRealTimers();
    }
  });
});
