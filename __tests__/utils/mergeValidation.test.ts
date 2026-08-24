import { beforeEach, describe, expect, it, vi } from 'vitest';

const execAsyncWithStatusMock = vi.hoisted(() => vi.fn());
const execFileAsyncMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/utils/execAsync.js', () => ({
  execAsyncWithStatus: execAsyncWithStatusMock,
  execFileAsync: execFileAsyncMock,
}));

vi.mock('../../src/services/LogService.js', () => ({
  LogService: {
    getInstance: () => ({
      info: vi.fn(),
    }),
  },
}));

import { commitChanges, getGitStatus, predictMergeConflicts } from '../../src/utils/mergeValidation.js';

describe('merge validation git status', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset();
    execAsyncWithStatusMock.mockReset();
  });

  it('ignores Amux metadata paths when detecting uncommitted files', async () => {
    execFileAsyncMock.mockResolvedValue([
      '?? .aumx/',
      '?? .aumx-hooks/',
      ' M .aumx/settings.json',
      ' M .aumx-hooks/worktree_created',
      ' M src/index.ts',
    ].join('\n'));

    const status = await getGitStatus('/repo');

    expect(status.hasChanges).toBe(true);
    expect(status.files).toEqual(['src/index.ts']);
  });

  it('does not report changes when only Amux metadata is dirty', async () => {
    execFileAsyncMock.mockResolvedValue([
      '?? .aumx/',
      ' M .aumx-hooks/worktree_created',
    ].join('\n'));

    const status = await getGitStatus('/repo');

    expect(status.hasChanges).toBe(false);
    expect(status.files).toEqual([]);
  });

  it('fails closed when git status cannot inspect the worktree', async () => {
    execFileAsyncMock.mockRejectedValue(new Error('git status timed out'));

    await expect(getGitStatus('/repo')).rejects.toThrow('git status timed out');
  });

  it('allows production commit hooks enough time to finish', async () => {
    execFileAsyncMock.mockResolvedValue('');

    await expect(commitChanges('/repo', 'Apply changes')).resolves.toEqual({ success: true });

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'git',
      ['commit', '-m', 'Apply changes'],
      { cwd: '/repo', timeout: 300_000 },
    );
  });

  it('returns unknown when merge-tree capability is unavailable', async () => {
    execAsyncWithStatusMock.mockResolvedValue({ stdout: '', stderr: 'unknown option', exitCode: 129, timedOut: false });

    await expect(predictMergeConflicts('/repo', 'feature', 'main')).resolves.toEqual({
      prediction: 'unknown',
      conflictFiles: [],
    });
  });

  it('filters SHA-1 and SHA-256 merge-tree object IDs but keeps real conflict paths', async () => {
    const sha1ObjectId = 'a'.repeat(40);
    const sha256ObjectId = 'b'.repeat(64);
    execAsyncWithStatusMock.mockResolvedValue({
      stdout: [sha1ObjectId, sha256ObjectId, 'src/conflicted.ts'].join('\n'),
      stderr: '',
      exitCode: 1,
      timedOut: false,
    });

    await expect(predictMergeConflicts('/repo', 'feature', 'main')).resolves.toEqual({
      prediction: 'conflicted',
      conflictFiles: ['src/conflicted.ts'],
    });
  });
});
