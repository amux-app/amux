import type { ElectronSettings, ElectronSettingsUpdateRequest } from '../../shared/ipc-types';
import { IPC } from '../../shared/ipc-channels';
import { invoke } from './ipc';

export function getElectronSettings(): Promise<ElectronSettings> {
  return invoke<ElectronSettings>(IPC.ELECTRON_SETTINGS_GET);
}

export function updateElectronSetting(req: ElectronSettingsUpdateRequest): Promise<ElectronSettings> {
  return invoke<ElectronSettings>(IPC.ELECTRON_SETTINGS_UPDATE, req);
}

export function resetElectronSettings(): Promise<ElectronSettings> {
  return invoke<ElectronSettings>(IPC.ELECTRON_SETTINGS_RESET);
}
