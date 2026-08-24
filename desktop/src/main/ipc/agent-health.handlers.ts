import { IPC } from '../../shared/ipc-channels.js';
import type { AgentHealthResponse } from '../../shared/ipc-types.js';
import { AgentHealthService } from '../services/AgentHealthService.js';
import { ElectronSettingsService } from '../services/ElectronSettingsService.js';
import { log } from '../services/Logger.js';
import { formatError } from '../utils/formatError.js';
import { secureHandle } from './ipc-security.js';

export function registerAgentHealthHandlers(): void {
  const service = AgentHealthService.getInstance();
  const settings = ElectronSettingsService.getInstance();

  secureHandle(IPC.AGENT_HEALTH, async () => {
    try {
      service.setDisabled(settings.get('disableExternalNetwork') === true);
      return await service.getHealth();
    } catch (error) {
      log.error('ipc:agent-health', 'GET failed', error);
      const fallback: AgentHealthResponse = {
        snapshots: {},
        fetchedAt: Date.now(),
        error: formatError(error),
      };
      return fallback;
    }
  });
}
