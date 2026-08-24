import { IPC } from '../../shared/ipc-channels.js';
import type { AgentListRequest } from '../../shared/ipc-types.js';
import type { AumxBridge } from '../services/AumxBridge.js';
import { formatError } from '../utils/formatError.js';
import { secureHandle } from './ipc-security.js';
import { log } from '../services/Logger.js';

export function registerAgentHandlers(bridge: AumxBridge): void {
  secureHandle(IPC.AGENT_LIST, async (_event, request?: AgentListRequest) => {
    try {
      const agents = await bridge.getAvailableAgents(request?.capability);
      log.debug('ipc:agent', 'AGENT_LIST', { agents });
      return agents;
    } catch (error) {
      log.error('ipc:agent', 'AGENT_LIST failed', error);
      return { error: formatError(error) };
    }
  });
  secureHandle(IPC.AGENT_REFRESH, async (_event, request?: AgentListRequest) => {
    try {
      const agents = await bridge.refreshAvailableAgents(request?.capability);
      log.info('ipc:agent', 'AGENT_REFRESH', { agents });
      return agents;
    } catch (error) {
      log.error('ipc:agent', 'AGENT_REFRESH failed', error);
      return { error: formatError(error) };
    }
  });
}
