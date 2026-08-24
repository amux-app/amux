// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCommandPalette } from '../../src/renderer/hooks/useCommandPalette';
import {
  useCommandPaletteStore,
  useElectronSettingsStore,
  usePaneStore,
  useProjectStore,
  useUiStore,
} from '../../src/renderer/stores';
import type { ElectronSettings } from '../../src/shared/ipc-types';
import { DEFAULT_TERMINAL_FONT_FAMILY } from '../../src/shared/terminal-profile';

const updateElectronSetting = vi.hoisted(() => vi.fn());

vi.mock('../../src/renderer/api/electron-settings.api', () => ({
  getElectronSettings: vi.fn(),
  resetElectronSettings: vi.fn(),
  updateElectronSetting,
}));

vi.mock('../../src/renderer/api/agent-session.api', () => ({
  searchSessions: vi.fn(),
}));

vi.mock('../../src/renderer/api/system.api', () => ({
  searchProjectFiles: vi.fn(),
  searchProjectText: vi.fn(),
}));

const DEFAULT_SETTINGS: ElectronSettings = {
  alwaysOnTop: false,
  compactMode: false,
  copyOnSelect: false,
  cursorBlink: true,
  cursorStyle: 'block',
  debugLogging: false,
  disableExternalNetwork: false,
  enableKanbanBoard: false,
  opencodeMousePassthrough: false,
  pollingInterval: 200,
  scrollbackLines: 25000,
  showAgentHealthTracker: false,
  showArenaScores: false,
  showPerformanceMetrics: false,
  terminalBell: false,
  terminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
  terminalFontSize: 12,
  terminalOsc52Clipboard: 'off',
  terminalPreferredLaunchCols: 0,
  terminalPreferredLaunchRows: 0,
  terminalTheme: 'follow',
  terminalTransport: 'classic',
  theme: 'dark',
  uiZoom: 1,
  windowOpacity: 1,
};

describe('useCommandPalette theme command', () => {
  beforeEach(() => {
    updateElectronSetting.mockResolvedValue({ ...DEFAULT_SETTINGS, theme: 'light' });
    useCommandPaletteStore.setState({ activeTab: 'commands', isOpen: true, search: '' });
    useElectronSettingsStore.setState({ isLoading: false, settings: DEFAULT_SETTINGS });
    usePaneStore.setState({ panes: [], selectedPaneId: null });
    useProjectStore.setState({ sessionProjectRoot: '/repo' });
    useUiStore.setState({ theme: 'dark' });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('persists command palette theme changes to Electron settings', () => {
    // Arrange
    const { result } = renderHook(() => useCommandPalette());

    // Act
    act(() => result.current.executeCommand('toggle-theme'));

    // Assert
    expect(useUiStore.getState().theme).toBe('light');
    expect(updateElectronSetting).toHaveBeenCalledWith({
      key: 'theme',
      value: 'light',
    });
  });
});
