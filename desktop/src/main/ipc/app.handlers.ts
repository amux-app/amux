import { app, ipcMain } from 'electron';
import { IPC, IPC_SYNC } from '../../shared/ipc-channels.js';
import type { AppFileFlushResultRequest, MuxBaseBootSettings, ElectronSettings } from '../../shared/ipc-types.js';
import type { AppBootService } from '../services/AppBootService.js';
import { ElectronSettingsService } from '../services/ElectronSettingsService.js';
import { log } from '../services/Logger.js';
import { secureHandle } from './ipc-security.js';

/**
 * An unreplied sync IPC message hangs the preload forever, so an unreadable
 * settings file (EACCES/EPERM/EISDIR) must degrade to defaults, never throw.
 */
function pickBootSettings(settings: ElectronSettings): MuxBaseBootSettings {
  return {
    sidebarCollapsed: settings.sidebarCollapsed,
    sidebarOrganize: settings.sidebarOrganize,
    sidebarSort: settings.sidebarSort,
    sidebarWidth: settings.sidebarWidth,
    terminalTheme: settings.terminalTheme,
    terminalSelectionIntegrationEnabled: process.env.MUXBASE_DISABLE_TERMINAL_SELECTION_INTEGRATION !== '1',
    theme: settings.theme,
  };
}

function readBootSettings(): MuxBaseBootSettings {
  try {
    return pickBootSettings(ElectronSettingsService.getInstance().getAll());
  } catch (error) {
    log.error('ipc:app', 'Boot settings read failed, booting with defaults', error);
    return pickBootSettings(ElectronSettingsService.getDefaults());
  }
}

export function registerAppHandlers(
  bootService: AppBootService,
  completeFileFlush: (request: AppFileFlushResultRequest) => boolean,
): void {
  // Blocks the preload script, so it must stay a plain settings read.
  ipcMain.on(IPC_SYNC.APP_BOOT_SETTINGS, (event) => {
    event.returnValue = readBootSettings();
  });

  secureHandle(IPC.APP_BOOT_STATE_GET, () => bootService.getState());
  secureHandle(IPC.APP_QUIT, () => {
    app.quit();
    return true;
  }, { mainWindowOnly: true });
  secureHandle(IPC.APP_RELAUNCH, () => {
    app.relaunch();
    app.quit();
    return true;
  }, { mainWindowOnly: true });
  secureHandle(IPC.APP_FILE_FLUSH_RESULT, (_event, request: AppFileFlushResultRequest) => {
    return completeFileFlush(request);
  });
}
