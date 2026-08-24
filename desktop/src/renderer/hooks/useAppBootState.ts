import { useEffect, useState } from 'react';
import { IPC_EVENT } from '../../shared/ipc-channels';
import type { AppBootState } from '../../shared/ipc-types';
import { getAppBootState } from '../api/app.api';
import { on } from '../api/ipc';

const INITIAL_BOOT_STATE: AppBootState = { phase: 'starting', revision: 0 };

function newestState(current: AppBootState, incoming: AppBootState): AppBootState {
  return incoming.revision > current.revision ? incoming : current;
}

export function useAppBootState(): AppBootState {
  const [state, setState] = useState<AppBootState>(INITIAL_BOOT_STATE);

  useEffect(() => {
    let active = true;
    const unsubscribe = on(IPC_EVENT.APP_BOOT_STATE_CHANGED, (incoming: unknown) => {
      if (!active || !isAppBootState(incoming)) return;
      setState((current) => newestState(current, incoming));
    });

    void getAppBootState()
      .then((snapshot) => {
        if (!active || !isAppBootState(snapshot)) return;
        setState((current) => newestState(current, snapshot));
      })
      .catch(() => {
        if (!active) return;
        setState((current) => {
          if (current.phase !== 'starting') return current;
          return {
            message: 'Unable to read application startup state.',
            phase: 'failed',
            revision: current.revision + 1,
          };
        });
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return state;
}

function isAppBootState(value: unknown): value is AppBootState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AppBootState>;
  if (!Number.isInteger(candidate.revision) || (candidate.revision ?? -1) < 0) return false;
  if (candidate.phase === 'starting' || candidate.phase === 'ready') return true;
  if (candidate.phase === 'blocked') {
    return Array.isArray(candidate.errors) && candidate.errors.every((error) => typeof error === 'string');
  }
  return candidate.phase === 'failed' && typeof candidate.message === 'string';
}
