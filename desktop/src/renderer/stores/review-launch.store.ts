import { create } from 'zustand';

interface ReviewLaunchState {
  launchingIds: Set<string>;
  setLaunching: (paneId: string, value: boolean) => void;
}

export const useReviewLaunchStore = create<ReviewLaunchState>((set) => ({
  launchingIds: new Set(),
  setLaunching: (paneId, value) =>
    set((state) => {
      const next = new Set(state.launchingIds);
      if (value) next.add(paneId);
      else next.delete(paneId);
      return { launchingIds: next };
    }),
}));
