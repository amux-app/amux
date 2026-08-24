import type { AumxSettings, SettingDefinition } from 'aumx/core';
import { IPC } from '../../shared/ipc-channels';
import type { SettingsGetRequest, SettingsUpdateRequest } from '../../shared/ipc-types';
import { invoke } from './ipc';

export function getSettingDefinitions(): Promise<SettingDefinition[]> {
  return invoke<SettingDefinition[]>(IPC.SETTINGS_DEFINITIONS);
}

export function getSettings(req?: SettingsGetRequest): Promise<AumxSettings> {
  return invoke<AumxSettings>(IPC.SETTINGS_GET, req);
}

export function updateSetting(req: SettingsUpdateRequest): Promise<void> {
  return invoke<void>(IPC.SETTINGS_UPDATE, req);
}
