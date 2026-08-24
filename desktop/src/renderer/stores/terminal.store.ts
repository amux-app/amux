import { create } from 'zustand';

interface TerminalState {
  attachedPaneIds: Set<string>;
  seenPaneIds: Set<string>;
}

interface TerminalActions {
  attachPane: (paneId: string) => void;
  markPaneSeen: (paneId: string) => void;
  detachPane: (paneId: string) => void;
  detachAll: () => void;
}

export const useTerminalStore = create<TerminalState & TerminalActions>((set) => ({
  attachedPaneIds: new Set(),
  seenPaneIds: new Set(),

  attachPane: (paneId) =>
    set((s) => {
      if (s.attachedPaneIds.has(paneId)) return s;
      const next = new Set(s.attachedPaneIds);
      next.add(paneId);
      return { attachedPaneIds: next };
    }),

  markPaneSeen: (paneId) =>
    set((s) => {
      if (s.seenPaneIds.has(paneId)) return s;
      const seen = new Set(s.seenPaneIds);
      seen.add(paneId);
      return { seenPaneIds: seen };
    }),

  detachPane: (paneId) =>
    set((s) => {
      if (!s.attachedPaneIds.has(paneId)) return s;
      const next = new Set(s.attachedPaneIds);
      next.delete(paneId);
      return { attachedPaneIds: next };
    }),

  detachAll: () => set({ attachedPaneIds: new Set() }),
}));
