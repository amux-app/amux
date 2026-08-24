import { create } from 'zustand';

interface DirtyMapState {
  dirtyMap: Record<string, boolean>;
  setDirty: (paneId: string, dirty: boolean) => void;
  prune: (paneIds: string[]) => void;
  clear: () => void;
}

export const useDirtyMapStore = create<DirtyMapState>((set) => ({
  dirtyMap: {},
  setDirty: (paneId, dirty) =>
    set((state) => {
      if (state.dirtyMap[paneId] === dirty) return state;
      return { dirtyMap: { ...state.dirtyMap, [paneId]: dirty } };
    }),
  prune: (paneIds) =>
    set((state) => {
      const allowed = new Set(paneIds);
      const currentKeys = Object.keys(state.dirtyMap);
      if (currentKeys.every((paneId) => allowed.has(paneId))) return state;
      const nextEntries = Object.entries(state.dirtyMap).filter(([paneId]) => allowed.has(paneId));
      return { dirtyMap: Object.fromEntries(nextEntries) };
    }),
  clear: () => set({ dirtyMap: {} }),
}));
