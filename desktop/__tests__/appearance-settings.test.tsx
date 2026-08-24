// @vitest-environment happy-dom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppearanceSettings } from '../src/renderer/components/settings/AppearanceSettings';
import { useElectronSettingsStore } from '../src/renderer/stores';
import type { ElectronSettings } from '../src/shared/ipc-types';
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  INTEL_ONE_MONO_TERMINAL_FONT_FAMILY,
  JETBRAINS_TERMINAL_FONT_FAMILY,
  LEGACY_MONACO_TERMINAL_FONT_FAMILY,
} from '../src/shared/terminal-profile';

const updateElectronSetting = vi.hoisted(() => vi.fn());

vi.mock('../src/renderer/api/electron-settings.api', () => ({
  getElectronSettings: vi.fn(),
  resetElectronSettings: vi.fn(),
  updateElectronSetting,
}));

const DEFAULT_SETTINGS: ElectronSettings = {
  alwaysOnTop: false,
  compactMode: false,
  copyOnSelect: false,
  cursorBlink: true,
  cursorStyle: 'block',
  debugLogging: false,
  enableKanbanBoard: false,
  opencodeMousePassthrough: false,
  pollingInterval: 200,
  scrollbackLines: 25000,
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

describe('AppearanceSettings', () => {
  beforeEach(() => {
    useElectronSettingsStore.setState({ isLoading: false, settings: DEFAULT_SETTINGS });
    updateElectronSetting.mockResolvedValue(DEFAULT_SETTINGS);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('offers recommended, legacy, and custom terminal font family choices', () => {
    // Act
    render(<AppearanceSettings />);

    // Assert
    expect(screen.getByRole('combobox', { name: 'Font Family' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Google Sans Code (Recommended)' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Intel One Mono' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'JetBrains Mono' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Monaco (Legacy)' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'SF Mono (Legacy)' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Custom...' })).toBeTruthy();
  });

  it('updates the terminal font family when a preset is selected', () => {
    // Arrange
    render(<AppearanceSettings />);

    // Act
    fireEvent.change(screen.getByRole('combobox', { name: 'Font Family' }), {
      target: { value: LEGACY_MONACO_TERMINAL_FONT_FAMILY },
    });

    // Assert
    expect(updateElectronSetting).toHaveBeenCalledWith({
      key: 'terminalFontFamily',
      value: LEGACY_MONACO_TERMINAL_FONT_FAMILY,
    });
  });

  it('keeps JetBrains Mono available as a preset', () => {
    // Arrange
    render(<AppearanceSettings />);

    // Act
    fireEvent.change(screen.getByRole('combobox', { name: 'Font Family' }), {
      target: { value: JETBRAINS_TERMINAL_FONT_FAMILY },
    });

    // Assert
    expect(updateElectronSetting).toHaveBeenCalledWith({
      key: 'terminalFontFamily',
      value: JETBRAINS_TERMINAL_FONT_FAMILY,
    });
  });

  it('keeps Intel One Mono available as the legibility-first xterm preset', () => {
    // Arrange
    render(<AppearanceSettings />);

    // Act
    fireEvent.change(screen.getByRole('combobox', { name: 'Font Family' }), {
      target: { value: INTEL_ONE_MONO_TERMINAL_FONT_FAMILY },
    });

    // Assert
    expect(updateElectronSetting).toHaveBeenCalledWith({
      key: 'terminalFontFamily',
      value: INTEL_ONE_MONO_TERMINAL_FONT_FAMILY,
    });
  });

  it('offers Always dark as the escape hatch for terminals on a light app theme', () => {
    // Arrange
    render(<AppearanceSettings />);
    const terminalTheme = screen.getByRole('combobox', { name: 'Terminal Theme' });

    // Act
    fireEvent.change(terminalTheme, { target: { value: 'dark' } });

    // Assert
    expect(screen.getByRole('option', { name: 'Follow app theme' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Always dark' })).toBeTruthy();
    expect(updateElectronSetting).toHaveBeenCalledWith({ key: 'terminalTheme', value: 'dark' });
  });

  it('commits UI zoom once after a slider interaction instead of on every drag event', () => {
    render(<AppearanceSettings />);
    const zoom = screen.getByRole('slider', { name: 'Zoom Level' });

    fireEvent.change(zoom, { target: { value: '1.1' } });
    fireEvent.change(zoom, { target: { value: '1.2' } });

    expect(updateElectronSetting).not.toHaveBeenCalled();

    fireEvent.pointerUp(zoom, { target: { value: '1.2' } });

    expect(updateElectronSetting).toHaveBeenCalledTimes(1);
    expect(updateElectronSetting).toHaveBeenCalledWith({ key: 'uiZoom', value: 1.2 });
  });

  it('shows a custom font input for unlisted font families', () => {
    // Arrange
    useElectronSettingsStore.setState({
      isLoading: false,
      settings: {
        ...DEFAULT_SETTINGS,
        terminalFontFamily: "'CommitMono', ui-monospace, monospace",
      },
    });

    // Act
    render(<AppearanceSettings />);

    // Assert
    expect((screen.getByRole('combobox', { name: 'Font Family' }) as HTMLSelectElement).value)
      .toBe('__custom__');
    expect((screen.getByLabelText('Custom font family') as HTMLInputElement).value)
      .toBe("'CommitMono', ui-monospace, monospace");
  });
});
