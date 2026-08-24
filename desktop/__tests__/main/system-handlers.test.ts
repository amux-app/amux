import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';
import { registerSystemHandlers } from '../../src/main/ipc/system.handlers';

const secureHandleMock = vi.hoisted(() => vi.fn());
const createSupportBundleMock = vi.hoisted(() => vi.fn());
const previewSupportBundleMock = vi.hoisted(() => vi.fn());
const showItemInFolderMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
const execAsyncMock = vi.hoisted(() => vi.fn());
const validateSystemRequirementsMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/main/ipc/ipc-security.js', () => ({
  secureHandle: (channel: string, handler: unknown) => secureHandleMock(channel, handler),
}));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

vi.mock('node:fs', () => ({
  existsSync: () => true,
  realpathSync: Object.assign(() => { throw new Error('not used'); }, { native: (path: string) => path }),
}));

vi.mock('node:os', () => ({ homedir: () => '/home/test-user' }));

vi.mock('../../src/main/services/editorDetection.js', () => ({
  detectAvailableEditors: () => [],
  resolveEditorById: () => ({ command: 'code' }),
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/tmp/aumx-app',
    getPath: () => '/tmp/Desktop',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  },
  clipboard: {
    readText: vi.fn(() => ''),
    writeText: vi.fn(),
  },
  shell: {
    openExternal: vi.fn(),
    showItemInFolder: showItemInFolderMock,
  },
}));

vi.mock('aumx/core', () => ({
  execAsync: execAsyncMock,
  parseTmuxVersion: (raw: string) => {
    const match = raw.trim().match(/^(?:tmux\s+)?(\d+)\.(\d+)([a-z])?$/);
    return match ? { raw: raw.trim() } : null;
  },
  validateSystemRequirements: validateSystemRequirementsMock,
}));

vi.mock('../../src/main/services/AppBuildInfo.js', () => ({
  readAppBuildInfo: () => ({ buildVersion: '0.0.0-test' }),
}));

vi.mock('../../src/main/services/SupportBundleService.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/main/services/SupportBundleService.js')>(),
  createSupportBundle: createSupportBundleMock,
  previewSupportBundle: previewSupportBundleMock,
}));

vi.mock('../../src/main/services/Logger.js', () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    getLogDir: () => '/tmp/aumx-logs',
    getLogFile: () => '/tmp/aumx-logs/aumx-desktop-test.log',
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const PROJECT_ROOT = '/tmp/project';
const WORKTREE_PATH = '/tmp/project-worktrees/task-a';

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const registration = secureHandleMock.mock.calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!registration) throw new Error(`missing handler registration for ${channel}`);
  return registration[1] as (...args: unknown[]) => unknown;
}

function bridgeWithWorktree(): Parameters<typeof registerSystemHandlers>[0] {
  return {
    getPanes: () => [{ projectRoot: PROJECT_ROOT, worktreePath: WORKTREE_PATH }],
    getProjectName: () => 'aumx',
    getProjectRoot: () => PROJECT_ROOT,
    getSessionName: () => 'aumx-aumx',
    updateAvailableAgentsCache: vi.fn(),
  } as never;
}

