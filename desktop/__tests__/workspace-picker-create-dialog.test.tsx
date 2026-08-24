// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreatePaneDialog } from '../src/renderer/components/create/CreatePaneDialog';
import { WorkspacePicker } from '../src/renderer/components/workspace-picker/WorkspacePicker';
import {
  useNotificationStore,
  usePaneStore,
  useProjectStore,
  useWorkspacePickerStore,
} from '../src/renderer/stores';
import { useTaskDefaultsStore } from '../src/renderer/stores/task-defaults.store';
import { IPC } from '../src/shared/ipc-channels';
import { invoke } from '../src/renderer/api/ipc';
import * as paneApi from '../src/renderer/api/pane.api';
import * as projectApi from '../src/renderer/api/project.api';
import * as workspaceApi from '../src/renderer/api/workspace.api';

const paneActions = vi.hoisted(() => ({
  createPane: vi.fn(),
}));

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    span: ({ children, layoutId: _layoutId, ...props }: React.HTMLAttributes<HTMLSpanElement> & { layoutId?: string }) => <span {...props}>{children}</span>,
  },
}));

vi.mock('../src/renderer/api/workspace.api', () => ({
  createProjectDialog: vi.fn(),
  createSession: vi.fn(),
  listHistory: vi.fn(),
  openFolderDialog: vi.fn(),
  removeHistory: vi.fn(),
  touchHistory: vi.fn(),
}));

vi.mock('../src/renderer/api/project.api', () => ({
  getSessionInfo: vi.fn(),
  listProjects: vi.fn(),
  switchProject: vi.fn(),
}));

vi.mock('../src/renderer/api/pane.api', () => ({
  listPanes: vi.fn(),
  listPaneSessions: vi.fn(async () => ({ sessions: [] })),
}));

vi.mock('../src/renderer/api/ipc', () => ({
  invoke: vi.fn(async () => ['claude']),
}));

vi.mock('../src/renderer/api/settings.api', () => ({
  getSettings: vi.fn(async () => ({
    permissionMode: 'auto',
    useWorktree: false,
  })),
}));

vi.mock('../src/renderer/hooks/usePaneActions', () => ({
  usePaneActions: () => ({
    createPane: paneActions.createPane,
  }),
}));

