// @vitest-environment happy-dom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdvancedSettings } from '../src/renderer/components/settings/AdvancedSettings';
import { useElectronSettingsStore } from '../src/renderer/stores';
import { useUiStore } from '../src/renderer/stores/ui.store';
import type { ElectronSettings } from '../src/shared/ipc-types';
import { DEFAULT_TERMINAL_FONT_FAMILY } from '../src/shared/terminal-profile';

const clipboardWriteMock = vi.hoisted(() => vi.fn());
const exportSupportBundleMock = vi.hoisted(() => vi.fn());
const getSessionInfoMock = vi.hoisted(() => vi.fn());
const previewSupportBundleMock = vi.hoisted(() => vi.fn());
const revealPathMock = vi.hoisted(() => vi.fn());
const resetElectronSettingsMock = vi.hoisted(() => vi.fn());
const updateElectronSettingMock = vi.hoisted(() => vi.fn());

vi.mock('../src/renderer/api/project.api', () => ({
  getSessionInfo: getSessionInfoMock,
}));

vi.mock('../src/renderer/api/system.api', () => ({
  clipboardWrite: clipboardWriteMock,
  exportSupportBundle: exportSupportBundleMock,
  previewSupportBundle: previewSupportBundleMock,
  revealPath: revealPathMock,
}));

vi.mock('../src/renderer/api/electron-settings.api', () => ({
  getElectronSettings: vi.fn(),
  resetElectronSettings: resetElectronSettingsMock,
  updateElectronSetting: updateElectronSettingMock,
}));

const DEFAULT_SETTINGS: ElectronSettings = {
  alwaysOnTop: false,
  compactMode: false,
  copyOnSelect: false,
  costCurrency: 'EUR-hai',
  cursorBlink: true,
  cursorStyle: 'block',
  debugLogging: true,
  disableExternalNetwork: false,
  enableConversationTopics: false,
  enableAgentLifecycleAdapters: false,
  enableKanbanBoard: false,
  enablePaneSummary: false,
  enableReviewAgent: true,
  enableTelemetryCostTracking: true,
  opencodeMousePassthrough: false,
  pollingInterval: 200,
  scrollbackLines: 25000,
  sidebarCollapsed: false,
  sidebarOrganize: 'project',
  sidebarSort: 'manual',
  sidebarWidth: 260,
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

describe('AdvancedSettings', () => {
  beforeEach(() => {
    useElectronSettingsStore.setState({ isLoading: false, settings: DEFAULT_SETTINGS });
    getSessionInfoMock.mockResolvedValue({
      logDir: '/tmp/aumx-logs',
      logFile: '/tmp/aumx-logs/aumx-desktop-test.log',
      projectName: 'aumx',
      projectRoot: '/tmp/project',
      sessionName: 'aumx-aumx',
    });
    clipboardWriteMock.mockResolvedValue(undefined);
    exportSupportBundleMock.mockResolvedValue({
      includedFiles: ['/tmp/aumx-logs/aumx-desktop-test.log'],
      path: '/tmp/aumx-support-test.zip',
    });
    previewSupportBundleMock.mockResolvedValue({
      files: [{ category: 'metadata', name: 'metadata/session.json', sizeBytes: 100 }],
      includeTranscripts: false,
      redactionNote: 'Paths and detected credentials are redacted on a best-effort basis.',
      totalBytes: 100,
    });
    revealPathMock.mockResolvedValue(undefined);
    resetElectronSettingsMock.mockResolvedValue(DEFAULT_SETTINGS);
    updateElectronSettingMock.mockResolvedValue(DEFAULT_SETTINGS);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the debug log file path and exposes copy/reveal actions', async () => {
    // Arrange
    render(<AdvancedSettings />);

    // Assert
    await screen.findByText('/tmp/aumx-logs/aumx-desktop-test.log');

    // Act
    fireEvent.click(screen.getByTitle('Copy log file path'));
    fireEvent.click(screen.getByTitle('Reveal log file'));

    // Assert
    await waitFor(() => {
      expect(clipboardWriteMock).toHaveBeenCalledWith('/tmp/aumx-logs/aumx-desktop-test.log');
      expect(revealPathMock).toHaveBeenCalledWith('/tmp/aumx-logs/aumx-desktop-test.log');
    });
  });

  it('exports and reveals a support bundle from the debug log row', async () => {
    // Arrange
    render(<AdvancedSettings />);
    await screen.findByText('/tmp/aumx-logs/aumx-desktop-test.log');

    // Act — opening the dialog previews the bundle but must NOT export yet.
    fireEvent.click(screen.getByTitle('Export support bundle'));
    await waitFor(() => {
      expect(previewSupportBundleMock).toHaveBeenCalledWith(false);
    });
    expect(exportSupportBundleMock).not.toHaveBeenCalled();

    // Act — confirming inside the dialog triggers the export + reveal.
    const confirmButton = await screen.findByRole('button', { name: /export bundle/i });
    fireEvent.click(confirmButton);

    // Assert
    await waitFor(() => {
      expect(exportSupportBundleMock).toHaveBeenCalledWith(false);
      expect(revealPathMock).toHaveBeenCalledWith('/tmp/aumx-support-test.zip');
    });
  });

  it('applies reset sidebar defaults to the live interface', async () => {
    // Arrange
    useUiStore.setState({
      sidebarCollapsed: true,
      sidebarOrganize: 'flat',
      sidebarSort: 'manual',
      sidebarWidth: 480,
    });
    render(<AdvancedSettings />);

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset settings' }));

    // Assert
    await waitFor(() => {
      expect(useUiStore.getState()).toMatchObject({
        sidebarCollapsed: false,
        sidebarOrganize: 'project',
        sidebarSort: 'manual',
        sidebarWidth: 260,
      });
    });
  });
});
