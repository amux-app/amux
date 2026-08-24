import { BrowserWindow, nativeTheme } from 'electron';
import { APP_WINDOW_BACKGROUND_COLORS } from '../../shared/app-colors.js';
import { resolveTerminalThemeMode, resolveThemeMode, type ThemeMode } from '../../shared/theme-mode.js';
import { ElectronSettingsService } from './ElectronSettingsService.js';

/**
 * Resolved app theme for main-process consumers that run before (or outside of)
 * the renderer, such as the BrowserWindow background painted at construction.
 */
export function getAppThemeMode(): ThemeMode {
  const settings = ElectronSettingsService.getInstance().getAll();
  if (settings.theme !== 'system') return resolveThemeMode(settings.theme);
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

export function getTerminalThemeMode(): ThemeMode {
  const preference = ElectronSettingsService.getInstance().getAll().terminalTheme;
  return resolveTerminalThemeMode(getAppThemeMode(), preference);
}

/**
 * BrowserWindow paints its background color natively during resize and before
 * the renderer draws, so it has to follow theme changes made after construction.
 */
export function syncWindowBackgroundColors(): void {
  const color = APP_WINDOW_BACKGROUND_COLORS[getAppThemeMode()];
  for (const win of BrowserWindow.getAllWindows()) {
    win.setBackgroundColor(color);
  }
}
