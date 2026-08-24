// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppThemeMode, useTerminalThemeMode } from '../../src/renderer/hooks/useAppThemeMode';
import { useElectronSettingsStore } from '../../src/renderer/stores';
import type { ElectronSettings } from '../../src/shared/ipc-types';
import type { TerminalThemePreference } from '../../src/shared/theme-mode';

vi.mock('../../src/renderer/api/electron-settings.api', () => ({
  getElectronSettings: vi.fn(),
  resetElectronSettings: vi.fn(),
  updateElectronSetting: vi.fn(),
}));

function setTerminalThemePreference(terminalTheme: TerminalThemePreference): void {
  useElectronSettingsStore.setState({
    isLoading: false,
    settings: { terminalTheme } as ElectronSettings,
  });
}

function setDocumentTheme(theme: string): void {
  act(() => {
    document.documentElement.setAttribute('data-theme', theme);
  });
}

describe('useAppThemeMode', () => {
  beforeEach(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
    setTerminalThemePreference('follow');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useElectronSettingsStore.setState({ isLoading: false, settings: null });
  });

  it('shares a single document observer across every consumer', () => {
    // Arrange
    const observe = vi.fn();
    const MutationObserverStub = vi.fn(() => ({
      disconnect: vi.fn(),
      observe,
      takeRecords: vi.fn(),
    }));
    vi.stubGlobal('MutationObserver', MutationObserverStub);

    // Act
    renderHook(() => useAppThemeMode());
    renderHook(() => useAppThemeMode());
    renderHook(() => useTerminalThemeMode());

    // Assert
    expect(MutationObserverStub).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it('tracks live data-theme changes across both light-family themes', async () => {
    // Arrange
    const { result } = renderHook(() => useAppThemeMode());
    expect(result.current).toBe('dark');

    // Act
    setDocumentTheme('light');
    await vi.waitFor(() => expect(result.current).toBe('light'));
    setDocumentTheme('colorful');
    await vi.waitFor(() => expect(result.current).toBe('light'));
    setDocumentTheme('dark-colorful');

    // Assert
    await vi.waitFor(() => expect(result.current).toBe('dark'));
  });

  it('pins the terminal to dark when the Always dark preference is set', async () => {
    // Arrange
    setTerminalThemePreference('dark');
    const { result } = renderHook(() => useTerminalThemeMode());

    // Act
    setDocumentTheme('light');

    // Assert
    await vi.waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    expect(result.current).toBe('dark');
  });

  it('follows the app theme for the terminal by default', async () => {
    // Arrange
    const { result } = renderHook(() => useTerminalThemeMode());

    // Act
    setDocumentTheme('light');

    // Assert
    await vi.waitFor(() => expect(result.current).toBe('light'));
  });
});
