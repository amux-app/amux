import type { AgentHealthResponse, ProviderStatusResponse } from '../../shared/ipc-types';
import { IPC } from '../../shared/ipc-channels';
import { invoke } from './ipc';

export function getProviderStatus(): Promise<ProviderStatusResponse> {
  return invoke<ProviderStatusResponse>(IPC.LLM_STATUS);
}

export function getAgentHealth(): Promise<AgentHealthResponse> {
  return invoke<AgentHealthResponse>(IPC.AGENT_HEALTH);
}
