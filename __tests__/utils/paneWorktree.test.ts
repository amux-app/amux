// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsyncMock = vi.fn();
const existsSyncMock = vi.fn();

vi.mock('fs', () => ({
  existsSync: (path: string) => existsSyncMock(path),
}));

vi.mock('../../src/utils/execAsync.js', () => ({
  execFileAsync: (...args: unknown[]) => execFileAsyncMock(...args),
}));

vi.mock('../../src/utils/git.js', () => ({
  isValidBranchName: (name: string) => /^[A-Za-z0-9._/-]+$/.test(name),
}));

vi.mock('../../src/utils/paneCreationGit.js', () => ({
  buildGitRefVerifyArgs: (ref: string) => ['show-ref', '--verify', '--quiet', `refs/heads/${ref}`],
  buildGitWorktreeAddArgs: ({
    branchName,
    createBranch,
    startPoint,
    worktreePath,
  }: {
    branchName: string;
    createBranch: boolean;
    startPoint?: string;
    worktreePath: string;
  }) => [
    'worktree',
    'add',
    ...(createBranch ? ['-b', branchName] : []),
    '--',
    worktreePath,
    ...(startPoint ? [startPoint] : createBranch ? [] : [branchName]),
  ],
}));

const getSettingsMock = vi.fn();
vi.mock('../../src/utils/settingsManager.js', () => ({
  SettingsManager: vi.fn(() => ({ getSettings: getSettingsMock })),
}));

vi.mock('../../src/services/LogService.js', () => ({
  LogService: {
    getInstance: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

vi.mock('../../src/services/TmuxService.js', () => ({
  TmuxService: {
    getInstance: vi.fn(() => {
      throw new Error('createWorktreeForPane must not touch TmuxService — it should run git directly from Node.');
    }),
  },
}));

vi.mock('../../src/utils/worktreePaths.js', () => ({
  getManagedWorktreePath: (root: string, slug: string) => `${root}/.muxbase/worktrees/${slug}`,
}));

import type { MuxBasePane } from '../../src/types.js';
import { createWorktreeForPane } from '../../src/utils/paneWorktree.js';

const basePane: MuxBasePane = {
  id: 'muxbase-1',
  slug: 'swift-otter',
  prompt: '',
  paneId: '%1',
  projectRoot: '/repo',
  projectName: 'repo',
};

beforeEach(() => {
  execFileAsyncMock.mockReset();
  existsSyncMock.mockReset();
  getSettingsMock.mockReset();

  getSettingsMock.mockReturnValue({ branchPrefix: '', baseBranch: '' });
  execFileAsyncMock.mockResolvedValue('');
});

describe('createWorktreeForPane', () => {
  const worktreeAddCalls = () => execFileAsyncMock.mock.calls.filter(([, args]) => (
    args[0] === 'worktree' && args[1] === 'add'
  ));

  it('runs `git worktree add` from Node and returns the new worktree path', async () => {
    // Branch does NOT exist yet (show-ref fails); target dir does not exist
    // pre-add but appears after.
    execFileAsyncMock.mockImplementation(async (_bin: string, args: string[]) => {
      if (args[0] === 'show-ref') throw new Error('not found');
      if (args[0] === 'worktree' && args[1] === 'add') added = true;
      return '';
    });
    let added = false;
    existsSyncMock.mockImplementation((path: string) => path.includes('swift-otter') && added);

    const result = await createWorktreeForPane(basePane, '/repo');

    expect(result).toEqual({
      worktreePath: '/repo/.muxbase/worktrees/swift-otter',
      branchName: 'swift-otter',
    });

    // The actual git command is an argv array, NOT a shell or tmux send.
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '-b', 'swift-otter', '--', '/repo/.muxbase/worktrees/swift-otter'],
      { cwd: '/repo', timeout: 60000 },
    );
  });

  it('attaches to an existing branch instead of recreating it', async () => {
    execFileAsyncMock.mockImplementation(async (_bin: string, args: string[]) => {
      if (args[0] === 'show-ref') return ''; // branch DOES exist
      if (args[0] === 'worktree' && args[1] === 'add') added = true;
      return '';
    });
    let added = false;
    existsSyncMock.mockImplementation((path: string) => path.includes('swift-otter') && added);

    await createWorktreeForPane(basePane, '/repo');

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '--', '/repo/.muxbase/worktrees/swift-otter', 'swift-otter'],
      { cwd: '/repo', timeout: 60000 },
    );
  });

  it('refuses when the target directory already exists', async () => {
    execFileAsyncMock.mockImplementation(async (_bin: string, args: string[]) => {
      if (args[0] === 'show-ref') throw new Error('not found');
      return '';
    });
    existsSyncMock.mockReturnValue(true); // directory already there

    await expect(createWorktreeForPane(basePane, '/repo')).rejects.toThrow(/already exists/);
    expect(worktreeAddCalls()).toHaveLength(0);
  });

  it('rejects an invalid branch name without calling git', async () => {
    const bad: MuxBasePane = { ...basePane, slug: 'has spaces' };
    await expect(createWorktreeForPane(bad, '/repo')).rejects.toThrow(/Invalid branch name/);
    expect(worktreeAddCalls()).toHaveLength(0);
  });

  it('honours baseBranch setting when creating a new branch', async () => {
    getSettingsMock.mockReturnValue({ branchPrefix: '', baseBranch: 'main' });
    execFileAsyncMock.mockImplementation(async (_bin: string, args: string[]) => {
      if (args[0] === 'show-ref' && args[3] === 'refs/heads/swift-otter') throw new Error('not found');
      if (args[0] === 'worktree' && args[1] === 'add') added = true;
      return '';
    });
    let added = false;
    existsSyncMock.mockImplementation((path: string) => path.includes('swift-otter') && added);

    await createWorktreeForPane(basePane, '/repo');

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '-b', 'swift-otter', '--', '/repo/.muxbase/worktrees/swift-otter', 'main'],
      { cwd: '/repo', timeout: 60000 },
    );
  });

  it('surfaces git failure without reporting a worktree or retrying through a shell', async () => {
    execFileAsyncMock.mockImplementation(async (_bin: string, args: string[]) => {
      if (args[0] === 'show-ref') throw new Error('not found');
      if (args[0] === 'worktree' && args[1] === 'add') {
        throw new Error('simulated worktree failure');
      }
      return '';
    });
    existsSyncMock.mockReturnValue(false);

    await expect(createWorktreeForPane(basePane, '/repo')).rejects.toThrow(
      'Failed to create worktree: simulated worktree failure',
    );
    expect(worktreeAddCalls()).toHaveLength(1);
    expect(existsSyncMock).not.toHaveReturnedWith(true);
  });

  it('returns null when the pane already has a worktree', async () => {
    const already: MuxBasePane = { ...basePane, worktreePath: '/repo/.muxbase/worktrees/swift-otter' };
    const result = await createWorktreeForPane(already, '/repo');
    expect(result).toBeNull();
    expect(worktreeAddCalls()).toHaveLength(0);
  });
});
