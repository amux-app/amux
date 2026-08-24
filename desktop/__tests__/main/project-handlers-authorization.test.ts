import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerProjectHandlers } from '../../src/main/ipc/project.handlers';
import { registerWorkspaceHandlers } from '../../src/main/ipc/workspace.handlers';
import { IPC } from '../../src/shared/ipc-channels';

const DISCOVERED_ROOT = '/workspace/discovered-app';
const DIALOG_ROOT = '/workspace/picked-app';
const HISTORY_ROOT = '/workspace/recent-app';
const ACTIVE_ROOT = '/workspace/active-app';
const UNAUTHORIZED_ERROR = 'Unauthorized project root';

const discoverProjectsMock = vi.hoisted(() => vi.fn());
const historyGetAllMock = vi.hoisted(() => vi.fn());
const historyTouchMock = vi.hoisted(() => vi.fn(() => []));
const resetTerminalManagerMock = vi.hoisted(() => vi.fn());
const secureHandleMock = vi.hoisted(() => vi.fn());
const showOpenDialogMock = vi.hoisted(() => vi.fn());
const switchProjectMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  dialog: { showOpenDialog: showOpenDialogMock },
}));

vi.mock('../../src/main/ipc/ipc-security.js', () => ({
  secureHandle: (channel: string, handler: unknown) => secureHandleMock(channel, handler),
}));

vi.mock('../../src/main/services/Logger.js', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../src/main/services/ProjectDiscovery.js', () => ({
  discoverProjects: discoverProjectsMock,
}));

vi.mock('../../src/main/services/ProjectSearchService.js', () => ({
  projectSearchService: { searchFiles: vi.fn(), searchText: vi.fn() },
  resolveProjectSearchRoot: vi.fn(),
}));

vi.mock('../../src/main/services/TerminalStreamService.js', () => ({
  resetTerminalManager: resetTerminalManagerMock,
}));

vi.mock('../../src/main/services/WorkspaceHistoryService.js', () => ({
  WorkspaceHistoryService: {
    getInstance: () => ({
      getAll: historyGetAllMock,
      remove: vi.fn(() => []),
      touch: historyTouchMock,
    }),
  },
}));

vi.mock('../../src/main/utils/tmuxSession.js', () => ({
  ensureTmuxSession: vi.fn(),
}));

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const registration = secureHandleMock.mock.calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!registration) throw new Error(`missing handler registration for ${channel}`);
  return registration[1] as (...args: unknown[]) => unknown;
}

function switchTo(projectRoot: string): unknown {
  return getHandler(IPC.PROJECT_SWITCH)(undefined, { projectRoot });
}

describe('project switch authorization', () => {
  beforeEach(() => {
    secureHandleMock.mockClear();
    resetTerminalManagerMock.mockClear();
    switchProjectMock.mockClear().mockResolvedValue(undefined);
    historyTouchMock.mockClear();
    historyGetAllMock.mockReset().mockReturnValue([{ name: 'recent-app', root: HISTORY_ROOT }]);
    discoverProjectsMock.mockReset().mockResolvedValue([{ name: 'discovered-app', root: DISCOVERED_ROOT }]);

    registerProjectHandlers({
      getConfigPath: () => `${ACTIVE_ROOT}/.aumx/aumx.config.json`,
      getPanes: () => [],
      getProjectName: () => 'active-app',
      getProjectRoot: () => ACTIVE_ROOT,
      getSessionName: () => 'aumx-active-app',
      switchProject: switchProjectMock,
    } as never);
    registerWorkspaceHandlers();
  });

  it('switches to a discovered project root', async () => {
    // Act
    const result = await switchTo(DISCOVERED_ROOT);

    // Assert
    expect(result).toMatchObject({ success: true });
    expect(switchProjectMock).toHaveBeenCalledWith(DISCOVERED_ROOT, { fresh: false });
    expect(resetTerminalManagerMock).not.toHaveBeenCalled();
  });

  it('switches to a root the user picked in the main-process folder dialog', async () => {
    // Arrange — the dialog is the only way this root becomes known
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [DIALOG_ROOT] });
    await getHandler(IPC.WORKSPACE_OPEN_FOLDER)(undefined);

    // Act
    const result = await switchTo(DIALOG_ROOT);

    // Assert
    expect(result).toMatchObject({ success: true });
    expect(switchProjectMock).toHaveBeenCalledWith(DIALOG_ROOT, { fresh: false });
  });

  it('switches to a persisted workspace history root', async () => {
    // Act
    const result = await switchTo(HISTORY_ROOT);

    // Assert
    expect(result).toMatchObject({ success: true });
  });

  it('rejects a root the renderer invented', async () => {
    // Act
    const result = await switchTo('/tmp/arbitrary');

    // Assert
    expect(result).toEqual({ error: UNAUTHORIZED_ERROR });
    expect(switchProjectMock).not.toHaveBeenCalled();
    expect(resetTerminalManagerMock).not.toHaveBeenCalled();
  });

  it('skips a history write for a root that was never approved', async () => {
    // Act
    const result = await getHandler(IPC.WORKSPACE_HISTORY_TOUCH)(undefined, {
      name: 'passwd',
      paneCount: 0,
      root: '/etc',
    });

    // Assert — history cannot be poisoned into becoming a trusted switch source
    expect(result).toEqual([{ name: 'recent-app', root: HISTORY_ROOT }]);
    expect(historyTouchMock).not.toHaveBeenCalled();
    expect(await switchTo('/etc')).toEqual({ error: UNAUTHORIZED_ERROR });
  });

  it('rejects creating a session for a folder that was never approved', async () => {
    // Act
    const result = await getHandler(IPC.WORKSPACE_CREATE_SESSION)(undefined, { folderPath: '/etc' });

    // Assert
    expect(result).toEqual({ success: false, error: UNAUTHORIZED_ERROR });
    expect(historyTouchMock).not.toHaveBeenCalled();
  });
});
