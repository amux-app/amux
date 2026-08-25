import { existsSync } from 'fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureTmuxSession } from '../src/main/utils/tmuxSession';
import { IPC } from '../src/shared/ipc-channels';
import { registerWorkspaceHandlers } from '../src/main/ipc/workspace.handlers';

const FOLDER_PATH = path.join(os.tmpdir(), 'muxbase-test', 'example-rag');
const FOLDER_CONFIG = path.join(FOLDER_PATH, '.muxbase', 'muxbase.config.json');

type RegisteredHandler = (event: unknown, request?: unknown) => unknown | Promise<unknown>;

const secureHandleMock = vi.hoisted(() => vi.fn());
const historyTouchMock = vi.hoisted(() => vi.fn());
const discoverProjectsMock = vi.hoisted(() => vi.fn(async () => []));
const ensureTmuxSessionMock = vi.hoisted(() => vi.fn());
const showOpenDialogMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: showOpenDialogMock,
  },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
}));

vi.mock('../src/main/ipc/ipc-security.js', () => ({
  secureHandle: (channel: string, handler: RegisteredHandler) => secureHandleMock(channel, handler),
}));

vi.mock('../src/main/services/Logger.js', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../src/main/services/ProjectDiscovery.js', () => ({
  discoverProjects: discoverProjectsMock,
}));

vi.mock('../src/main/services/WorkspaceHistoryService.js', () => ({
  WorkspaceHistoryService: {
    getInstance: () => ({
      getAll: () => [],
      remove: () => [],
      touch: historyTouchMock,
    }),
  },
}));

vi.mock('../src/main/utils/formatError.js', () => ({
  formatError: (error: unknown) => error instanceof Error ? error.message : String(error),
}));

vi.mock('../src/main/utils/tmuxSession.js', () => ({
  ensureTmuxSession: ensureTmuxSessionMock,
}));

function getRegisteredHandler(channel: string): RegisteredHandler {
  const call = secureHandleMock.mock.calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!call) throw new Error(`Handler was not registered for channel ${channel}`);
  return call[1] as RegisteredHandler;
}

describe('workspace create session', () => {
  beforeEach(() => {
    secureHandleMock.mockClear();
    historyTouchMock.mockClear();
    discoverProjectsMock.mockReset();
    ensureTmuxSessionMock.mockReset();
    vi.mocked(existsSync).mockReturnValue(true);
  });

  it('uses the collision-safe tmux session helper for first-time folders', async () => {
    // Arrange
    ensureTmuxSessionMock.mockResolvedValue({
      created: true,
      paneId: '%3',
      sessionName: 'muxbase-example-rag_01',
    });
    discoverProjectsMock.mockResolvedValue([]);
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [FOLDER_PATH] });
    registerWorkspaceHandlers();
    // The folder only becomes an approved project root by way of the native dialog.
    await getRegisteredHandler(IPC.WORKSPACE_OPEN_FOLDER)(null);
    const handler = getRegisteredHandler(IPC.WORKSPACE_CREATE_SESSION);

    // Act
    const response = await handler(null, {
      folderPath: FOLDER_PATH,
    });

    // Assert
    expect(ensureTmuxSession).toHaveBeenCalledWith(
      'muxbase-example-rag',
      FOLDER_PATH,
      'example-rag',
    );
    expect(response).toMatchObject({
      project: {
        configPath: FOLDER_CONFIG,
        name: 'example-rag',
        paneCount: 0,
        root: FOLDER_PATH,
        sessionName: 'muxbase-example-rag_01',
      },
      success: true,
    });
  });
});
