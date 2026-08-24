import { useEffect } from 'react';
import { hasCompleteProviderStatusMap } from '../../shared/provider-status';
import { getProviderStatus } from '../api/llm.api';
import { rendererLog } from '../lib/rendererLog';
import { useElectronSettingsStore } from '../stores/electron-settings.store';
import { useProviderStatusStore } from '../stores/provider-status.store';

const COMPLETE_POLL_INTERVAL_MS = 60 * 60 * 1000;
const INCOMPLETE_RETRY_MS = 5 * 60 * 1000;
const PROVIDER_STATUS_LOG_SCOPE = 'provider-status';

interface RefreshSnapshot {
  complete: boolean;
  fetchedAt: number;
}

let inFlight: Promise<RefreshSnapshot> | null = null;

function shouldRefresh(fetchedAt: number, complete: boolean): boolean {
  if (!fetchedAt) return true;
  const staleMs = complete ? COMPLETE_POLL_INTERVAL_MS : INCOMPLETE_RETRY_MS;
  return Date.now() - fetchedAt >= staleMs;
}

function refreshIntervalMs(complete: boolean): number {
  return complete ? COMPLETE_POLL_INTERVAL_MS : INCOMPLETE_RETRY_MS;
}

function nextRefreshMs({ complete, fetchedAt }: RefreshSnapshot): number {
  const interval = refreshIntervalMs(complete);
  if (!fetchedAt) return interval;
  const elapsed = Math.max(0, Date.now() - fetchedAt);
  return Math.max(0, interval - elapsed);
}

function refresh(): Promise<RefreshSnapshot> {
  if (inFlight) return inFlight;

  const { fetchedAt, statuses } = useProviderStatusStore.getState();
  const cachedComplete = hasCompleteProviderStatusMap(statuses);
  if (!shouldRefresh(fetchedAt, cachedComplete)) {
    return Promise.resolve({ complete: cachedComplete, fetchedAt });
  }

  inFlight = getProviderStatus()
    .then((result) => {
      if (result && !result.error) {
        useProviderStatusStore.getState().set(result.statuses, result.fetchedAt);
        return {
          complete: hasCompleteProviderStatusMap(result.statuses),
          fetchedAt: result.fetchedAt,
        };
      }
      return { complete: false, fetchedAt: Date.now() };
    })
    .catch((error) => {
      rendererLog.warn(PROVIDER_STATUS_LOG_SCOPE, 'Refresh failed', { error });
      return { complete: false, fetchedAt: Date.now() };
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function useProviderStatus(): void {
  const disabled = useElectronSettingsStore((s) => s.settings?.disableExternalNetwork ?? false);

  useEffect(() => {
    if (disabled) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const schedule = (snapshot: RefreshSnapshot): void => {
      timer = setTimeout(run, nextRefreshMs(snapshot));
    };

    const run = (): void => {
      void refresh().then((snapshot) => {
        if (!disposed) schedule(snapshot);
      });
    };

    run();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [disabled]);
}