describe('system IPC handlers', () => {
  beforeEach(() => {
    secureHandleMock.mockClear();
    execAsyncMock.mockReset()
      .mockResolvedValueOnce('tmux 3.5a')
      .mockResolvedValueOnce('git version 2.50.1');
    showItemInFolderMock.mockClear();
    spawnMock.mockReset().mockImplementation(() => ({
      once: (event: string, callback: () => void) => { if (event === 'spawn') callback(); },
      unref: vi.fn(),
    }));
    validateSystemRequirementsMock.mockReset().mockResolvedValue({
      agents: ['claude', 'codex'],
      canRun: true,
      errors: [],
    });
    createSupportBundleMock.mockResolvedValue({
      includedFiles: ['/tmp/aumx-logs/aumx-desktop-test.log'],
      path: '/tmp/Desktop/aumx-support-test.zip',
    });
    previewSupportBundleMock.mockReturnValue({
      files: [{ category: 'metadata', name: 'metadata/session.json', sizeBytes: 10 }],
      includeTranscripts: false,
      redactionNote: 'note',
      totalBytes: 10,
    });
  });

  it('includes debug log paths in session info', () => {
    // Arrange
    registerSystemHandlers({
      getProjectName: () => 'aumx',
      getProjectRoot: () => '/tmp/project',
      getSessionName: () => 'aumx-aumx',
    } as never);

    // Act
    const result = getHandler(IPC.SESSION_INFO)();

    // Assert
    expect(result).toEqual(expect.objectContaining({
      logDir: '/tmp/aumx-logs',
      logFile: '/tmp/aumx-logs/aumx-desktop-test.log',
      projectName: 'aumx',
      projectRoot: '/tmp/project',
      sessionName: 'aumx-aumx',
      homeDir: '/home/test-user',
    }));
  });

  it('reuses agents returned by system validation', async () => {
    // Arrange
    const bridge = bridgeWithWorktree();
    registerSystemHandlers(bridge);

    // Act
    const result = await getHandler(IPC.SYSTEM_CHECK)();

    // Assert
    expect(result).toEqual({
      agents: ['claude', 'codex'],
      git: { available: true, version: '2.50.1' },
      tmux: { available: true, version: '3.5a' },
    });
    expect(validateSystemRequirementsMock).toHaveBeenCalledOnce();
    expect(bridge.updateAvailableAgentsCache).toHaveBeenCalledWith(['claude', 'codex']);
  });

  it('exports a support bundle with session context', async () => {
    // Arrange
    registerSystemHandlers({
      getPanes: () => [{ id: 'pane-1', paneId: '%1', prompt: 'prompt', slug: 'pane-1' }],
      getProjectName: () => 'aumx',
      getProjectRoot: () => '/tmp/project',
      getSessionName: () => 'aumx-aumx',
    } as never);

    // Act
    const result = await getHandler(IPC.SYSTEM_EXPORT_SUPPORT_BUNDLE)({}, { includeTranscripts: true });

    // Assert
    expect(result).toEqual({
      includedFiles: ['/tmp/aumx-logs/aumx-desktop-test.log'],
      path: '/tmp/Desktop/aumx-support-test.zip',
    });
    expect(createSupportBundleMock).toHaveBeenCalledWith(expect.objectContaining({
      includeTranscripts: true,
      logDir: '/tmp/aumx-logs',
      logFile: '/tmp/aumx-logs/aumx-desktop-test.log',
      outputDir: '/tmp/Desktop',
      panes: [{ id: 'pane-1', paneId: '%1', prompt: 'prompt', slug: 'pane-1' }],
      projectName: 'aumx',
      projectRoot: '/tmp/project',
      sessionName: 'aumx-aumx',
    }));
  });

  it('rejects an editor file argument that escapes the authorized root', async () => {
    // Arrange
    registerSystemHandlers(bridgeWithWorktree());

    // Act
    const result = await getHandler(IPC.SYSTEM_OPEN_IN_EDITOR)({}, {
      path: PROJECT_ROOT,
      file: '../../etc/passwd',
    });

    // Assert
    expect(result).toEqual({ error: 'Path traversal blocked' });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects an editor root outside the project and its pane worktrees', async () => {
    // Arrange
    registerSystemHandlers(bridgeWithWorktree());

    // Act
    const result = await getHandler(IPC.SYSTEM_OPEN_IN_EDITOR)({}, { path: '/etc' });

    // Assert
    expect(result).toEqual({ error: 'Unauthorized file root' });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('opens a file that resolves inside a pane worktree', async () => {
    // Arrange
    registerSystemHandlers(bridgeWithWorktree());

    // Act
    const result = await getHandler(IPC.SYSTEM_OPEN_IN_EDITOR)({}, {
      path: WORKTREE_PATH,
      file: 'src/index.ts',
      line: 12,
    });

    // Assert
    expect(result).toEqual({ success: true });
    expect(spawnMock).toHaveBeenCalledWith(
      'code',
      ['--goto', `${WORKTREE_PATH}/src/index.ts:12`],
      expect.objectContaining({ shell: false }),
    );
  });

  it('reveals paths inside the log directory, an exported support bundle and pane worktrees', async () => {
    // Arrange
    registerSystemHandlers(bridgeWithWorktree());
    const revealable = [
      '/tmp/aumx-logs/aumx-desktop-test.log',
      '/tmp/aumx-logs',
      '/tmp/Desktop/aumx-support-2026-07-29-101530.zip',
      WORKTREE_PATH,
    ];

    // Act
    const results = await Promise.all(
      revealable.map((path) => getHandler(IPC.SYSTEM_REVEAL_PATH)({}, { path })),
    );

    // Assert
    expect(results).toEqual(revealable.map(() => ({ success: true })));
    expect(showItemInFolderMock).toHaveBeenCalledTimes(revealable.length);
  });

  it('rejects revealing desktop files that are not exported support bundles', async () => {
    // Arrange
    registerSystemHandlers(bridgeWithWorktree());
    const rejected = [
      '/tmp/Desktop',
      '/tmp/Desktop/tax-return.pdf',
      '/tmp/Desktop/aumx-support-test.zip',
      '/tmp/Desktop/nested/aumx-support-2026-07-29-101530.zip',
    ];

    // Act
    const results = await Promise.all(
      rejected.map((path) => getHandler(IPC.SYSTEM_REVEAL_PATH)({}, { path })),
    );

    // Assert
    expect(results).toEqual(rejected.map(() => ({ error: 'Unauthorized path' })));
    expect(showItemInFolderMock).not.toHaveBeenCalled();
  });

  it('rejects revealing a path outside every authorized location', async () => {
    // Arrange
    registerSystemHandlers(bridgeWithWorktree());

    // Act
    const result = await getHandler(IPC.SYSTEM_REVEAL_PATH)({}, { path: '/etc/passwd' });

    // Assert
    expect(result).toEqual({ error: 'Unauthorized path' });
    expect(showItemInFolderMock).not.toHaveBeenCalled();
  });

  it('previews a support bundle without writing a file', async () => {
    // Arrange
    registerSystemHandlers({
      getPanes: () => [{ id: 'pane-1', paneId: '%1', prompt: 'prompt', slug: 'pane-1' }],
      getProjectName: () => 'aumx',
      getProjectRoot: () => '/tmp/project',
      getSessionName: () => 'aumx-aumx',
    } as never);

    // Act
    const result = await getHandler(IPC.SYSTEM_PREVIEW_SUPPORT_BUNDLE)({}, { includeTranscripts: false });

    // Assert
    expect(result).toEqual(expect.objectContaining({ includeTranscripts: false, totalBytes: 10 }));
    expect(previewSupportBundleMock).toHaveBeenCalledWith(expect.objectContaining({
      includeTranscripts: false,
      projectRoot: '/tmp/project',
    }));
  });
});