describe('WorkspacePicker new project flow', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockResolvedValue(['claude']);
    useNotificationStore.setState({ toasts: [] });
    usePaneStore.setState({
      isCreating: false,
      loaded: true,
      panes: [],
      pendingPane: null,
      selectedPaneId: null,
    });
    useProjectStore.setState({
      activeProject: null,
      projectSwitching: false,
      projects: [],
      sessionName: '',
      sessionProjectName: '',
      sessionProjectRoot: '',
    });
    useWorkspacePickerStore.setState({
      activeProjects: [],
      deletingRoot: null,
      historyEntries: [],
      isLoading: false,
      isOpen: true,
      search: '',
      selectedIndex: 0,
    });
    useTaskDefaultsStore.setState({ lastTaskProjectRoot: undefined });
    vi.mocked(paneApi.listPanes).mockResolvedValue([]);
    paneActions.createPane.mockResolvedValue({
      pane: {
        id: 'new-pane',
        paneId: '%2',
        prompt: '',
        slug: 'new-pane',
      },
      success: true,
    });
  });

  it('activates a selected workspace before launching the first pane', async () => {
    // Arrange — this is the packaged-app startup state from the incident log:
    // projects are discoverable, but no project session is active.
    const project = {
      configPath: '/Users/me/projects/example-rag/.aumx/aumx.config.json',
      name: 'example-rag',
      paneCount: 0,
      root: '/Users/me/projects/example-rag',
      sessionName: 'aumx-example-rag',
    };
    let finishSwitch: () => void = () => {};
    vi.mocked(workspaceApi.listHistory).mockResolvedValue([{
      lastOpened: 200,
      name: project.name,
      paneCount: project.paneCount,
      root: project.root,
    }]);
    vi.mocked(projectApi.listProjects).mockResolvedValue([project]);
    vi.mocked(projectApi.switchProject).mockImplementation(
      () => new Promise((resolve) => {
        finishSwitch = () => resolve({ project, success: true });
      }),
    );

    render(<CreatePaneDialog />);
    usePaneStore.getState().setCreating(true);
    await screen.findByRole('dialog', { name: 'New Pane' });
    await screen.findByRole('radio', { name: /claude/i });

    // Act — choose the visible project and launch.
    fireEvent.click(await screen.findByRole('button', { name: /configuration/i }));
    fireEvent.click(screen.getByRole('button', { name: /choose workspace|current project/i }));
    fireEvent.click(await screen.findByRole('button', { name: /example-rag/i }));
    const launch = screen.getByRole('button', { name: /launch/i }) as HTMLButtonElement;
    await waitFor(() => expect(launch.disabled).toBe(false));
    fireEvent.click(launch);

    // Assert — creation cannot overtake project activation.
    await waitFor(() => {
      expect(projectApi.switchProject).toHaveBeenCalledWith({ projectRoot: project.root });
    });
    expect(paneActions.createPane).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projectSwitching).toBe(true);

    finishSwitch();
    await waitFor(() => {
      expect(paneActions.createPane).toHaveBeenCalledWith(
        expect.objectContaining({ projectRoot: project.root }),
      );
    });
    expect(projectApi.switchProject.mock.invocationCallOrder[0])
      .toBeLessThan(paneActions.createPane.mock.invocationCallOrder[0]);
  });

  it('uses a browsed folder as the workspace for the first pane', async () => {
    // Arrange
    const project = {
      configPath: '/Users/me/projects/from-folder/.aumx/aumx.config.json',
      name: 'from-folder',
      paneCount: 0,
      root: '/Users/me/projects/from-folder',
      sessionName: 'aumx-from-folder',
    };
    vi.mocked(workspaceApi.listHistory).mockResolvedValue([]);
    vi.mocked(workspaceApi.openFolderDialog).mockResolvedValue({
      canceled: false,
      path: project.root,
    });
    vi.mocked(projectApi.listProjects).mockResolvedValue([]);
    vi.mocked(projectApi.switchProject).mockResolvedValue({ project, success: true });

    render(<CreatePaneDialog />);
    usePaneStore.getState().setCreating(true);
    await screen.findByRole('dialog', { name: 'New Pane' });
    await screen.findByRole('radio', { name: /claude/i });

    // Act
    fireEvent.click(await screen.findByRole('button', { name: /configuration/i }));
    fireEvent.click(screen.getByRole('button', { name: /browse folder/i }));
    await waitFor(() => expect(screen.getByText(project.root)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    // Assert
    await waitFor(() => {
      expect(projectApi.switchProject).toHaveBeenCalledWith({ projectRoot: project.root });
      expect(paneActions.createPane).toHaveBeenCalledWith(
        expect.objectContaining({ projectRoot: project.root }),
      );
    });
  });

  it('requires a workspace before enabling first-pane launch controls', async () => {
    // Arrange
    vi.mocked(workspaceApi.listHistory).mockResolvedValue([]);
    vi.mocked(projectApi.listProjects).mockResolvedValue([]);

    // Act
    render(<CreatePaneDialog />);
    usePaneStore.getState().setCreating(true);
    await screen.findByRole('dialog', { name: 'New Pane' });
    await screen.findByRole('radio', { name: /claude/i });

    // Assert
    fireEvent.click(await screen.findByRole('button', { name: /configuration/i }));
    expect(screen.getByText(/choose a workspace folder to launch an agent/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: /launch/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /terminal/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps workspace selection available for a terminal-only launch when no agents are installed', async () => {
    const projectRoot = '/Users/me/projects/shell-only';
    vi.mocked(invoke).mockImplementation(async (channel: string) => {
      if (channel === IPC.AGENT_LIST || channel === IPC.AGENT_REFRESH) return [];
      if (channel === IPC.AGENT_DEFAULTS_GET) return { claude: {}, codex: {}, opencode: {}, pi: {} };
      return [];
    });
    vi.mocked(workspaceApi.listHistory).mockResolvedValue([]);
    vi.mocked(workspaceApi.openFolderDialog).mockResolvedValue({ canceled: false, path: projectRoot });
    vi.mocked(projectApi.listProjects).mockResolvedValue([]);

    render(<CreatePaneDialog />);
    usePaneStore.getState().setCreating(true);
    await screen.findByRole('dialog', { name: 'New Pane' });

    fireEvent.click(screen.getByRole('button', { name: /browse folder/i }));
    await waitFor(() => expect(screen.getByText(projectRoot)).toBeTruthy());

    expect((screen.getByRole('button', { name: /terminal/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the dialog open when pane creation fails', async () => {
    // Arrange
    const project = {
      configPath: '/Users/me/projects/app/.aumx/aumx.config.json',
      name: 'app',
      paneCount: 0,
      root: '/Users/me/projects/app',
      sessionName: 'aumx-app',
    };
    useProjectStore.setState({
      activeProject: project,
      sessionName: project.sessionName,
      sessionProjectName: project.name,
      sessionProjectRoot: project.root,
    });
    paneActions.createPane.mockResolvedValueOnce({
      error: 'tmux session unavailable',
      success: false,
    });

    render(<CreatePaneDialog />);
    usePaneStore.getState().setCreating(true);
    await screen.findByRole('dialog', { name: 'New Pane' });
    await screen.findByRole('radio', { name: /claude/i });

    // Act
    const launch = screen.getByRole('button', { name: /launch pane/i }) as HTMLButtonElement;
    await waitFor(() => expect(launch.disabled).toBe(false));
    fireEvent.click(launch);

    // Assert
    await waitFor(() => expect(paneActions.createPane).toHaveBeenCalled());
    expect(screen.getByRole('dialog', { name: 'New Pane' })).toBeTruthy();
  });

  it('keeps the dialog open with one actionable error when workspace activation fails', async () => {
    // Arrange
    const project = {
      configPath: '/Users/me/projects/unavailable/.aumx/aumx.config.json',
      name: 'unavailable',
      paneCount: 0,
      root: '/Users/me/projects/unavailable',
      sessionName: 'aumx-unavailable',
    };
    vi.mocked(workspaceApi.listHistory).mockResolvedValue([{
      lastOpened: 200,
      name: project.name,
      paneCount: project.paneCount,
      root: project.root,
    }]);
    vi.mocked(projectApi.listProjects).mockResolvedValue([project]);
    vi.mocked(projectApi.switchProject).mockResolvedValue({ error: 'Folder is unavailable' });

    render(<CreatePaneDialog />);
    usePaneStore.getState().setCreating(true);
    await screen.findByRole('dialog', { name: 'New Pane' });
    await screen.findByRole('radio', { name: /claude/i });
    fireEvent.click(await screen.findByRole('button', { name: /configuration/i }));
    fireEvent.click(screen.getByRole('button', { name: /choose workspace/i }));
    fireEvent.click(await screen.findByRole('button', { name: /unavailable/i }));

    // Act
    fireEvent.click(screen.getByRole('button', { name: /open workspace & launch/i }));

    // Assert
    await waitFor(() => {
      expect(useNotificationStore.getState().toasts).toHaveLength(1);
    });
    expect(paneActions.createPane).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'New Pane' })).toBeTruthy();
    expect(useNotificationStore.getState().toasts[0]).toMatchObject({
      severity: 'error',
      title: 'Workspace not ready',
    });
  });

  it('stops the workspace-picker flow and reports a rejected project switch', async () => {
    const project = {
      configPath: '/Users/me/projects/current/.amux/aumx.config.json',
      name: 'current',
      paneCount: 0,
      root: '/Users/me/projects/current',
      sessionName: 'aumx-current',
    };
    useWorkspacePickerStore.setState({
      activeProjects: [project],
      historyEntries: [{
        lastOpened: Date.now(),
        name: project.name,
        paneCount: project.paneCount,
        root: project.root,
      }],
    });
    vi.mocked(workspaceApi.touchHistory).mockResolvedValue([]);
    vi.mocked(projectApi.switchProject).mockResolvedValue({
      error: 'Resolve or abort the active conflict merge before switching projects.',
    });

    render(<WorkspacePicker />);
    fireEvent.click(screen.getByText(project.name));

    await waitFor(() => {
      expect(useNotificationStore.getState().toasts).toHaveLength(1);
    });
    expect(useNotificationStore.getState().toasts[0]).toMatchObject({
      message: 'Resolve or abort the active conflict merge before switching projects.',
      severity: 'error',
    });
    expect(paneApi.listPanes).not.toHaveBeenCalled();
    expect(usePaneStore.getState().isCreating).toBe(false);
    expect(useProjectStore.getState().projectSwitching).toBe(false);
  });

  it('waits for the project switch before opening the create pane dialog', async () => {
    // Arrange
    let finishSwitch: () => void = () => {};
    vi.mocked(workspaceApi.createProjectDialog).mockResolvedValue({
      canceled: false,
      path: '/Users/me/projects/example-rag',
    });
    vi.mocked(workspaceApi.createSession).mockResolvedValue({
      success: true,
      project: {
        configPath: '/Users/me/projects/example-rag/.aumx/aumx.config.json',
        name: 'example-rag',
        paneCount: 0,
        root: '/Users/me/projects/example-rag',
        sessionName: 'aumx-example-rag',
      },
    });
    vi.mocked(workspaceApi.touchHistory).mockResolvedValue([]);
    vi.mocked(projectApi.switchProject).mockImplementation(
      () => new Promise((resolve) => {
        finishSwitch = () => resolve({
          success: true,
          project: {
            configPath: '/Users/me/projects/example-rag/.aumx/aumx.config.json',
            name: 'example-rag',
            paneCount: 0,
            root: '/Users/me/projects/example-rag',
            sessionName: 'aumx-example-rag',
          },
        });
      }),
    );
    vi.mocked(projectApi.listProjects).mockResolvedValue([]);

    // Act
    render(<WorkspacePicker />);
    fireEvent.click(screen.getByRole('button', { name: /new project/i }));

    // Assert
    await waitFor(() => expect(projectApi.switchProject).toHaveBeenCalled());
    expect(useProjectStore.getState().projectSwitching).toBe(true);
    expect(usePaneStore.getState().isCreating).toBe(false);

    finishSwitch();
    await waitFor(() => {
      expect(useProjectStore.getState().projectSwitching).toBe(false);
    });
    await waitFor(() => {
      expect(usePaneStore.getState().isCreating).toBe(true);
    });
  });

  it('opens a selected new-project folder as fresh even when it has saved panes', async () => {
    // Arrange
    vi.mocked(workspaceApi.createProjectDialog).mockResolvedValue({
      canceled: false,
      path: '/Users/me/projects/existing-app',
    });
    vi.mocked(workspaceApi.createSession).mockResolvedValue({
      success: true,
      project: {
        configPath: '/Users/me/projects/existing-app/.aumx/aumx.config.json',
        name: 'existing-app',
        paneCount: 4,
        root: '/Users/me/projects/existing-app',
        sessionName: 'aumx-existing-app',
      },
    });
    vi.mocked(workspaceApi.touchHistory).mockResolvedValue([]);
    vi.mocked(projectApi.switchProject).mockResolvedValue({
      success: true,
      project: {
        configPath: '/Users/me/projects/existing-app/.aumx/aumx.config.json',
        name: 'existing-app',
        paneCount: 0,
        root: '/Users/me/projects/existing-app',
        sessionName: 'aumx-existing-app',
      },
    });
    vi.mocked(projectApi.listProjects).mockResolvedValue([]);
    vi.mocked(paneApi.listPanes).mockResolvedValue([]);

    // Act
    render(<WorkspacePicker />);
    fireEvent.click(screen.getByRole('button', { name: /new project/i }));

    // Assert
    await waitFor(() => {
      expect(projectApi.switchProject).toHaveBeenCalledWith({
        fresh: true,
        projectRoot: '/Users/me/projects/existing-app',
      });
    });
    await waitFor(() => {
      expect(usePaneStore.getState().isCreating).toBe(true);
    });
  });

  it('opens a folder normally so existing panes can be resumed', async () => {
    // Arrange
    vi.mocked(workspaceApi.openFolderDialog).mockResolvedValue({
      canceled: false,
      path: '/Users/me/projects/existing-app',
    });
    vi.mocked(workspaceApi.createSession).mockResolvedValue({
      success: true,
      project: {
        configPath: '/Users/me/projects/existing-app/.aumx/aumx.config.json',
        name: 'existing-app',
        paneCount: 2,
        root: '/Users/me/projects/existing-app',
        sessionName: 'aumx-existing-app',
      },
    });
    vi.mocked(workspaceApi.touchHistory).mockResolvedValue([]);
    vi.mocked(projectApi.switchProject).mockResolvedValue({
      success: true,
      project: {
        configPath: '/Users/me/projects/existing-app/.aumx/aumx.config.json',
        name: 'existing-app',
        paneCount: 2,
        root: '/Users/me/projects/existing-app',
        sessionName: 'aumx-existing-app',
      },
    });
    vi.mocked(projectApi.listProjects).mockResolvedValue([]);
    vi.mocked(paneApi.listPanes).mockResolvedValue([{
      agentStatus: 'idle',
      id: 'old-pane',
      paneId: '%1',
      prompt: 'old work',
      slug: 'old-pane',
    } as AumxPane]);

    // Act
    render(<WorkspacePicker />);
    fireEvent.click(screen.getByRole('button', { name: /open folder/i }));

    // Assert
    await waitFor(() => {
      expect(projectApi.switchProject).toHaveBeenCalledWith({
        projectRoot: '/Users/me/projects/existing-app',
      });
    });
    await waitFor(() => {
      expect(usePaneStore.getState().panes).toHaveLength(1);
    });
    expect(usePaneStore.getState().isCreating).toBe(false);
  });

  it('waits for session creation before opening the create pane dialog', async () => {
    // Arrange
    let finishSession: () => void = () => {};
    vi.mocked(workspaceApi.createProjectDialog).mockResolvedValue({
      canceled: false,
      path: '/Users/me/projects/example-rag',
    });
    vi.mocked(workspaceApi.createSession).mockImplementation(
      () => new Promise((resolve) => {
        finishSession = () => resolve({
          success: true,
          project: {
            configPath: '/Users/me/projects/example-rag/.aumx/aumx.config.json',
            name: 'example-rag',
            paneCount: 0,
            root: '/Users/me/projects/example-rag',
            sessionName: 'aumx-example-rag',
          },
        });
      }),
    );
    vi.mocked(workspaceApi.touchHistory).mockResolvedValue([]);
    vi.mocked(projectApi.switchProject).mockResolvedValue({
      success: true,
      project: {
        configPath: '/Users/me/projects/example-rag/.aumx/aumx.config.json',
        name: 'example-rag',
        paneCount: 0,
        root: '/Users/me/projects/example-rag',
        sessionName: 'aumx-example-rag',
      },
    });
    vi.mocked(projectApi.listProjects).mockResolvedValue([]);

    // Act
    render(<WorkspacePicker />);
    fireEvent.click(screen.getByRole('button', { name: /new project/i }));

    // Assert
    await waitFor(() => expect(workspaceApi.createSession).toHaveBeenCalled());
    expect(useProjectStore.getState().projectSwitching).toBe(true);
    expect(usePaneStore.getState().isCreating).toBe(false);
    expect(projectApi.switchProject).not.toHaveBeenCalled();

    finishSession();
    await waitFor(() => {
      expect(useProjectStore.getState().projectSwitching).toBe(false);
    });
    await waitFor(() => {
      expect(usePaneStore.getState().isCreating).toBe(true);
    });
  });

  it('renders the create dialog above the handoff layer after the project is ready', async () => {
    // Arrange
    vi.mocked(workspaceApi.createProjectDialog).mockResolvedValue({
      canceled: false,
      path: '/Users/me/projects/example-rag',
    });
    vi.mocked(workspaceApi.createSession).mockImplementation(
      async () => ({
        success: true,
        project: {
          configPath: '/Users/me/projects/example-rag/.aumx/aumx.config.json',
          name: 'example-rag',
          paneCount: 0,
          root: '/Users/me/projects/example-rag',
          sessionName: 'aumx-example-rag',
        },
      }),
    );
    vi.mocked(workspaceApi.touchHistory).mockResolvedValue([]);
    vi.mocked(projectApi.switchProject).mockResolvedValue({
      success: true,
      project: {
        configPath: '/Users/me/projects/example-rag/.aumx/aumx.config.json',
        name: 'example-rag',
        paneCount: 0,
        root: '/Users/me/projects/example-rag',
        sessionName: 'aumx-example-rag',
      },
    });
    vi.mocked(projectApi.listProjects).mockResolvedValue([]);

    // Act
    render(
      <>
        <WorkspacePicker />
        <CreatePaneDialog />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: /new project/i }));

    // Assert
    const dialog = await screen.findByRole('dialog');
    const backdrop = dialog.closest('.fixed');
    expect(backdrop?.className).toContain('z-[70]');
  });
});
