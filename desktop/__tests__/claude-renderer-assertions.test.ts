import { describe, expect, it, vi } from 'vitest';
import { assertStableSingleClaudeHeader } from './e2e/claude-renderer-assertions';

describe('Claude renderer header assertion', () => {
  it('rejects immediately when the first sample contains a duplicate header', async () => {
    const counts = [2, 1, 1, 1, 1];
    const readCount = vi.fn(async () => counts.shift() ?? null);

    await expect(assertStableSingleClaudeHeader(readCount, {
      interval: 0,
      timeout: 100,
    })).rejects.toThrow('expected 1, received 2');
    expect(readCount).toHaveBeenCalledTimes(1);
  });

  it('accepts four consecutive samples containing exactly one header', async () => {
    const counts = [1, 1, 1, 1];
    const readCount = vi.fn(async () => counts.shift() ?? null);

    await expect(assertStableSingleClaudeHeader(readCount, {
      interval: 0,
      timeout: 100,
    })).resolves.toBeUndefined();
    expect(readCount).toHaveBeenCalledTimes(4);
  });
});
