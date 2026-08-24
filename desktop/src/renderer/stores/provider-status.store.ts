import { create } from 'zustand';
import type { ProviderStatusMap } from '../../shared/ipc-types';

interface ProviderStatusState {
  statuses: ProviderStatusMap;
  fetchedAt: number;
}

interface ProviderStatusActions {
  set: (statuses: ProviderStatusMap, fetchedAt: number) => void;
}

export const useProviderStatusStore = create<ProviderStatusState & ProviderStatusActions>(
  (set) => ({
    statuses: {},
    fetchedAt: 0,
    set: (statuses, fetchedAt) => set({ statuses, fetchedAt }),
  }),
);
