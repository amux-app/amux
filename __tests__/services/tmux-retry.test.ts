import { describe, expect, it, vi } from 'vitest';
import { executeWithRetry, RetryStrategy } from '../../src/services/tmux-retry.js';

describe('tmux retry', () => {
  it('retries asynchronous transient operations and returns their resolved value', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('temporary tmux startup failure'))
      .mockResolvedValueOnce('ok');
    const logger = { debug: vi.fn() } as never;

    await expect(executeWithRetry(operation, logger, RetryStrategy.FAST, 'paneExists')).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not retry permanent asynchronous failures', async () => {
    const operation = vi.fn().mockRejectedValue(new Error("can't find pane"));
    const logger = { debug: vi.fn() } as never;

    await expect(executeWithRetry(operation, logger, RetryStrategy.IDEMPOTENT)).rejects.toThrow("can't find pane");
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
