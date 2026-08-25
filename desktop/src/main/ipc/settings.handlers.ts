import {
  isSettingKey,
  SETTING_DEFINITIONS,
  SettingsManager,
  type MuxBaseSettings,
  validateSettingValue,
} from 'muxbase/core';
import { IPC } from '../../shared/ipc-channels.js';
import type { SettingsGetRequest, SettingsUpdateRequest } from '../../shared/ipc-types.js';
import type { MuxBaseBridge } from '../services/MuxBaseBridge.js';
import { log } from '../services/Logger.js';
import { formatError } from '../utils/formatError.js';
import { authorizeProjectRoot } from '../services/projectRootAuthorization.js';
import { secureHandle } from './ipc-security.js';

export function registerSettingsHandlers(bridge: MuxBaseBridge): void {
  secureHandle(IPC.SETTINGS_DEFINITIONS, () => SETTING_DEFINITIONS);

  secureHandle(IPC.SETTINGS_GET, async (_event, request?: SettingsGetRequest) => {
    try {
      const root = await authorizeProjectRoot(request?.projectRoot, bridge.getProjectRoot(), bridge.getPanes()) ?? bridge.getProjectRoot();
      const settings = SettingsManager.getInstance(root).getSettings();
      log.debug('ipc:settings', 'SETTINGS_GET', { root });
      return settings;
    } catch (error) {
      log.error('ipc:settings', 'SETTINGS_GET failed', error);
      return { error: formatError(error) };
    }
  });

  secureHandle(IPC.SETTINGS_UPDATE, (_event, request: SettingsUpdateRequest) => {
    log.info('ipc:settings', 'SETTINGS_UPDATE', { key: request.key, scope: request.scope });
    try {
      if (!isSettingKey(request.key) || !validateSettingValue(request.key, request.value)) {
        throw new Error(`Invalid setting ${request.key}`);
      }
      const root = bridge.getProjectRoot();
      SettingsManager.getInstance(root).updateSetting(
        request.key as keyof MuxBaseSettings,
        request.value as MuxBaseSettings[keyof MuxBaseSettings],
        request.scope,
      );
      return { success: true };
    } catch (error) {
      log.error('ipc:settings', 'SETTINGS_UPDATE failed', error);
      return { error: formatError(error) };
    }
  });
}
