import { create } from 'zustand';
import type { AppUpdateSnapshot } from '../../shared/app-update-types';
import { appUpdateSnapshotSchema } from '../../shared/app-update-types';
import * as updateApi from '../api/update.api';

interface UpdateState {
  initialized: boolean;
  snapshot: AppUpdateSnapshot | null;
}

interface UpdateActions {
  applySnapshot: (payload: unknown) => boolean;
  checkForUpdates: () => Promise<void>;
  initialize: () => Promise<void>;
  installUpdate: () => Promise<boolean>;
  reset: () => void;
}

type UpdateStore = UpdateState & UpdateActions;

let initializationPromise: Promise<void> | null = null;
let unsubscribe: (() => void) | null = null;

const INITIAL_STATE: UpdateState = {
  initialized: false,
  snapshot: null,
};

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  ...INITIAL_STATE,

  applySnapshot: (payload) => {
    const parsed = appUpdateSnapshotSchema.safeParse(payload);
    if (!parsed.success) return false;
    const current = get().snapshot;
    if (current && parsed.data.revision <= current.revision) return false;
    set({ snapshot: parsed.data });
    return true;
  },

  checkForUpdates: async () => {
    const snapshot = await updateApi.checkForUpdates();
    get().applySnapshot(snapshot);
  },

  initialize: () => {
    if (initializationPromise) return initializationPromise;

    unsubscribe = updateApi.subscribeToUpdateState((payload) => {
      get().applySnapshot(payload);
    });
    initializationPromise = updateApi.getUpdateState()
      .then((snapshot) => {
        get().applySnapshot(snapshot);
        set({ initialized: true });
      })
      .catch(() => {
        set({ initialized: true });
      });
    return initializationPromise;
  },

  installUpdate: async () => {
    const response = await updateApi.installUpdate();
    return response.accepted;
  },

  reset: () => {
    unsubscribe?.();
    unsubscribe = null;
    initializationPromise = null;
    set(INITIAL_STATE);
  },
}));

interface UpdateSelectorState {
  snapshot: AppUpdateSnapshot | null;
}

export function selectUpdateControlVisible(state: UpdateSelectorState): boolean {
  return state.snapshot?.phase === 'available'
    || state.snapshot?.phase === 'downloading'
    || state.snapshot?.phase === 'ready'
    || state.snapshot?.phase === 'installing';
}

export function selectUpdateProgressPercent(state: UpdateSelectorState): number | null {
  return state.snapshot?.phase === 'downloading' ? state.snapshot.progress?.percent ?? 0 : null;
}
