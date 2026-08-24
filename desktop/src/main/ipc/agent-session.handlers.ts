import type { AumxBridge } from '../services/AumxBridge.js';
import { IPC } from '../../shared/ipc-channels.js';
import type { AgentSessionGetRequest, AgentSessionSearchRequest } from '../../shared/ipc-types.js';
import { formatError } from '../utils/formatError.js';
import { secureHandle } from './ipc-security.js';
import { log } from '../services/Logger.js';

export function registerAgentSessionHandlers(bridge: AumxBridge): void {
  secureHandle(IPC.AGENT_SESSION_GET, async (_event, request: AgentSessionGetRequest) => {
    log.debug('ipc:agent-session', 'GET invoked', { paneId: request.paneId });
    try {
      const session = bridge.getAgentSession(request.paneId);
      return { session };
    } catch (error) {
      log.error('ipc:agent-session', 'GET failed', error);
      return { error: formatError(error) };
    }
  });

  secureHandle(IPC.AGENT_SESSION_SEARCH, async (_event, request: AgentSessionSearchRequest) => {
    log.info('ipc:agent-session', 'SEARCH invoked', { query: request.query });
    try {
      return await bridge.searchAgentSessions(request.query);
    } catch (error) {
      log.error('ipc:agent-session', 'SEARCH failed', error);
      return [];
    }
  });
}
