import { create } from 'zustand';
import type { ProjectInfo } from '../../shared/ipc-types';
import * as projectApi from '../api/project.api';

interface ProjectState {
  projects: ProjectInfo[];
  activeProject: ProjectInfo | null;
  sessionName: string;
  sessionProjectRoot: string;
  sessionProjectName: string;
  homeDir: string;
  projectSwitching: boolean;
}

interface ProjectActions {
  setProjects: (projects: ProjectInfo[]) => void;
  setActiveProject: (project: ProjectInfo | null) => void;
  setProjectSwitching: (switching: boolean) => void;
  loadProjects: () => Promise<void>;
  loadSessionInfo: () => Promise<void>;
  switchProject: (projectRoot: string, options?: { fresh?: boolean }) => Promise<void>;
}

export const useProjectStore = create<ProjectState & ProjectActions>((set, get) => ({
  projects: [],
  activeProject: null,
  sessionName: '',
  sessionProjectRoot: '',
  sessionProjectName: '',
  homeDir: '',
  projectSwitching: false,

  setProjects: (projects) => set({ projects }),

  setActiveProject: (project) => set({ activeProject: project }),

  setProjectSwitching: (projectSwitching) => set({ projectSwitching }),

  loadProjects: async () => {
    const response = await projectApi.listProjects();
    const projects = Array.isArray(response) ? response : [];
    set((state) => {
      const activeRoot = state.activeProject?.root;
      const byRoot = new Map(projects.map((project) => [project.root, project]));

      let nextActive = activeRoot ? byRoot.get(activeRoot) ?? null : null;
      if (!nextActive && state.sessionProjectRoot) {
        nextActive = byRoot.get(state.sessionProjectRoot) ?? null;
      }
      if (!nextActive && state.activeProject && state.activeProject.root === state.sessionProjectRoot && state.sessionProjectRoot) {
        nextActive = state.activeProject;
      }
      if (!nextActive && projects.length === 1) {
        nextActive = projects[0];
      }

      return { projects, activeProject: nextActive };
    });
  },

  loadSessionInfo: async () => {
    const info = await projectApi.getSessionInfo();
    set((state) => {
      const matchingProject = state.projects.find((project) => project.root === info.projectRoot) ?? null;
      const nextActive =
        matchingProject
        ?? (state.activeProject?.root === info.projectRoot
          ? state.activeProject
          : info.projectRoot
            ? {
                name: info.projectName,
                root: info.projectRoot,
                sessionName: info.sessionName,
                configPath: state.activeProject?.root === info.projectRoot ? state.activeProject.configPath : '',
                paneCount: state.activeProject?.root === info.projectRoot ? state.activeProject.paneCount : 0,
              }
            : null);

      return {
        sessionName: info.sessionName,
        sessionProjectRoot: info.projectRoot,
        sessionProjectName: info.projectName,
        homeDir: info.homeDir,
        activeProject: nextActive,
      };
    });
  },

  switchProject: async (projectRoot, options) => {
    const result = await projectApi.switchProject({
      ...(options?.fresh ? { fresh: true } : {}),
      projectRoot,
    });
    if (!result?.success || !result.project) {
      throw new Error(result?.error ?? 'Failed to switch projects');
    }
    const project = result.project;
    set((state) => {
      const existingWithoutTarget = state.projects.filter((p) => p.root !== project.root);
      return {
        projects: [...existingWithoutTarget, project],
        activeProject: project,
        sessionName: project.sessionName ?? state.sessionName,
        sessionProjectRoot: project.root,
        sessionProjectName: project.name,
      };
    });
    await get().loadProjects();

    // Check connected marketplace sources for newly added items on deliberate project
    // entry (this is only called from the workspace picker / explicit switches, never
    // from the launch-time session restore — so the popup won't appear on app launch).
    // Lazy import avoids a circular dependency between the two stores.
    void import('./marketplace-updates.store').then(({ useMarketplaceUpdatesStore }) => {
      void useMarketplaceUpdatesStore.getState().check();
    });
  },
}));
