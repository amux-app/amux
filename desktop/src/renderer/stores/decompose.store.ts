import { create } from 'zustand';
import type { DecomposeTask } from '../../shared/kanban-types';
import * as decomposeApi from '../api/decompose.api';

interface DecomposeState {
  isOpen: boolean;
  isLoading: boolean;
  paneId: string | null;
  prompt: string;
  tasks: DecomposeTask[];
  selectedIndices: Set<number>;
  includeDiff: boolean;
  error: string | null;
}

interface DecomposeActions {
  open: (params: { paneId: string; prompt: string; projectRoot: string }) => void;
  close: () => void;
  generate: (projectRoot: string) => Promise<void>;
  toggleTask: (index: number) => void;
  selectAll: () => void;
  deselectAll: () => void;
  setIncludeDiff: (value: boolean) => void;
}

export const useDecomposeStore = create<DecomposeState & DecomposeActions>((set, get) => ({
  isOpen: false,
  isLoading: false,
  paneId: null,
  prompt: '',
  tasks: [],
  selectedIndices: new Set<number>(),
  includeDiff: false,
  error: null,

  open: ({ paneId, prompt, projectRoot }) => {
    set({
      isOpen: true,
      isLoading: true,
      paneId,
      prompt,
      tasks: [],
      selectedIndices: new Set(),
      error: null,
    });
    get().generate(projectRoot);
  },

  close: () => set({
    isOpen: false,
    isLoading: false,
    paneId: null,
    prompt: '',
    tasks: [],
    selectedIndices: new Set(),
    error: null,
  }),

  generate: async (projectRoot) => {
    const { paneId, prompt, includeDiff } = get();
    if (!paneId) return;

    set({ isLoading: true, error: null });
    try {
      const result = await decomposeApi.generateDecomposition({
        projectRoot,
        paneId,
        prompt,
        includeDiff,
      });

      if (result.success) {
        const allIndices = new Set(result.tasks.map((_, i) => i));
        set({ tasks: result.tasks, selectedIndices: allIndices, isLoading: false });
      } else {
        set({ error: result.error ?? 'Failed to decompose', isLoading: false });
      }
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  toggleTask: (index) => set((state) => {
    const next = new Set(state.selectedIndices);
    if (next.has(index)) {
      next.delete(index);
    } else {
      next.add(index);
    }
    return { selectedIndices: next };
  }),

  selectAll: () => set((state) => ({
    selectedIndices: new Set(state.tasks.map((_, i) => i)),
  })),

  deselectAll: () => set({ selectedIndices: new Set() }),

  setIncludeDiff: (value) => set({ includeDiff: value }),
}));
