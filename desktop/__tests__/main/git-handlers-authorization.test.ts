import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerGitHandlers } from '../../src/main/ipc/git.handlers';
import { IPC } from '../../src/shared/ipc-channels';

const collectWorkingTreeFilePatchMock = vi.hoisted(() => vi.fn());
const getWorktreeSnapshotMock = vi.hoisted(() => vi.fn());
const gitMock = vi.hoisted(() => vi.fn());
const safeGitMock = vi.hoisted(() => vi.fn());
const secureHandleMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/main/ipc/ipc-security.js', () => ({
  secureHandle: (channel: string, handler: unknown) => secureHandleMock(channel, handler),
}));

vi.mock('../../src/main/services/git/gitDiff.js', () => ({
  collectRangeDiffData: vi.fn(),
  collectRangeFilePatch: vi.fn(),
  collectWorkingTreeFilePatch: collectWorkingTreeFilePatchMock,
  getWorktreeMeta: vi.fn(),
  getWorktreeSnapshot: getWorktreeSnapshotMock,
  git: gitMock,
  resolveBaseBranch: vi.fn(),
  safeGit: safeGitMock,
}));

vi.mock('../../src/main/services/Logger.js', () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../../src/main/services/RuntimeActivityMetrics.js', () => ({
  RuntimeActivityMetrics: {
    getInstance: () => ({ recordGitStatusPoll: vi.fn() }),
  },
}));

const PROJECT_ROOT = '/workspace/app';
const WORKTREE_PATH = '/workspace/app-worktrees/task-a';
const UNAUTHORIZED_ERROR = 'Unauthorized file root';

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const registration = secureHandleMock.mock.calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!registration) throw new Error(`missing handler registration for ${channel}`);
  return registration[1] as (...args: unknown[]) => unknown;
}

describe('git IPC handler authorization', () => {
  beforeEach(() => {
    collectWorkingTreeFilePatchMock.mockReset().mockResolvedValue({ path: 'src/index.ts', patch: '' });
    getWorktreeSnapshotMock.mockReset().mockResolvedValue(null);
    gitMock.mockReset().mockResolvedValue('* main');
    safeGitMock.mockReset().mockResolvedValue(WORKTREE_PATH);
    secureHandleMock.mockClear();

    registerGitHandlers({
      getPanes: () => [{ projectRoot: PROJECT_ROOT, worktreePath: WORKTREE_PATH }],
      getProjectRoot: () => PROJECT_ROOT,
    } as never);
  });

  it('rejects git roots outside the project and its pane worktrees', async () => {
    // Arrange
    const outsideRoots = ['/etc', `${PROJECT_ROOT}/../../etc`];

    // Act
    const results = await Promise.all([
      ...outsideRoots.map((worktreePath) => getHandler(IPC.GIT_DIFF)(undefined, { worktreePath })),
      ...outsideRoots.map((worktreePath) => getHandler(IPC.GIT_STATUS)(undefined, { worktreePath })),
      ...outsideRoots.map((worktreePath) => getHandler(IPC.GIT_FILE_DIFF)(undefined, { path: 'hosts', worktreePath })),
      ...outsideRoots.map((projectRoot) => getHandler(IPC.GIT_BRANCHES)(undefined, { projectRoot })),
    ]);

    // Assert
    for (const result of results) {
      expect(result).toMatchObject({ error: UNAUTHORIZED_ERROR });
    }
    expect(getWorktreeSnapshotMock).not.toHaveBeenCalled();
    expect(collectWorkingTreeFilePatchMock).not.toHaveBeenCalled();
    expect(gitMock).not.toHaveBeenCalled();
    expect(safeGitMock).not.toHaveBeenCalled();
  });

  it('allows the active project root and pane worktree roots', async () => {
    // Act
    await getHandler(IPC.GIT_DIFF)(undefined, { worktreePath: WORKTREE_PATH });
    await getHandler(IPC.GIT_STATUS)(undefined, { worktreePath: PROJECT_ROOT });
    await getHandler(IPC.GIT_BRANCHES)(undefined, { projectRoot: PROJECT_ROOT });

    // Assert
    expect(getWorktreeSnapshotMock).toHaveBeenNthCalledWith(1, WORKTREE_PATH, true);
    expect(getWorktreeSnapshotMock).toHaveBeenNthCalledWith(2, PROJECT_ROOT, false);
    expect(gitMock).toHaveBeenCalledWith(PROJECT_ROOT, ['branch', '--list']);
  });
});
