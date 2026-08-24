import { create } from 'zustand';

interface WorktreeOverviewState {
  isOpen: boolean;
}

interface WorktreeOverviewActions {
  open: () => void;
  close: () => void;
}

export const useWorktreeOverviewStore = create<WorktreeOverviewState & WorktreeOverviewActions>(
  (set) => ({
    isOpen: false,
    open: () => set({ isOpen: true }),
    close: () => set({ isOpen: false }),
  }),
);
