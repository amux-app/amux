import { describe, expect, it, vi } from 'vitest';
import { createSubmissionGate } from '../../src/renderer/lib/submission-gate';

describe('submission gate', () => {
  it('runs only one task while a submission is already pending', async () => {
    const gate = createSubmissionGate();
    let releaseTask: (() => void) | undefined;
    const task = vi.fn(() => new Promise<string>((resolve) => {
      releaseTask = () => resolve('created');
    }));

    const first = gate.run(task);
    const second = await gate.run(task);

    expect(gate.isRunning()).toBe(true);
    expect(second).toBeUndefined();
    expect(task).toHaveBeenCalledTimes(1);

    releaseTask?.();
    await expect(first).resolves.toBe('created');
    expect(gate.isRunning()).toBe(false);
  });
});
