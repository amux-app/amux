import { IPC } from '../../shared/ipc-channels.js';
import type { AgentDefaultsResponse } from '../../shared/ipc-types.js';
import { readClaudeDefaults } from '../services/agent-defaults/ClaudeDefaultsReader.js';
import { readCodexDefaults } from '../services/agent-defaults/CodexDefaultsReader.js';
import { readOpencodeDefaults } from '../services/agent-defaults/OpencodeDefaultsReader.js';
import { readPiDefaults } from '../services/agent-defaults/PiDefaultsReader.js';
import { secureHandle } from './ipc-security.js';
import { log } from '../services/Logger.js';
import type { AumxBridge } from '../services/AumxBridge.js';
import { authorizeProjectRoot } from '../services/projectRootAuthorization.js';

export function registerAgentDefaultsHandlers(bridge: AumxBridge): void {
  secureHandle(IPC.AGENT_DEFAULTS_GET, async (_event, req?: { projectRoot?: string }): Promise<AgentDefaultsResponse> => {
    const projectRoot = await authorizeProjectRoot(req?.projectRoot, bridge.getProjectRoot(), bridge.getPanes());
    const response: AgentDefaultsResponse = {
      claude: readClaudeDefaults(projectRoot),
      codex: readCodexDefaults(),
      opencode: readOpencodeDefaults(),
      pi: readPiDefaults(projectRoot),
    };
    log.debug('ipc:agent-defaults', 'AGENT_DEFAULTS_GET', response);
    return response;
  });
}
