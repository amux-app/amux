import { create } from 'zustand';
import type { MuxBaseSettings, SettingDefinition, SettingsScope } from 'muxbase/core';
import * as settingsApi from '../api/settings.api';

interface SettingsState {
  definitions: SettingDefinition[];
  settings: MuxBaseSettings;
  isLoading: boolean;
}

interface SettingsActions {
  loadSettingDefinitions: () => Promise<void>;
  loadSettings: (projectRoot?: string) => Promise<void>;
  updateSetting: (key: string, value: unknown, scope: SettingsScope) => Promise<void>;
}

export const useSettingsStore = create<SettingsState & SettingsActions>((set) => ({
  definitions: [],
  settings: {},
  isLoading: false,

  loadSettingDefinitions: async () => {
    const definitions = await settingsApi.getSettingDefinitions();
    set({ definitions });
  },

  loadSettings: async (projectRoot) => {
    set({ isLoading: true });
    try {
      const settings = await settingsApi.getSettings(
        projectRoot ? { projectRoot } : undefined,
      );
      set({ settings });
    } finally {
      set({ isLoading: false });
    }
  },

  updateSetting: async (key, value, scope) => {
    await settingsApi.updateSetting({ key, value, scope });
    set((state) => ({
      settings: { ...state.settings, [key]: value },
    }));
  },
}));
