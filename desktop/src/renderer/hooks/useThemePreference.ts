import { useCallback } from 'react';
import type { Theme } from '../stores';
import { useElectronSettingsStore, useUiStore } from '../stores';

export function useThemePreference(): (theme: Theme) => void {
  const setTheme = useUiStore((s) => s.setTheme);
  const updateSettings = useElectronSettingsStore((s) => s.update);

  return useCallback(
    (theme: Theme) => {
      setTheme(theme);
      void updateSettings('theme', theme);
    },
    [setTheme, updateSettings],
  );
}
