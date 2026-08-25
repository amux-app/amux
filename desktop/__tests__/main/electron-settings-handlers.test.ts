import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';
import { registerElectronSettingsHandlers } from '../../src/main/ipc/electron-settings.handlers';
import type { MuxBaseBridge } from '../../src/main/services/MuxBaseBridge';
import type { ThemeMode } from '../../src/shared/theme-mode';

const execAsyncMock = vi.hoisted(() => vi.fn(() => Promise.resolve('')));
const secureHandleMock = vi.hoisted(() => vi.fn());
const terminalTheme = vi.hoisted(() => ({ mode: 'dark' as ThemeMode }));
const updateMock = vi.hoisted(() => vi.fn());
const setLevelMock = vi.hoisted(() => vi.fn());

vi.mock('muxbase/core', () => ({
  AGENT_TERMINAL_ENVIRONMENT: [],
  AGENT_TERMINAL_ENV_UNSETS: [],
  execAsync: execAsyncMock,
  shQuote: (value: string) => `'${value}'`,
}));

vi.mock('../../src/main/ipc/ipc-security.js', () => ({
  secureHandle: (channel: string, handler: unknown) => secureHandleMock(channel, handler),
}));

vi.mock('../../src/main/services/app-theme.js', () => ({
  getTerminalThemeMode: () => terminalTheme.mode,
  syncWindowBackgroundColors: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
    getFocusedWindow: () => null,
  },
}));

vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: false },
}));

vi.mock('../../src/main/services/ElectronSettingsService.js', () => ({
  ElectronSettingsService: {
    getInstance: () => ({
      getAll: vi.fn(() => ({ debugLogging: false })),
      reset: vi.fn(() => ({ debugLogging: false, enableAgentLifecycleAdapters: false })),
      update: updateMock,
    }),
  },
}));

vi.mock('../../src/main/services/PerformanceMonitorService.js', () => ({
  PerformanceMonitorService: {
    getInstance: () => ({
      start: vi.fn(),
      stop: vi.fn(),
    }),
  },
}));

vi.mock('../../src/main/services/Logger.js', () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    setLevel: setLevelMock,
    warn: vi.fn(),
  },
}));

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const registration = secureHandleMock.mock.calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!registration) throw new Error(`missing handler registration for ${channel}`);
  return registration[1] as (...args: unknown[]) => unknown;
}

const bridge = {
  getSessionName: () => 'muxbase-example-rag',
  setAgentLifecycleAdaptersEnabled: vi.fn(),
  setTelemetryCostTrackingEnabled: vi.fn(),
} as unknown as MuxBaseBridge;

describe('electron settings IPC handlers', () => {
  beforeEach(() => {
    execAsyncMock.mockClear();
    secureHandleMock.mockClear();
    setLevelMock.mockClear();
    vi.mocked(bridge.setAgentLifecycleAdaptersEnabled).mockClear();
    terminalTheme.mode = 'dark';
    updateMock.mockReset();
    updateMock.mockReturnValue({ debugLogging: true });
  });

  it('applies debug logging changes immediately', () => {
    // Arrange
    registerElectronSettingsHandlers(bridge);

    // Act
    const result = getHandler(IPC.ELECTRON_SETTINGS_UPDATE)(undefined, {
      key: 'debugLogging',
      value: true,
    });

    // Assert
    expect(result).toEqual({ debugLogging: true });
    expect(updateMock).toHaveBeenCalledWith('debugLogging', true);
    expect(setLevelMock).toHaveBeenCalledWith('debug');
  });

  it('keeps debug records off in packaged builds when the setting is disabled', () => {
    // Arrange
    registerElectronSettingsHandlers(bridge);

    // Act
    getHandler(IPC.ELECTRON_SETTINGS_RESET)();

    // Assert
    expect(setLevelMock).toHaveBeenCalledWith('info');
  });

  it('revokes installed lifecycle adapters when settings reset to defaults', () => {
    registerElectronSettingsHandlers(bridge);

    getHandler(IPC.ELECTRON_SETTINGS_RESET)();

    expect(bridge.setAgentLifecycleAdaptersEnabled).toHaveBeenCalledWith(false);
  });

  it.each([
    ['theme' as const, 'light' as const, '0;15'],
    ['terminalTheme' as const, 'dark' as const, '15;0'],
  ])('republishes COLORFGBG to the live session when %s changes', (key, mode, expected) => {
    // Arrange
    terminalTheme.mode = mode;
    registerElectronSettingsHandlers(bridge);

    // Act
    getHandler(IPC.ELECTRON_SETTINGS_UPDATE)(undefined, { key, value: mode });

    // Assert
    expect(execAsyncMock, 'new panes inherit a stale COLORFGBG until the session env is refreshed')
      .toHaveBeenCalledWith(
        `tmux set-environment -t 'muxbase-example-rag' COLORFGBG '${expected}'`,
        { silent: true },
      );
  });
});
