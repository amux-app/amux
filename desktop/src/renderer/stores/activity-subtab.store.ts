import { create } from 'zustand';

export type ActivitySubTab = 'conversation' | 'prompts' | 'recaps' | 'timeline';

interface ActivitySubTabState {
  /** Per-pane sub-tab selection inside the Activity panel. */
  byPane: Record<string, ActivitySubTab>;
  setSubTab: (paneId: string, subTab: ActivitySubTab) => void;
  getSubTab: (paneId: string) => ActivitySubTab;
}

export const useActivitySubTabStore = create<ActivitySubTabState>((set, get) => ({
  byPane: {},
  setSubTab: (paneId, subTab) =>
    set((s) => ({ byPane: { ...s.byPane, [paneId]: subTab } })),
  getSubTab: (paneId) => get().byPane[paneId] ?? 'conversation',
}));
