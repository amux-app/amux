import { useEffect } from 'react';
import * as agentSessionApi from '../api/agent-session.api';
import { useAgentSessionStore } from '../stores/agent-session.store';

const INITIAL_POLL_MS = 1200;
const MAX_POLL_MS = 30_000;
const MAX_ELAPSED_MS = 10 * 60 * 1000;
const BACKOFF_FACTOR = 2;
const inFlightByPaneId = new Map<string, Promise<void>>();

export function useAgentSessionHydration(paneId: string | null | undefined, enabled = true): void {
  const updateSession = useAgentSessionStore((s) => s.updateSession);

  useEffect(() => {
    if (!paneId || !enabled) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let currentInterval = INITIAL_POLL_MS;
    const startedAt = Date.now();

    const hasUsableSession = (): boolean => {
      const session = useAgentSessionStore.getState().sessions[paneId];
      if (!session) return false;
      if (session.messages.length > 0) return true;
      if (session.metrics.totalTokens > 0) return true;
      if (session.metrics.toolCallCount > 0) return true;
      if (session.awaitingUserInput || !!session.pendingUserQuestion) return true;
      return false;
    };

    const scheduleRetry = () => {
      if (cancelled) return;
      if (Date.now() - startedAt >= MAX_ELAPSED_MS) return;
      timer = setTimeout(() => {
        void hydrate();
      }, currentInterval);
      currentInterval = Math.min(currentInterval * BACKOFF_FACTOR, MAX_POLL_MS);
    };

    const hydrate = async () => {
      if (cancelled || hasUsableSession()) return;

      const inFlight = inFlightByPaneId.get(paneId);
      if (inFlight) {
        await inFlight.catch(() => {});
      } else {
        let requestPromise!: Promise<void>;
        requestPromise = (async () => {
          try {
            const session = await agentSessionApi.getSession(paneId);
            if (cancelled) return;
            if (session) {
              updateSession(paneId, session);
            }
          } finally {
            if (inFlightByPaneId.get(paneId) === requestPromise) {
              inFlightByPaneId.delete(paneId);
            }
          }
        })();

        inFlightByPaneId.set(paneId, requestPromise);

        try {
          await requestPromise;
        } catch {
          // Session parsing can legitimately be unavailable during startup; retry below.
        }
      }

      if (!hasUsableSession()) {
        scheduleRetry();
      }
    };

    void hydrate();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [paneId, enabled, updateSession]);
}
