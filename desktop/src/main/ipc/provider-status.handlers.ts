import { IPC } from '../../shared/ipc-channels.js';
import type { ProviderStatusResponse } from '../../shared/ipc-types.js';
import { ElectronSettingsService } from '../services/ElectronSettingsService.js';
import { log } from '../services/Logger.js';
import { ProviderStatusService } from '../services/ProviderStatusService.js';
import { formatError } from '../utils/formatError.js';
import { secureHandle } from './ipc-security.js';

export function registerProviderStatusHandlers(): void {
  const service = ProviderStatusService.getInstance();
  const settings = ElectronSettingsService.getInstance();

  secureHandle(IPC.LLM_STATUS, async () => {
    try {
      service.setDisabled(settings.get('disableExternalNetwork') === true);
      return await service.getStatus();
    } catch (error) {
      log.error('ipc:llm-status', 'GET failed', error);
      const fallback: ProviderStatusResponse = {
        statuses: {},
        fetchedAt: Date.now(),
        error: formatError(error),
      };
      return fallback;
    }
  });
}
