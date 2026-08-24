import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileAsync } from '../../src/utils/execAsync.js';
import { TmuxService } from '../../src/services/TmuxService.js';

vi.mock('../../src/utils/execAsync.js', () => ({
  execFileAsync: vi.fn(),
}));

describe('TmuxService.paneExists', () => {
  const tmux = TmuxService.getInstance();

  beforeEach(() => {
    vi.mocked(execFileAsync).mockReset();
  });

  it('retries a transient tmux execution failure and returns true once the pane answers', async () => {
    // Arrange
    vi.mocked(execFileAsync)
      .mockRejectedValueOnce(new Error('tmux server not responding'))
      .mockResolvedValueOnce('%42');

    // Act / Assert
    await expect(tmux.paneExists('%42')).resolves.toBe(true);
    expect(execFileAsync).toHaveBeenCalledTimes(2);
  });

  it('returns false without retrying when the pane is permanently missing', async () => {
    // Arrange
    vi.mocked(execFileAsync).mockRejectedValue(new Error("can't find pane: %99"));

    // Act / Assert
    await expect(tmux.paneExists('%99')).resolves.toBe(false);
    expect(execFileAsync).toHaveBeenCalledTimes(1);
  });

  it('returns false when the command resolves output for a different pane id', async () => {
    // Arrange
    vi.mocked(execFileAsync).mockResolvedValue('%1');

    // Act / Assert
    await expect(tmux.paneExists('%2')).resolves.toBe(false);
    expect(execFileAsync).toHaveBeenCalledTimes(1);
  });
});
