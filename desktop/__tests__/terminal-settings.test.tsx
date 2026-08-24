// @vitest-environment happy-dom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalSettings } from '../src/renderer/components/settings/TerminalSettings';
import { useElectronSettingsStore } from '../src/renderer/stores';
import type { ElectronSettings } from '../src/shared/ipc-types';
import { DEFAULT_TERMINAL_FONT_FAMILY } from '../src/shared/terminal-profile';

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
  pollingInterval: 200,
  scrollbackLines: 25000,
  showAgentHealthTracker: false,
  showArenaScores: false,
  showPerformanceMetrics: false,
  terminalBell: false,
  terminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
  terminalFontSize: 12,
  opencodeMousePassthrough: false,
  terminalOsc52Clipboard: 'off',
  terminalPreferredLaunchCols: 0,
  terminalPreferredLaunchRows: 0,
  terminalTheme: 'follow',
  terminalTransport: 'classic',
  theme: 'dark',
  uiZoom: 1,
  windowOpacity: 1,
};

describe('TerminalSettings', () => {
  beforeEach(() => {
    useElectronSettingsStore.setState({ isLoading: false, settings: DEFAULT_SETTINGS });
    updateElectronSetting.mockResolvedValue({ ...DEFAULT_SETTINGS, terminalTransport: 'pty' });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('offers native pty as a live transport option', () => {
    render(<TerminalSettings />);

    const transport = screen.getByRole('combobox', { name: 'Live Transport' });
    expect(screen.getByRole('option', { name: 'PTY' })).toBeTruthy();
    expect(screen.queryByText('Experimental')).toBeNull();

    fireEvent.change(transport, { target: { value: 'pty' } });

    expect(updateElectronSetting).toHaveBeenCalledWith({
      key: 'terminalTransport',
      value: 'pty',
    });
  });

  it('exposes gated terminal protocol controls', () => {
    render(<TerminalSettings />);

    fireEvent.change(screen.getByRole('combobox', { name: 'OSC 52 Clipboard' }), {
      target: { value: 'allow' },
    });
    fireEvent.click(screen.getByRole('switch', { name: 'OpenCode Mouse Passthrough' }));

    expect(updateElectronSetting).toHaveBeenCalledWith({
      key: 'terminalOsc52Clipboard',
      value: 'allow',
    });
    expect(updateElectronSetting).toHaveBeenCalledWith({
      key: 'opencodeMousePassthrough',
      value: true,
    });
  });
});
