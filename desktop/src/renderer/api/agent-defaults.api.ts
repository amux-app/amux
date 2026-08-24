import { IPC } from '../../shared/ipc-channels';
import type { AgentDefaultsResponse } from '../../shared/ipc-types';
import { invoke } from './ipc';

export function getAgentDefaults(projectRoot?: string): Promise<AgentDefaultsResponse> {
  return invoke<AgentDefaultsResponse>(
    IPC.AGENT_DEFAULTS_GET,
    ...(projectRoot !== undefined ? [{ projectRoot }] : []),
  );
}
