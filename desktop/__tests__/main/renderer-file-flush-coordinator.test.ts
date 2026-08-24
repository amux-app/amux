import { afterEach, describe, expect, it, vi } from 'vitest';
import { RendererFileFlushCoordinator } from '../../src/main/services/RendererFileFlushCoordinator';

describe('RendererFileFlushCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for the matching renderer flush result', async () => {
    // Arrange
    const coordinator = new RendererFileFlushCoordinator();
    const send = vi.fn();

    // Act
    const result = coordinator.request(send);
    const requestId = send.mock.calls[0]?.[0] as string;
    const accepted = coordinator.complete({ requestId, success: true });

    // Assert
    await expect(result).resolves.toBe(true);
    expect(accepted).toBe(true);
  });

  it('ignores stale responses and coalesces concurrent quit requests', async () => {
    // Arrange
    const coordinator = new RendererFileFlushCoordinator();
    const send = vi.fn();

    // Act
    const first = coordinator.request(send);
    const second = coordinator.request(send);
    const requestId = send.mock.calls[0]?.[0] as string;

    // Assert
    expect(first).toBe(second);
    expect(send).toHaveBeenCalledTimes(1);
    expect(coordinator.complete({ requestId: 'stale', success: true })).toBe(false);

    // Act
    coordinator.complete({ requestId, success: false });

    // Assert
    await expect(first).resolves.toBe(false);
  });

  it('refuses to quit when the renderer does not answer before the timeout', async () => {
    // Arrange
    vi.useFakeTimers();
    const coordinator = new RendererFileFlushCoordinator(5_000);

    // Act
    const result = coordinator.request(vi.fn());
    await vi.advanceTimersByTimeAsync(5_000);

    // Assert
    await expect(result).resolves.toBe(false);
  });
});
