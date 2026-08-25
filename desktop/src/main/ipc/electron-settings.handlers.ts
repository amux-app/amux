import { is } from '@electron-toolkit/utils';
import { BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels.js';
import type { ElectronSettings, ElectronSettingsUpdateRequest } from '../../shared/ipc-types.js';
import type { MuxBaseBridge } from '../services/MuxBaseBridge.js';
import { resolveWindowOpacity } from '../e2e-window-mode.js';
import { syncWindowBackgroundColors } from '../services/app-theme.js';
import { ElectronSettingsService } from '../services/ElectronSettingsService.js';
import { log } from '../services/Logger.js';
import { PerformanceMonitorService } from '../services/PerformanceMonitorService.js';
import { publishSessionColorHint } from '../utils/tmuxSession.js';
import { secureHandle } from './ipc-security.js';
import { stopLspServers } from './lsp.handlers.js';

export function registerElectronSettingsHandlers(bridge: MuxBaseBridge): void {
  const service = ElectronSettingsService.getInstance();

  secureHandle(IPC.ELECTRON_SETTINGS_GET, () => service.getAll());

  secureHandle(IPC.ELECTRON_SETTINGS_UPDATE, (_event, request: ElectronSettingsUpdateRequest) => {
    log.info('ipc:electron-settings', 'UPDATE', { key: request.key });
    const updated = service.update(request.key, request.value);
    applySideEffects(request.key, updated, bridge);
    return updated;
  });

  secureHandle(IPC.ELECTRON_SETTINGS_RESET, () => {
    log.info('ipc:electron-settings', 'RESET');
    const defaults = service.reset();

    const win = focusedWindow();
    if (win) applyWindowSettings(win, defaults);
    syncWindowBackgroundColors();

    PerformanceMonitorService.getInstance().stop();
    applyDebugLoggingLevel(defaults.debugLogging);
    bridge.setAgentLifecycleAdaptersEnabled(defaults.enableAgentLifecycleAdapters === true);

    return defaults;
  });
}

/**
 * Debug records are off by default in packaged builds; dev builds and the
 * Advanced Settings "Debug logging" toggle opt back in.
 */
export function applyDebugLoggingLevel(debugLogging: boolean): void {
  log.setLevel(debugLogging || is.dev ? 'debug' : 'info');
}

function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

const WINDOW_SETTING_KEYS: ReadonlySet<keyof ElectronSettings> = new Set([
  'alwaysOnTop',
  'windowOpacity',
  'uiZoom',
]);

export function applyWindowSettings(win: BrowserWindow, settings: ElectronSettings): void {
  win.setAlwaysOnTop(settings.alwaysOnTop);
  win.setOpacity(resolveWindowOpacity(process.env, settings.windowOpacity));
  win.webContents.setZoomFactor(settings.uiZoom);
}

function applySideEffects(
  key: ElectronSettingsUpdateRequest['key'],
  updated: ElectronSettings,
  bridge: MuxBaseBridge,
): void {
  if (WINDOW_SETTING_KEYS.has(key)) {
    const win = focusedWindow();
    if (win) applyWindowSettings(win, updated);
  }

  if (key === 'theme') {
    syncWindowBackgroundColors();
  }

  if (key === 'theme' || key === 'terminalTheme') {
    void publishSessionColorHint(bridge.getSessionName());
  }

  if (key === 'showPerformanceMetrics') {
    const perfMonitor = PerformanceMonitorService.getInstance();
    if (updated.showPerformanceMetrics) perfMonitor.start();
    else perfMonitor.stop();
  }

  if (key === 'enableTelemetryCostTracking') {
    bridge.setTelemetryCostTrackingEnabled(updated.enableTelemetryCostTracking);
  }

  if (key === 'enableAgentLifecycleAdapters') {
    bridge.setAgentLifecycleAdaptersEnabled(updated.enableAgentLifecycleAdapters === true);
  }

  if (key === 'enableLanguageIntelligence' && !updated.enableLanguageIntelligence) {
    stopLspServers();
  }

  if (key === 'debugLogging') {
    applyDebugLoggingLevel(updated.debugLogging);
    log.info('ipc:electron-settings', 'Debug logging level updated', { enabled: updated.debugLogging });
  }
}
