// @vitest-environment happy-dom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsView } from '../src/renderer/components/settings/SettingsView';
import { useElectronSettingsStore } from '../src/renderer/stores/electron-settings.store';
import { useSettingsStore } from '../src/renderer/stores/settings.store';
import { useUiStore } from '../src/renderer/stores/ui.store';
import type { ElectronSettings } from '../src/shared/ipc-types';

const electronSettingsApi = vi.hoisted(() => ({
  getElectronSettings: vi.fn(),
}));
const settingsApi = vi.hoisted(() => ({
  getSettingDefinitions: vi.fn(),
  getSettings: vi.fn(),
  updateSetting: vi.fn(),
}));

vi.mock('../src/renderer/api/electron-settings.api', () => ({
  getElectronSettings: electronSettingsApi.getElectronSettings,
}));

vi.mock('../src/renderer/api/settings.api', () => settingsApi);

describe('Agent settings', () => {
  beforeEach(() => {
    electronSettingsApi.getElectronSettings.mockResolvedValue({} as ElectronSettings);
    settingsApi.getSettingDefinitions.mockResolvedValue([
      {
        key: 'opencodeScrollbackMode',
        label: 'Scrollback-Friendly Mode',
        description: 'Use OpenCode --mini for terminal scrollback and selection.',
        section: 'OpenCode',
        type: 'boolean',
      },
      {
        key: 'piThinking',
        label: 'Thinking',
        description: 'Pi thinking-level override.',
        section: 'Pi',
        type: 'select',
        options: [
          { value: '', label: 'Use Pi default' },
          { value: 'high', label: 'High' },
        ],
      },
    ]);
    settingsApi.getSettings.mockResolvedValue({ opencodeScrollbackMode: false, piThinking: '' });
    settingsApi.updateSetting.mockResolvedValue(undefined);
    useElectronSettingsStore.setState({
      isLoading: false,
      loadError: null,
      settings: {} as ElectronSettings,
    });
    useSettingsStore.setState({ definitions: [], isLoading: false, settings: {} });
    useUiStore.setState({ settingsCategory: 'agent' });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows OpenCode scrollback-friendly mode and persists it at the selected scope', async () => {
    // Arrange
    render(<SettingsView />);
    await screen.findByRole('switch', { name: 'Scrollback-Friendly Mode' });

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    fireEvent.click(await screen.findByRole('switch', { name: 'Scrollback-Friendly Mode' }));

    // Assert
    await waitFor(() => {
      expect(settingsApi.updateSetting).toHaveBeenCalledWith({
        key: 'opencodeScrollbackMode',
        scope: 'project',
        value: true,
      });
    });
  });

  it('shows Pi thinking defaults in Agent settings', async () => {
    render(<SettingsView />);

    expect(await screen.findByRole('combobox', { name: 'Thinking' })).toBeTruthy();
    expect(screen.getByText('Pi')).toBeTruthy();
  });
});
