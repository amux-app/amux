import { useMemo } from 'react';
import type { ElectronSettings, SidebarOrganize, SidebarSort } from '../../shared/ipc-types';
import { useElectronSettingsStore, useUiStore } from '../stores';

type PersistSetting = <K extends keyof ElectronSettings>(key: K, value: ElectronSettings[K]) => Promise<void>;

/** One round-trip: apply to the ui store now, persist to ElectronSettings for the next boot. */
function persisted<K extends keyof ElectronSettings>(
  key: K,
  apply: (value: ElectronSettings[K]) => void,
  persist: PersistSetting,
): (value: ElectronSettings[K]) => void {
  return (value) => {
    apply(value);
    void persist(key, value);
  };
}

export interface SidebarPreferences {
  setCollapsed: (value: boolean) => void;
  setOrganize: (value: SidebarOrganize) => void;
  setSort: (value: SidebarSort) => void;
  setWidth: (value: number) => void;
  toggleCollapsed: () => void;
}

export function useSidebarPreferences(): SidebarPreferences {
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const setSidebarOrganize = useUiStore((s) => s.setSidebarOrganize);
  const setSidebarSort = useUiStore((s) => s.setSidebarSort);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const updateSettings = useElectronSettingsStore((s) => s.update);

  return useMemo(() => {
    const setCollapsed = persisted('sidebarCollapsed', setSidebarCollapsed, updateSettings);
    return {
      setCollapsed,
      setOrganize: persisted('sidebarOrganize', setSidebarOrganize, updateSettings),
      setSort: persisted('sidebarSort', setSidebarSort, updateSettings),
      setWidth: persisted('sidebarWidth', setSidebarWidth, updateSettings),
      toggleCollapsed: () => setCollapsed(!useUiStore.getState().sidebarCollapsed),
    };
  }, [setSidebarCollapsed, setSidebarOrganize, setSidebarSort, setSidebarWidth, updateSettings]);
}
