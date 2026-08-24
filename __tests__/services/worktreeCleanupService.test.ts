import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreeCleanupService } from '../../src/services/WorktreeCleanupService.js';
import type { WorktreeInfo } from '../../src/actions/merge/types.js';
import type { AumxPane } from '../../src/types.js';

const detectAllWorktreesMock = vi.hoisted(() => vi.fn());
const triggerHookMock = vi.hoisted(() => vi.fn());
const inspectConflictMergeStateMock = vi.hoisted(() => vi.fn());
const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));
const spawnState = vi.hoisted(() => ({
  calls: [] as Array<{ args: string[]; command: string; cwd: string }>,
  exitCodes: [] as number[],
}));

vi.mock('child_process', () => ({
  spawn: (command: string, args: string[], options: { cwd?: string }) => {
    spawnState.calls.push({
      args: [...args],
      command,
      cwd: options.cwd ?? '',
    });

    const child = new EventEmitter() as EventEmitter & { stderr: PassThrough };
    child.stderr = new PassThrough();
    const exitCode = spawnState.exitCodes.shift() ?? 0;
    queueMicrotask(() => child.emit('close', exitCode));
    return child;
  },
}));

vi.mock('../../src/services/LogService.js', () => ({
  LogService: {
    getInstance: () => loggerMock,
  },
}));

vi.mock('../../src/utils/hooks.js', () => ({
  triggerHook: triggerHookMock,
}));

vi.mock('../../src/utils/worktreeDiscovery.js', () => ({
  detectAllWorktrees: detectAllWorktreesMock,
}));

vi.mock('../../src/utils/conflictMergeTransaction.js', () => ({
  getConflictMergeTransaction: vi.fn(() => undefined),
  inspectConflictMergeState: inspectConflictMergeStateMock,
}));

const rootWorktreePath = '/repo/.aumx/worktrees/feature-a';

function createPane(): AumxPane {
  return {
    branchName: 'feature/a',
    id: 'pane-1',
    paneId: '%1',
    prompt: 'build feature',
    slug: 'feature-a',
    worktreePath: rootWorktreePath,
  };
}

function createWorktreeInfo(overrides: Partial<WorktreeInfo>): WorktreeInfo {
  return {
    branch: 'feature/a',
    depth: 0,
    isRoot: false,
    mainBranch: 'main',
    parentRepoPath: '/repo',
    relativePath: '.',
    repoName: 'repo',
    worktreePath: rootWorktreePath,
    ...overrides,
  };
}

describe('WorktreeCleanupService', () => {
  beforeEach(() => {
    detectAllWorktreesMock.mockReset();
    triggerHookMock.mockReset();
    triggerHookMock.mockResolvedValue(undefined);
    loggerMock.debug.mockReset();
    loggerMock.error.mockReset();
    loggerMock.warn.mockReset();
    spawnState.calls = [];
    spawnState.exitCodes = [];
    inspectConflictMergeStateMock.mockResolvedValue({ status: 'clean', unmergedFiles: [] });
  });

  it('removes nested worktrees deepest first and deletes matching branches per repository', async () => {
    const pane = createPane();
    const nestedWorktreePath = `${rootWorktreePath}/packages/api`;
    detectAllWorktreesMock.mockResolvedValue([
      createWorktreeInfo({
        isRoot: true,
      }),
      createWorktreeInfo({
        depth: 1,
        parentRepoPath: '/repo/packages/api',
        relativePath: 'packages/api',
        repoName: 'api',
        worktreePath: nestedWorktreePath,
      }),
    ]);

    await new WorktreeCleanupService().enqueueCleanup({
      deleteBranch: true,
      mainRepoPath: '/repo',
      pane,
      paneProjectRoot: '/repo',
    });

    expect(spawnState.calls).toEqual([
      {
        args: ['worktree', 'remove', nestedWorktreePath, '--force'],
        command: 'git',
        cwd: '/repo/packages/api',
      },
      {
        args: ['worktree', 'remove', rootWorktreePath, '--force'],
        command: 'git',
        cwd: '/repo',
      },
      {
        args: ['show-ref', '--verify', '--quiet', 'refs/heads/feature/a'],
        command: 'git',
        cwd: '/repo',
      },
      {
        args: ['branch', '-D', 'feature/a'],
        command: 'git',
        cwd: '/repo',
      },
      {
        args: ['show-ref', '--verify', '--quiet', 'refs/heads/feature/a'],
        command: 'git',
        cwd: '/repo/packages/api',
      },
      {
        args: ['branch', '-D', 'feature/a'],
        command: 'git',
        cwd: '/repo/packages/api',
      },
    ]);
    expect(triggerHookMock).toHaveBeenCalledWith('worktree_removed', '/repo', pane);
  });

  it('skips branch deletion when the branch does not exist', async () => {
    const pane = createPane();
    detectAllWorktreesMock.mockResolvedValue([
      createWorktreeInfo({
        isRoot: true,
      }),
    ]);
    spawnState.exitCodes = [0, 1];

    await new WorktreeCleanupService().enqueueCleanup({
      deleteBranch: true,
      mainRepoPath: '/repo',
      pane,
      paneProjectRoot: '/repo',
    });

    expect(spawnState.calls).toEqual([
      {
        args: ['worktree', 'remove', rootWorktreePath, '--force'],
        command: 'git',
        cwd: '/repo',
      },
      {
        args: ['show-ref', '--verify', '--quiet', 'refs/heads/feature/a'],
        command: 'git',
        cwd: '/repo',
      },
    ]);
  });

  it('falls back to the root worktree when nested discovery fails', async () => {
    const pane = createPane();
    detectAllWorktreesMock.mockImplementation(() => {
      throw new Error('scan failed');
    });

    await new WorktreeCleanupService().enqueueCleanup({
      deleteBranch: false,
      mainRepoPath: '/repo',
      pane,
      paneProjectRoot: '/repo',
    });

    expect(spawnState.calls).toEqual([
      {
        args: ['worktree', 'remove', rootWorktreePath, '--force'],
        command: 'git',
        cwd: '/repo',
      },
    ]);
    expect(loggerMock.debug).toHaveBeenCalledWith(
      'Failed to detect nested worktrees for feature-a: scan failed',
      'paneActions',
      'pane-1'
    );
  });

  it('fails closed when merge-state inspection cannot prove the worktree is clean', async () => {
    inspectConflictMergeStateMock.mockResolvedValueOnce({
      status: 'failed',
      unmergedFiles: [],
      error: 'git inspection failed',
    });

    await new WorktreeCleanupService().enqueueCleanup({
      deleteBranch: true,
      mainRepoPath: '/repo',
      pane: createPane(),
      paneProjectRoot: '/repo',
    });

    expect(spawnState.calls).toEqual([]);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Skipping cleanup for feature-a: conflict merge state is still active',
      'paneActions',
      'pane-1',
    );
  });
});
