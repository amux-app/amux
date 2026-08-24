import { useEffect } from 'react';
import { getAgentHealth } from '../api/llm.api';
import { rendererLog } from '../lib/rendererLog';
import { useAgentHealthStore } from '../stores/agent-health.store';
import { useElectronSettingsStore } from '../stores/electron-settings.store';

const POLL_INTERVAL_MS = 60 * 60 * 1000;
const INCOMPLETE_RETRY_MS = 15 * 60 * 1000;
const SCOPE = 'agent-health';

let inFlight: Promise<{ fetchedAt: number; complete: boolean }> | null = null;

async function refresh(): Promise<{ fetchedAt: number; complete: boolean }> {
  if (inFlight) return inFlight;
  inFlight = getAgentHealth()
    .then((result) => {
      if (result && !result.error) {
        useAgentHealthStore.getState().set(result.snapshots, result.fetchedAt);
        const complete = !!(result.snapshots.claude && result.snapshots.codex);
        return { fetchedAt: result.fetchedAt, complete };
      }
      return { fetchedAt: Date.now(), complete: false };
    })
    .catch((error) => {
      rendererLog.warn(SCOPE, 'Refresh failed', { error });
      return { fetchedAt: Date.now(), complete: false };
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function useAgentHealth(): void {
  const enabled = useElectronSettingsStore(
    (s) => (s.settings?.showAgentHealthTracker ?? false) && !(s.settings?.disableExternalNetwork ?? false),
  );

  useEffect(() => {
    if (!enabled) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const schedule = (complete: boolean): void => {
      timer = setTimeout(run, complete ? POLL_INTERVAL_MS : INCOMPLETE_RETRY_MS);
    };

    const run = (): void => {
      void refresh().then((snapshot) => {
        if (!disposed) schedule(snapshot.complete);
      });
    };

    run();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);
}
