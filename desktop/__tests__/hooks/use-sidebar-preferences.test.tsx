// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSidebarPreferences } from '../../src/renderer/hooks/useSidebarPreferences';
import { useElectronSettingsStore, useUiStore } from '../../src/renderer/stores';
import type { ElectronSettings } from '../../src/shared/ipc-types';
import { DEFAULT_TERMINAL_FONT_FAMILY } from '../../src/shared/terminal-profile';

const updateElectronSetting = vi.hoisted(() => vi.fn());

vi.mock('../../src/renderer/api/electron-settings.api', () => ({
  getElectronSettings: vi.fn(),
  resetElectronSettings: vi.fn(),
  updateElectronSetting,
}));

const DEFAULT_SETTINGS: ElectronSettings = {
  alwaysOnTop: false,
  compactMode: false,
  copyOnSelect: false,
  costCurrency: 'EUR-hai',
  cursorBlink: true,
  cursorStyle: 'block',
  debugLogging: false,
  disableExternalNetwork: false,
  enableConversationTopics: false,
  enableKanbanBoard: false,
  enablePaneSummary: false,
  enableReviewAgent: true,
  enableTelemetryCostTracking: true,
  opencodeMousePassthrough: false,
  pollingInterval: 200,
  scrollbackLines: 25000,
  showAgentHealthTracker: false,
  showArenaScores: false,
  showPerformanceMetrics: false,
  sidebarCollapsed: false,
  sidebarOrganize: 'project',
  sidebarSort: 'priority',
  terminalBell: false,
  terminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
  terminalFontSize: 12,
  terminalOsc52Clipboard: 'off',
  terminalPreferredLaunchCols: 0,
  terminalPreferredLaunchRows: 0,
  terminalTheme: 'follow',
  terminalTransport: 'pty',
  theme: 'dark',
  uiZoom: 1,
  windowOpacity: 1,
};

describe('useSidebarPreferences', () => {
  beforeEach(() => {
    updateElectronSetting.mockResolvedValue(DEFAULT_SETTINGS);
    useElectronSettingsStore.setState({ isLoading: false, loadError: null, settings: DEFAULT_SETTINGS });
    useUiStore.setState({ sidebarCollapsed: false, sidebarOrganize: 'project', sidebarSort: 'priority' });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('applies the organize preference and persists it for the next boot', async () => {
    // Arrange
    const { result } = renderHook(() => useSidebarPreferences());

    // Act
    await act(async () => {
      result.current.setOrganize('flat');
    });

    // Assert
    expect(useUiStore.getState().sidebarOrganize).toBe('flat');
    expect(updateElectronSetting).toHaveBeenCalledWith({ key: 'sidebarOrganize', value: 'flat' });
  });

  it('applies the sort preference and persists it for the next boot', async () => {
    // Arrange
    const { result } = renderHook(() => useSidebarPreferences());

    // Act
    await act(async () => {
      result.current.setSort('updated');
    });

    // Assert
    expect(useUiStore.getState().sidebarSort).toBe('updated');
    expect(updateElectronSetting).toHaveBeenCalledWith({ key: 'sidebarSort', value: 'updated' });
  });

  it('leaves the sibling preference untouched', async () => {
    // Arrange
    const { result } = renderHook(() => useSidebarPreferences());

    // Act
    await act(async () => {
      result.current.setSort('manual');
    });

    // Assert
    expect(useUiStore.getState().sidebarOrganize).toBe('project');
    expect(updateElectronSetting).toHaveBeenCalledTimes(1);
  });

  it('keeps the applied value when persistence fails so the menu never fights the user', async () => {
    // Arrange
    updateElectronSetting.mockRejectedValue(new Error('disk full'));
    const { result } = renderHook(() => useSidebarPreferences());

    // Act
    await act(async () => {
      result.current.setOrganize('flat');
    });

    // Assert
    expect(useUiStore.getState().sidebarOrganize).toBe('flat');
    expect(useElectronSettingsStore.getState().settings?.sidebarOrganize).toBe('project');
  });

  it('toggles the collapse preference and persists it for the next boot', async () => {
    // Arrange
    const { result } = renderHook(() => useSidebarPreferences());

    // Act
    await act(async () => {
      result.current.toggleCollapsed();
    });

    // Assert
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    expect(updateElectronSetting).toHaveBeenCalledWith({ key: 'sidebarCollapsed', value: true });
  });

  it('toggles the collapse preference back to expanded', async () => {
    // Arrange
    useUiStore.setState({ sidebarCollapsed: true });
    const { result } = renderHook(() => useSidebarPreferences());

    // Act
    await act(async () => {
      result.current.toggleCollapsed();
    });

    // Assert
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    expect(updateElectronSetting).toHaveBeenCalledWith({ key: 'sidebarCollapsed', value: false });
  });

  it('returns stable setters across renders', () => {
    // Arrange
    const { result, rerender } = renderHook(() => useSidebarPreferences());
    const first = result.current;

    // Act
    rerender();

    // Assert
    expect(result.current.setOrganize).toBe(first.setOrganize);
    expect(result.current.setSort).toBe(first.setSort);
    expect(result.current.toggleCollapsed).toBe(first.toggleCollapsed);
  });
});
