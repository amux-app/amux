import type { NormalizedSession } from '../../shared/agent-session-types';
import type { AgentSessionGetRequest, AgentSessionSearchRequest, AgentSessionSearchResult } from '../../shared/ipc-types';
import { IPC } from '../../shared/ipc-channels';
import { sanitizeAgentSessionSearchResults, sanitizeNormalizedSession, warnDroppedItems, warnInvalidPayload } from '../lib/runtimeValidation';
import { invoke } from './ipc';

export async function getSession(paneId: string): Promise<NormalizedSession | null> {
  const result = await invoke<{ session?: unknown; error?: string }>(
    IPC.AGENT_SESSION_GET,
    { paneId } satisfies AgentSessionGetRequest,
  );
  if (result.session === undefined || result.session === null) {
    return null;
  }

  const session = sanitizeNormalizedSession(result.session);
  if (!session) {
    warnInvalidPayload('agent-session:get', result.session);
    return null;
  }

  return session;
}

export async function searchSessions(query: string): Promise<AgentSessionSearchResult[]> {
  const payload = await invoke<unknown>(
    IPC.AGENT_SESSION_SEARCH,
    { query } satisfies AgentSessionSearchRequest,
  );

  const results = sanitizeAgentSessionSearchResults(payload);
  if (!results) {
    warnInvalidPayload('agent-session:search', payload);
    return [];
  }

  if (Array.isArray(payload) && results.length !== payload.length) {
    warnDroppedItems('agent-session:search', payload.length, results.length);
  }

  return results;
}
