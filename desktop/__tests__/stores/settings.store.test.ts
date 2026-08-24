import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '../../src/renderer/stores/settings.store';

vi.mock('../../src/renderer/api/settings.api', () => ({
  getSettingDefinitions: vi.fn(),
  getSettings: vi.fn(),
  updateSetting: vi.fn(),
}));

import * as settingsApi from '../../src/renderer/api/settings.api';

const mockedApi = vi.mocked(settingsApi);

describe('useSettingsStore', () => {
  beforeEach(() => {
    useSettingsStore.setState({ definitions: [], settings: {}, isLoading: false });
    vi.clearAllMocks();
  });

  it('loads setting definitions through the renderer API boundary', async () => {
    // Arrange
    const definitions = [
      {
        key: 'useWorktree',
        label: 'Git Worktree Isolation',
        description: 'Create a separate git worktree for each pane',
        type: 'boolean' as const,
      },
    ];
    mockedApi.getSettingDefinitions.mockResolvedValue(definitions);

    // Act
    await useSettingsStore.getState().loadSettingDefinitions();

    // Assert
    expect(mockedApi.getSettingDefinitions).toHaveBeenCalledOnce();
    expect(useSettingsStore.getState().definitions).toEqual(definitions);
  });
});
