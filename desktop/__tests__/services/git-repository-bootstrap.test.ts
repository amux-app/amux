import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execAsyncMock } = vi.hoisted(() => ({
  execAsyncMock: vi.fn(),
}));

vi.mock('muxbase/core', () => ({
  execAsync: execAsyncMock,
}));

import { ensureGitRepository } from '../../src/main/services/GitRepositoryBootstrap';

describe('GitRepositoryBootstrap', () => {
  beforeEach(() => {
    execAsyncMock.mockReset();
  });

  it('returns ready when repository already exists', async () => {
    execAsyncMock.mockResolvedValueOnce('true\n');

    const result = await ensureGitRepository('/tmp/project', { initIfMissing: true });

    expect(result).toEqual({ initialized: false, isReady: true });
    expect(execAsyncMock).toHaveBeenCalledTimes(1);
    expect(execAsyncMock.mock.calls[0][0]).toContain('rev-parse --is-inside-work-tree');
  });

  it('returns not ready when repository is missing and auto init is disabled', async () => {
    execAsyncMock.mockResolvedValueOnce('false');

    const result = await ensureGitRepository('/tmp/project', { initIfMissing: false });

    expect(result).toEqual({ initialized: false, isReady: false });
    expect(execAsyncMock).toHaveBeenCalledTimes(1);
  });

  it('initializes repository when missing and auto init is enabled', async () => {
    execAsyncMock
      .mockResolvedValueOnce('false')
      .mockResolvedValueOnce('true');

    const result = await ensureGitRepository('/tmp/project', { initIfMissing: true });

    expect(result).toEqual({ initialized: true, isReady: true });
    expect(execAsyncMock).toHaveBeenCalledTimes(2);
    expect(execAsyncMock.mock.calls[1][0]).toContain(' init -q');
  });
});
