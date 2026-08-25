import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC, IPC_SYNC } from '../../src/shared/ipc-channels';
import { registerAppHandlers } from '../../src/main/ipc/app.handlers';

const appMock = vi.hoisted(() => ({
  quit: vi.fn(),
  relaunch: vi.fn(),
}));
const getAllMock = vi.hoisted(() => vi.fn());
const ipcMainMock = vi.hoisted(() => ({ on: vi.fn() }));
const logErrorMock = vi.hoisted(() => vi.fn());
const secureHandleMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({ app: appMock, ipcMain: ipcMainMock }));
vi.mock('../../src/main/ipc/ipc-security.js', () => ({
  secureHandle: (
    channel: string,
    handler: (...args: unknown[]) => unknown,
    options?: unknown,
  ) => secureHandleMock(channel, handler, options),
}));
vi.mock('../../src/main/services/ElectronSettingsService.js', () => ({
  ElectronSettingsService: {
    getDefaults: () => ({
      sidebarCollapsed: false,
      sidebarOrganize: 'project',
      sidebarSort: 'manual',
      terminalTheme: 'follow',
      theme: 'dark',
    }),
    getInstance: () => ({ getAll: getAllMock }),
  },
}));
vi.mock('../../src/main/services/Logger.js', () => ({
  log: { debug: vi.fn(), error: logErrorMock, info: vi.fn(), warn: vi.fn() },
}));

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const registration = secureHandleMock.mock.calls.find(([registered]) => registered === channel);
  if (!registration) throw new Error(`missing handler registration for ${channel}`);
  return registration[1] as (...args: unknown[]) => unknown;
}

function getSyncListener(channel: string): (event: { returnValue?: unknown }) => void {
  const registration = ipcMainMock.on.mock.calls.find(([registered]) => registered === channel);
  if (!registration) throw new Error(`missing sync listener registration for ${channel}`);
  return registration[1] as (event: { returnValue?: unknown }) => void;
}

describe('app IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAllMock.mockImplementation(() => ({
      sidebarCollapsed: true,
      sidebarOrganize: 'flat',
      sidebarSort: 'updated',
      terminalSelectionIntegrationEnabled: true,
      terminalTheme: 'dark',
      theme: 'light',
      uiZoom: 1,
    }));
    registerAppHandlers(
      { getState: () => ({ phase: 'starting', revision: 0 }) } as never,
      vi.fn(),
    );
  });

  afterEach(() => {
    delete process.env.MUXBASE_DISABLE_TERMINAL_SELECTION_INTEGRATION;
  });

  it('relaunches the current application for startup retry', () => {
    expect(getHandler(IPC.APP_RELAUNCH)()).toBe(true);
    expect(appMock.relaunch).toHaveBeenCalledOnce();
    expect(appMock.quit).toHaveBeenCalledOnce();
  });

  it('quits from a terminal startup screen', () => {
    expect(getHandler(IPC.APP_QUIT)()).toBe(true);
    expect(appMock.relaunch).not.toHaveBeenCalled();
    expect(appMock.quit).toHaveBeenCalledOnce();
  });

  it('answers the preload boot read with the persisted appearance settings', () => {
    // Arrange
    const event: { returnValue?: unknown } = {};

    // Act
    getSyncListener(IPC_SYNC.APP_BOOT_SETTINGS)(event);

    // Assert
    expect(event.returnValue).toEqual({
      sidebarCollapsed: true,
      sidebarOrganize: 'flat',
      sidebarSort: 'updated',
      sidebarWidth: undefined,
      terminalSelectionIntegrationEnabled: true,
      terminalTheme: 'dark',
      theme: 'light',
    });
  });

  it('exposes the internal terminal selection recovery switch at boot', () => {
    process.env.MUXBASE_DISABLE_TERMINAL_SELECTION_INTEGRATION = '1';
    const event: { returnValue?: { terminalSelectionIntegrationEnabled?: boolean } } = {};

    getSyncListener(IPC_SYNC.APP_BOOT_SETTINGS)(event);

    expect(event.returnValue?.terminalSelectionIntegrationEnabled).toBe(false);
  });

  it('answers the blocking boot read with defaults when the settings file is unreadable', () => {
    // Arrange
    getAllMock.mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });
    const event: { returnValue?: unknown } = {};

    // Act
    getSyncListener(IPC_SYNC.APP_BOOT_SETTINGS)(event);

    // Assert
    expect(event.returnValue, 'unassigned returnValue leaves the preload sendSync hung forever')
      .toEqual({
        sidebarCollapsed: false,
        sidebarOrganize: 'project',
        sidebarSort: 'manual',
        terminalSelectionIntegrationEnabled: true,
        terminalTheme: 'follow',
        theme: 'dark',
      });
    expect(logErrorMock).toHaveBeenCalledOnce();
  });
});
