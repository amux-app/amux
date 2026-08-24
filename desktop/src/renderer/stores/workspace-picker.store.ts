import { create } from 'zustand';
import type { ProjectInfo, WorkspaceHistoryEntry } from '../../shared/ipc-types';
import * as projectApi from '../api/project.api';
import * as workspaceApi from '../api/workspace.api';

export interface MergedProject {
  name: string;
  root: string;
  lastOpened: number;
  paneCount: number;
  isActive: boolean;
  sessionName?: string;
}

interface WorkspacePickerState {
  isOpen: boolean;
  search: string;
  selectedIndex: number;
  historyEntries: WorkspaceHistoryEntry[];
  activeProjects: ProjectInfo[];
  isLoading: boolean;
  deletingRoot: string | null;
}

interface WorkspacePickerActions {
  open: () => void;
  close: () => void;
  setSearch: (search: string) => void;
  setSelectedIndex: (index: number) => void;
  moveSelection: (delta: number) => void;
  load: () => Promise<void>;
  getFilteredProjects: () => MergedProject[];
  removeProject: (root: string) => Promise<void>;
}

function filterProjects(projects: MergedProject[], search: string): MergedProject[] {
  if (!search) return projects;
  const lower = search.toLowerCase();
  return projects.filter(
    (project) => project.name.toLowerCase().includes(lower) || project.root.toLowerCase().includes(lower),
  );
}

function clampSelectedIndex(selectedIndex: number, projectCount: number): number {
  return projectCount === 0 ? 0 : Math.min(selectedIndex, projectCount - 1);
}

function mergeProjects(
  history: WorkspaceHistoryEntry[],
  active: ProjectInfo[],
): MergedProject[] {
  const merged = new Map<string, MergedProject>();

  for (const entry of history) {
    merged.set(entry.root, {
      name: entry.name,
      root: entry.root,
      lastOpened: entry.lastOpened,
      paneCount: entry.paneCount,
      isActive: false,
    });
  }

  for (const project of active) {
    const existing = merged.get(project.root);
    if (!existing) {
      continue;
    }

    merged.set(project.root, {
      ...existing,
      isActive: true,
      name: project.name || existing.name,
      paneCount: project.paneCount,
      sessionName: project.sessionName,
    });
  }

  return Array.from(merged.values()).sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return b.lastOpened - a.lastOpened;
  });
}

export function selectFilteredProjects(
  state: Pick<WorkspacePickerState, 'activeProjects' | 'historyEntries' | 'search'>,
): MergedProject[] {
  return filterProjects(mergeProjects(state.historyEntries, state.activeProjects), state.search);
}

export const useWorkspacePickerStore = create<WorkspacePickerState & WorkspacePickerActions>(
  (set, get) => ({
    isOpen: false,
    search: '',
    selectedIndex: 0,
    historyEntries: [],
    activeProjects: [],
    isLoading: false,
    deletingRoot: null,

    open: () => {
      set({ isOpen: true, search: '', selectedIndex: 0, deletingRoot: null });
      get().load();
    },

    close: () => set({ isOpen: false, search: '', selectedIndex: 0, deletingRoot: null }),

    setSearch: (search) => set({ search, selectedIndex: 0 }),

    setSelectedIndex: (index) => set({ selectedIndex: index }),

    moveSelection: (delta) => {
      const projects = get().getFilteredProjects();
      if (projects.length === 0) return;
      set((s) => {
        const next = s.selectedIndex + delta;
        const clamped = Math.max(0, Math.min(next, projects.length - 1));
        return { selectedIndex: clamped };
      });
    },

    load: async () => {
      set({ isLoading: true });
      try {
        const [history, active] = await Promise.all([
          workspaceApi.listHistory(),
          projectApi.listProjects(),
        ]);
        set({
          historyEntries: Array.isArray(history) ? history : [],
          activeProjects: Array.isArray(active) ? active : [],
          isLoading: false,
        });
      } catch {
        set({ isLoading: false });
      }
    },

    getFilteredProjects: () => {
      return selectFilteredProjects(get());
    },

    removeProject: async (root: string) => {
      set({ deletingRoot: root });

      try {
        const historyEntries = await workspaceApi.removeHistory({ root });
        set((state) => {
          const nextHistoryEntries = Array.isArray(historyEntries)
            ? historyEntries
            : state.historyEntries.filter((entry) => entry.root !== root);
          const nextProjects = filterProjects(
            mergeProjects(nextHistoryEntries, state.activeProjects),
            state.search,
          );

          return {
            deletingRoot: null,
            historyEntries: nextHistoryEntries,
            selectedIndex: clampSelectedIndex(state.selectedIndex, nextProjects.length),
          };
        });
      } catch {
        set({ deletingRoot: null });
        await get().load();
      }
    },
  }),
);
