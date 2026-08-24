import { create } from 'zustand';
import type { ElectronSettings } from '../../shared/ipc-types';
import * as electronSettingsApi from '../api/electron-settings.api';
import { useNotificationStore } from './notification.store';
import { useUiStore } from './ui.store';

interface ElectronSettingsState {
  settings: ElectronSettings | null;
  isLoading: boolean;
  loadError: string | null;
}

interface ElectronSettingsActions {
  load: () => Promise<void>;
  update: <K extends keyof ElectronSettings>(key: K, value: ElectronSettings[K]) => Promise<void>;
  reset: () => Promise<void>;
}

function toastError(title: string, error: unknown): void {
  useNotificationStore.getState().addToast('Please try again.', 'error', {
    title,
    detail: error instanceof Error ? error.message : String(error),
  });
}

function applySettingsToUiStore(settings: ElectronSettings): void {
  const ui = useUiStore.getState();
  ui.setTheme(settings.theme);
  ui.setSidebarCollapsed(settings.sidebarCollapsed);
  ui.setSidebarOrganize(settings.sidebarOrganize);
  ui.setSidebarSort(settings.sidebarSort);
  ui.setSidebarWidth(settings.sidebarWidth);
}

export const useElectronSettingsStore = create<ElectronSettingsState & ElectronSettingsActions>((set) => ({
  settings: null,
  isLoading: false,
  loadError: null,

  load: async () => {
    set({ isLoading: true, loadError: null });
    try {
      const settings = await electronSettingsApi.getElectronSettings();
      set({ settings });
    } catch (error) {
      set({ loadError: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ isLoading: false });
    }
  },

  update: async (key, value) => {
    const previous = useElectronSettingsStore.getState().settings;
    set((state) => ({
      settings: state.settings ? { ...state.settings, [key]: value } : null,
    }));
    try {
      const updated = await electronSettingsApi.updateElectronSetting({ key, value });
      set({ settings: updated });
    } catch (error) {
      set({ settings: previous });
      toastError('Could not save setting', error);
    }
  },

  reset: async () => {
    set({ isLoading: true });
    try {
      const defaults = await electronSettingsApi.resetElectronSettings();
      set({ settings: defaults });
      applySettingsToUiStore(defaults);
    } catch (error) {
      toastError('Could not reset settings', error);
    } finally {
      set({ isLoading: false });
    }
  },
}));
