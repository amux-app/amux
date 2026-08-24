import { create } from 'zustand';

interface WorktreeStatus {
  commitsAhead: number | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
  isDirty: boolean;
  lastFetched: number;
}

interface WorktreeStatusState {
  statuses: Record<string, WorktreeStatus>;
}

interface WorktreeStatusActions {
  set: (paneId: string, status: WorktreeStatus) => void;
  remove: (paneId: string) => void;
  prune: (activePaneIds: string[]) => void;
}

export const useWorktreeStatusStore = create<WorktreeStatusState & WorktreeStatusActions>(
  (set) => ({
    statuses: {},

    set: (paneId, status) =>
      set((state) => {
        const existing = state.statuses[paneId];
        if (
          existing &&
          existing.commitsAhead === status.commitsAhead &&
          existing.filesChanged === status.filesChanged &&
          existing.insertions === status.insertions &&
          existing.deletions === status.deletions &&
          existing.isDirty === status.isDirty
        ) {
          return state;
        }
        return { statuses: { ...state.statuses, [paneId]: status } };
      }),

    remove: (paneId) =>
      set((state) => {
        if (!(paneId in state.statuses)) return state;
        const { [paneId]: _, ...rest } = state.statuses;
        return { statuses: rest };
      }),

    prune: (activePaneIds) =>
      set((state) => {
        const allowed = new Set(activePaneIds);
        const currentKeys = Object.keys(state.statuses);
        if (currentKeys.every((id) => allowed.has(id))) return state;
        const next = Object.fromEntries(
          Object.entries(state.statuses).filter(([id]) => allowed.has(id)),
        );
        return { statuses: next };
      }),
  }),
);
