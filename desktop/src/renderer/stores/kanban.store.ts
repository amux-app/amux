import { create } from 'zustand';
import type { BacklogItem, DoneItem } from '../../shared/kanban-types';
import * as kanbanApi from '../api/kanban.api';

interface KanbanState {
  backlog: BacklogItem[];
  done: DoneItem[];
  loaded: boolean;
  loadedProjectRoot: string | null;
}

interface KanbanActions {
  load: (projectRoot: string) => Promise<void>;
  addBacklogItems: (projectRoot: string, items: Omit<BacklogItem, 'id' | 'createdAt' | 'order'>[]) => Promise<BacklogItem[]>;
  removeBacklogItems: (projectRoot: string, itemIds: string[]) => Promise<void>;
  updateBacklogItem: (projectRoot: string, itemId: string, updates: Partial<Pick<BacklogItem, 'title' | 'prompt' | 'complexity' | 'agent' | 'useWorktree' | 'projectRoot' | 'order'>>) => Promise<void>;
  reorderBacklog: (projectRoot: string, orderedIds: string[]) => Promise<void>;
  addDoneItem: (projectRoot: string, item: Omit<DoneItem, 'id' | 'mergedAt'>) => Promise<void>;
  clearDone: (projectRoot: string) => Promise<void>;
  batchLaunch: (projectRoot: string, itemIds: string[]) => Promise<{ launched: number; errors: string[]; launchedPaneIds: string[] }>;
  refresh: (projectRoot: string) => Promise<void>;
}

export const useKanbanStore = create<KanbanState & KanbanActions>((set, get) => ({
  backlog: [],
  done: [],
  loaded: false,
  loadedProjectRoot: null,

  load: async (projectRoot) => {
    const data = await kanbanApi.getKanban({ projectRoot });
    set({ backlog: data.backlog, done: data.done, loaded: true, loadedProjectRoot: projectRoot });
  },

  refresh: async (projectRoot) => {
    await get().load(projectRoot);
  },

  addBacklogItems: async (projectRoot, items) => {
    const result = await kanbanApi.addBacklogItems({ projectRoot, items });
    if (result.success) {
      const data = await kanbanApi.getKanban({ projectRoot });
      set({ backlog: data.backlog });
    }
    return result.items;
  },

  removeBacklogItems: async (projectRoot, itemIds) => {
    await kanbanApi.removeBacklogItems({ projectRoot, itemIds });
    const data = await kanbanApi.getKanban({ projectRoot });
    set({ backlog: data.backlog });
  },

  updateBacklogItem: async (projectRoot, itemId, updates) => {
    await kanbanApi.updateBacklogItem({ projectRoot, itemId, updates });
    const data = await kanbanApi.getKanban({ projectRoot });
    set({ backlog: data.backlog });
  },

  reorderBacklog: async (projectRoot, orderedIds) => {
    await kanbanApi.reorderBacklog({ projectRoot, orderedIds });
    const data = await kanbanApi.getKanban({ projectRoot });
    set({ backlog: data.backlog });
  },

  addDoneItem: async (projectRoot, item) => {
    await kanbanApi.addDoneItem({ projectRoot, item });
    const data = await kanbanApi.getKanban({ projectRoot });
    set({ done: data.done });
  },

  clearDone: async (projectRoot) => {
    await kanbanApi.clearDone({ projectRoot });
    set({ done: [] });
  },

  batchLaunch: async (projectRoot, itemIds) => {
    const result = await kanbanApi.batchLaunch({ projectRoot, itemIds });
    const data = await kanbanApi.getKanban({ projectRoot });
    set({ backlog: data.backlog, done: data.done, loaded: true, loadedProjectRoot: projectRoot });
    return {
      launched: result.launched,
      errors: result.errors,
      launchedPaneIds: result.launchedPaneIds ?? [],
    };
  },
}));
