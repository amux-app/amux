import { create } from 'zustand';

interface ColumnOverrideState {
  overrides: Record<string, string>;
  set: (paneId: string, columnId: string) => void;
  remove: (paneId: string) => void;
  prune: (paneIds: string[]) => void;
}

export const useColumnOverrideStore = create<ColumnOverrideState>((set) => ({
  overrides: {},
  set: (paneId, columnId) =>
    set((state) => {
      if (state.overrides[paneId] === columnId) return state;
      return { overrides: { ...state.overrides, [paneId]: columnId } };
    }),
  remove: (paneId) =>
    set((state) => {
      if (!(paneId in state.overrides)) return state;
      const { [paneId]: _, ...rest } = state.overrides;
      return { overrides: rest };
    }),
  prune: (paneIds) =>
    set((state) => {
      const allowed = new Set(paneIds);
      const currentKeys = Object.keys(state.overrides);
      if (currentKeys.every((id) => allowed.has(id))) return state;
      const next = Object.fromEntries(
        Object.entries(state.overrides).filter(([id]) => allowed.has(id)),
      );
      return { overrides: next };
    }),
}));
