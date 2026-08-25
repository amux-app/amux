import type { AgentCapability, AgentName } from 'muxbase/core';
import { IPC } from '../../shared/ipc-channels';
import { invoke } from './ipc';

type AgentListResponse = AgentName[] | { error: string };

async function requestAgents(channel: string, capability?: AgentCapability): Promise<AgentName[]> {
  const response = capability
    ? await invoke<AgentListResponse>(channel, { capability })
    : await invoke<AgentListResponse>(channel);
  if (Array.isArray(response)) return response;
  throw new Error(response.error);
}

export function listAgents(capability?: AgentCapability): Promise<AgentName[]> {
  return requestAgents(IPC.AGENT_LIST, capability);
}

export function refreshAgents(capability?: AgentCapability): Promise<AgentName[]> {
  return requestAgents(IPC.AGENT_REFRESH, capability);
}
