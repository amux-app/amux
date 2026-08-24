import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspacePickerStore } from '../../src/renderer/stores/workspace-picker.store';
import type { ProjectInfo, WorkspaceHistoryEntry } from '../../src/shared/ipc-types';

const workspaceApi = vi.hoisted(() => ({
  listHistory: vi.fn(),
  removeHistory: vi.fn(),
}));

const projectApi = vi.hoisted(() => ({
  listProjects: vi.fn(),
}));

vi.mock('../../src/renderer/api/workspace.api', () => workspaceApi);
vi.mock('../../src/renderer/api/project.api', () => projectApi);

describe('workspace picker store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspacePickerStore.setState({
      activeProjects: [],
      deletingRoot: null,
      historyEntries: [],
      isLoading: false,
      isOpen: false,
      search: '',
      selectedIndex: 0,
    });
  });

  it('does not show active tmux projects that are not in workspace history', () => {
    // Arrange
    const historyEntries: WorkspaceHistoryEntry[] = [
      {
        lastOpened: 200,
        name: 'example-rag',
        paneCount: 3,
        root: '/Users/me/projects/example-rag',
      },
    ];
    const activeProjects: ProjectInfo[] = [
      {
        configPath: '/private/var/folders/T/aumx-kanban-e2e/.aumx/aumx.config.json',
        name: 'aumx-kanban-e2e',
        paneCount: 0,
        root: '/private/var/folders/T/aumx-kanban-e2e',
        sessionName: 'aumx-aumx-kanban-e2e',
      },
      {
        configPath: '/Users/me/projects/example-rag/.aumx/aumx.config.json',
        name: 'example-rag',
        paneCount: 4,
        root: '/Users/me/projects/example-rag',
        sessionName: 'aumx-example-rag',
      },
    ];

    // Act
    useWorkspacePickerStore.setState({ activeProjects, historyEntries });
    const projects = useWorkspacePickerStore.getState().getFilteredProjects();

    // Assert
    expect(projects).toEqual([
      {
        isActive: true,
        lastOpened: 200,
        name: 'example-rag',
        paneCount: 4,
        root: '/Users/me/projects/example-rag',
        sessionName: 'aumx-example-rag',
      },
    ]);
  });

  it('keeps deleted active projects hidden after removing them from history', async () => {
    // Arrange
    const removedRoot = '/private/var/folders/T/aumx-file-browser-e2e';
    const remainingEntry: WorkspaceHistoryEntry = {
      lastOpened: 200,
      name: 'example-rag',
      paneCount: 3,
      root: '/Users/me/projects/example-rag',
    };
    const historyEntries: WorkspaceHistoryEntry[] = [
      {
        lastOpened: 300,
        name: 'aumx-file-browser-e2e',
        paneCount: 0,
        root: removedRoot,
      },
      remainingEntry,
    ];
    const activeProjects: ProjectInfo[] = [
      {
        configPath: `${removedRoot}/.aumx/aumx.config.json`,
        name: 'aumx-file-browser-e2e',
        paneCount: 0,
        root: removedRoot,
        sessionName: 'aumx-aumx-file-browser-e2e',
      },
    ];
    workspaceApi.removeHistory.mockResolvedValue([remainingEntry]);
    useWorkspacePickerStore.setState({
      activeProjects,
      historyEntries,
      selectedIndex: 1,
    });

    // Act
    await useWorkspacePickerStore.getState().removeProject(removedRoot);
    const projects = useWorkspacePickerStore.getState().getFilteredProjects();

    // Assert
    expect(workspaceApi.removeHistory).toHaveBeenCalledWith({ root: removedRoot });
    expect(projects.map((project) => project.root)).toEqual([remainingEntry.root]);
    expect(useWorkspacePickerStore.getState().deletingRoot).toBeNull();
    expect(useWorkspacePickerStore.getState().selectedIndex).toBe(0);
  });
});
