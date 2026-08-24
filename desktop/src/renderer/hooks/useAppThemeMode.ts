import { useSyncExternalStore } from 'react';
import { resolveTerminalThemeMode, resolveThemeMode, type ThemeMode } from '../../shared/theme-mode';
import { BOOT_TERMINAL_THEME } from '../lib/boot-settings';
import { useElectronSettingsStore } from '../stores';

// One document observer for the whole app: every pane subscribes to the same
// attribute stream instead of allocating its own MutationObserver.
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function subscribeToDocumentTheme(listener: () => void): () => void {
  listeners.add(listener);
  if (!observer) {
    observer = new MutationObserver(() => {
      for (const notify of listeners) notify();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    observer?.disconnect();
    observer = null;
  };
}

function readDocumentThemeMode(): ThemeMode {
  return resolveThemeMode(document.documentElement.dataset.theme);
}

/**
 * Tracks the applied `data-theme` attribute rather than the store so every
 * consumer sees the same resolved mode useTheme() writes, including `system`.
 */
export function useAppThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribeToDocumentTheme, readDocumentThemeMode);
}

export function useTerminalThemeMode(): ThemeMode {
  const appMode = useAppThemeMode();
  const preference = useElectronSettingsStore((s) => s.settings?.terminalTheme);
  return resolveTerminalThemeMode(appMode, preference ?? BOOT_TERMINAL_THEME);
}
