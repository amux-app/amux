import { create } from 'zustand';
import type { PaneTopics } from '../../shared/topic-types';

interface TopicsState {
  topicsByPane: Record<string, PaneTopics>;
}

interface TopicsActions {
  setAll: (list: PaneTopics[]) => void;
  upsert: (paneTopics: PaneTopics) => void;
  remove: (paneId: string) => void;
}

export const useTopicsStore = create<TopicsState & TopicsActions>((set) => ({
  topicsByPane: {},

  setAll: (list) =>
    set({ topicsByPane: Object.fromEntries(list.map((entry) => [entry.paneId, entry])) }),

  upsert: (paneTopics) =>
    set((state) => ({
      topicsByPane: { ...state.topicsByPane, [paneTopics.paneId]: paneTopics },
    })),

  remove: (paneId) =>
    set((state) => {
      const { [paneId]: _removed, ...rest } = state.topicsByPane;
      return { topicsByPane: rest };
    }),
}));
