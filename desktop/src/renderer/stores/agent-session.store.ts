import { create } from 'zustand';
import type { NormalizedSession } from '../../shared/agent-session-types';

interface AgentSessionState {
  sessions: Record<string, NormalizedSession>;
}

interface AgentSessionActions {
  updateSession: (paneId: string, session: NormalizedSession) => boolean;
  removeSession: (paneId: string) => void;
  getSession: (paneId: string) => NormalizedSession | undefined;
}

function isStaleSessionSnapshot(previous: NormalizedSession, next: NormalizedSession): boolean {
  if (previous.sessionId !== next.sessionId) {
    return false;
  }

  const previousLastUpdate = previous.lastUpdateTime ?? 0;
  const nextLastUpdate = next.lastUpdateTime ?? 0;

  if (next.messages.length === 0 && previous.messages.length > 0) return true;
  if (next.messages.length < previous.messages.length) return true;

  if (
    next.metrics.totalTokens < previous.metrics.totalTokens
    && next.messages.length <= previous.messages.length
  ) {
    return true;
  }

  if (
    next.metrics.toolCallCount < previous.metrics.toolCallCount
    && next.messages.length <= previous.messages.length
  ) {
    return true;
  }

  if (
    nextLastUpdate > 0
    && previousLastUpdate > 0
    && nextLastUpdate < previousLastUpdate
    && next.messages.length <= previous.messages.length
  ) {
    return true;
  }

  return false;
}

export const useAgentSessionStore = create<AgentSessionState & AgentSessionActions>((set, get) => ({
  sessions: {},

  updateSession: (paneId, session) => {
    const previous = get().sessions[paneId];
    if (previous && isStaleSessionSnapshot(previous, session)) {
      return false;
    }
    if (previous === session) {
      return false;
    }
    set((state) => {
      return {
        sessions: { ...state.sessions, [paneId]: session },
      };
    });
    return true;
  },

  removeSession: (paneId) =>
    set((state) => {
      const { [paneId]: _, ...rest } = state.sessions;
      return { sessions: rest };
    }),

  getSession: (paneId) => get().sessions[paneId],
}));
