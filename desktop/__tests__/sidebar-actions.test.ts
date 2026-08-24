// @vitest-environment happy-dom
import type { AumxPane } from 'aumx/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FILE_BROWSER_ACTION_ID,
  MARKETPLACE_ACTION_ID,
  OPEN_PROJECT_ACTION_ID,
  SETTINGS_ACTION_ID,
  SHELL_ACTION_ID,
  TOPICS_ACTION_ID,
  createSidebarActionContext,
  resolveSidebarActions,
} from '../src/renderer/components/layout/sidebarActions';
import { usePaneStore } from '../src/renderer/stores/pane.store';
import { useProjectStore } from '../src/renderer/stores/project.store';
import { useUiStore } from '../src/renderer/stores/ui.store';
import { useWorkspacePickerStore } from '../src/renderer/stores/workspace-picker.store';
import { useWorktreeStatusStore } from '../src/renderer/stores/worktree-status.store';

const paneApi = vi.hoisted(() => ({ createPane: vi.fn() }));

vi.mock('../src/renderer/api/pane.api', () => paneApi);

import { Sidebar } from '../src/renderer/components/layout/Sidebar';

describe('sidebar actions', () => {
  it('keeps rail icons in a single typed registry', () => {
    // Arrange — topics hidden when conversationTopicsEnabled=false
    const context = createSidebarActionContext({
      activeView: 'dashboard',
      conversationTopicsEnabled: false,
      createShellPane: vi.fn(),
      fileBrowserOpen: false,
      openSettings: vi.fn(),
      openWorkspacePicker: vi.fn(),
      settingsCategory: 'appearance',
      setActiveView: vi.fn(),
      toggleFileBrowser: vi.fn(),
    });

    const actions = resolveSidebarActions(context);

    expect(actions.map((action) => action.id)).toEqual([
      SHELL_ACTION_ID,
      FILE_BROWSER_ACTION_ID,
      OPEN_PROJECT_ACTION_ID,
      MARKETPLACE_ACTION_ID,
      SETTINGS_ACTION_ID,
    ]);
    expect(actions.every((action) => action.Icon)).toBe(true);
  });

  it('open-project action delegates to the injected workspace picker', () => {
    // Arrange
    const openWorkspacePicker = vi.fn();
    const context = createSidebarActionContext({
      activeView: 'dashboard',
      conversationTopicsEnabled: false,
      createShellPane: vi.fn(),
      fileBrowserOpen: false,
      openSettings: vi.fn(),
      openWorkspacePicker,
      setActiveView: vi.fn(),
      toggleFileBrowser: vi.fn(),
    });

    // Act
    resolveSidebarActions(context).find((action) => action.id === OPEN_PROJECT_ACTION_ID)?.onSelect();

    // Assert
    expect(openWorkspacePicker).toHaveBeenCalledTimes(1);
  });

  it('shell action delegates to the injected shell-pane command', () => {
    // Arrange
    const createShellPane = vi.fn();
    const context = createSidebarActionContext({
      activeView: 'dashboard',
      conversationTopicsEnabled: false,
      createShellPane,
      fileBrowserOpen: false,
      openSettings: vi.fn(),
      openWorkspacePicker: vi.fn(),
      settingsCategory: 'appearance',
      setActiveView: vi.fn(),
      toggleFileBrowser: vi.fn(),
    });

    // Act
    const shellAction = resolveSidebarActions(context).find((action) => action.id === SHELL_ACTION_ID);
    shellAction?.onSelect();

    // Assert
    expect(shellAction?.testId).toBe('sidebar-shell');
    expect(createShellPane).toHaveBeenCalledOnce();
  });

  it('shows topics action when conversationTopicsEnabled is true', () => {
    const context = createSidebarActionContext({
      activeView: 'dashboard',
      conversationTopicsEnabled: true,
      createShellPane: vi.fn(),
      fileBrowserOpen: false,
      openSettings: vi.fn(),
      openWorkspacePicker: vi.fn(),
      settingsCategory: 'appearance',
      setActiveView: vi.fn(),
      toggleFileBrowser: vi.fn(),
    });

    const actions = resolveSidebarActions(context);
    expect(actions.map((a) => a.id)).toContain(TOPICS_ACTION_ID);
  });

  it('resolves file browser state and toggles through the provided command', () => {
    // Arrange
    const toggleFileBrowser = vi.fn();
    const context = createSidebarActionContext({
      activeView: 'dashboard',
      conversationTopicsEnabled: false,
      createShellPane: vi.fn(),
      fileBrowserOpen: true,
      openSettings: vi.fn(),
      openWorkspacePicker: vi.fn(),
      settingsCategory: 'appearance',
      setActiveView: vi.fn(),
      toggleFileBrowser,
    });

    const fileBrowserAction = resolveSidebarActions(context).find((a) => a.id === FILE_BROWSER_ACTION_ID);
    fileBrowserAction?.onSelect();

    expect(fileBrowserAction?.id).toBe(FILE_BROWSER_ACTION_ID);
    expect(fileBrowserAction?.expandedLabel).toBe('Hide Files');
    expect(fileBrowserAction?.title).toBe('Hide file browser');
    expect(fileBrowserAction?.active).toBe(true);
    expect(fileBrowserAction?.testId).toBe('sidebar-file-browser-toggle');
    expect(toggleFileBrowser).toHaveBeenCalledOnce();
  });

  it('marks exactly one settings row current for the open category', () => {
    // Arrange
    const contextFor = (settingsCategory: 'appearance' | 'marketplace') => createSidebarActionContext({
      activeView: 'settings',
      conversationTopicsEnabled: false,
      createShellPane: vi.fn(),
      fileBrowserOpen: false,
      openSettings: vi.fn(),
      openWorkspacePicker: vi.fn(),
      settingsCategory,
      setActiveView: vi.fn(),
      toggleFileBrowser: vi.fn(),
    });
    const currentIds = (settingsCategory: 'appearance' | 'marketplace') =>
      resolveSidebarActions(contextFor(settingsCategory)).filter((a) => a.active).map((a) => a.id);

    // Assert
    expect(currentIds('marketplace')).toEqual([MARKETPLACE_ACTION_ID]);
    expect(currentIds('appearance')).toEqual([SETTINGS_ACTION_ID]);
  });

  it('marketplace action opens settings on the marketplace category', () => {
    const openSettings = vi.fn();
    const context = createSidebarActionContext({
      activeView: 'dashboard',
      conversationTopicsEnabled: false,
      createShellPane: vi.fn(),
      fileBrowserOpen: false,
      openSettings,
      settingsCategory: 'appearance',
      setActiveView: vi.fn(),
      toggleFileBrowser: vi.fn(),
    });

    const marketplaceAction = resolveSidebarActions(context).find((a) => a.id === MARKETPLACE_ACTION_ID);
    marketplaceAction?.onSelect();

    expect(openSettings).toHaveBeenCalledWith('marketplace');
  });

  it('settings action opens settings on the default category', () => {
    const openSettings = vi.fn();
    const context = createSidebarActionContext({
      activeView: 'dashboard',
      conversationTopicsEnabled: false,
      createShellPane: vi.fn(),
      fileBrowserOpen: false,
      openSettings,
      settingsCategory: 'appearance',
      setActiveView: vi.fn(),
      toggleFileBrowser: vi.fn(),
    });

    const settingsAction = resolveSidebarActions(context).find((a) => a.id === SETTINGS_ACTION_ID);
    settingsAction?.onSelect();

    expect(openSettings).toHaveBeenCalledOnce();
  });

  it('toggles the active topics view back to the dashboard', () => {
    const setActiveView = vi.fn();
    const context = createSidebarActionContext({
      activeView: 'topics',
      conversationTopicsEnabled: true,
      createShellPane: vi.fn(),
      fileBrowserOpen: false,
      openSettings: vi.fn(),
      setActiveView,
      toggleFileBrowser: vi.fn(),
    });

    const topicsAction = resolveSidebarActions(context).find((action) => action.id === TOPICS_ACTION_ID);
    topicsAction?.onSelect();

    expect(topicsAction?.active).toBe(true);
    expect(setActiveView).toHaveBeenCalledWith('dashboard');
  });
});

const AGENT_PANE: AumxPane = {
  agent: 'claude',
  agentStatus: 'idle',
  branchName: 'feature/loading-truth',
  id: 'pane-1',
  paneId: '%1',
  prompt: 'ship it',
  slug: 'loading-truth',
  type: 'worktree',
};

const LOADING_TEXT = 'Loading agents…';
const EMPTY_CTA_TEXT = 'Launch your first agent';

describe('Sidebar agent-list loading truth', () => {
  const paneInitial = usePaneStore.getState();
  const projectInitial = useProjectStore.getState();
  const uiInitial = useUiStore.getState();
  const workspaceInitial = useWorkspacePickerStore.getState();

  beforeEach(() => {
    usePaneStore.setState({ ...paneInitial, loaded: false, panes: [] });
    useProjectStore.setState({ ...projectInitial, projectSwitching: false });
    useUiStore.setState({ ...uiInitial, sidebarCollapsed: false });
  });

  afterEach(() => {
    cleanup();
    useWorktreeStatusStore.setState({ statuses: {} });
    useWorkspacePickerStore.setState(workspaceInitial);
    usePaneStore.setState(paneInitial);
    useProjectStore.setState(projectInitial);
    useUiStore.setState(uiInitial);
  });

  it('reports loading instead of the empty CTA until pane state is authoritative', () => {
    // Arrange — store not yet hydrated from the main process
    const { container } = render(createElement(Sidebar));

    // Assert
    expect(screen.getByText(LOADING_TEXT).getAttribute('role')).toBe('status');
    expect(screen.queryByText(EMPTY_CTA_TEXT)).toBeNull();
    expect(screen.queryByText('No agents running')).toBeNull();
    expect(container.querySelector('ul')).toBeNull();
  });

  it('keeps reporting loading while a project switch is in flight', () => {
    // Arrange — store already hydrated, but the incoming project is not resolved yet
    usePaneStore.setState({ ...paneInitial, loaded: true, panes: [] });
    useProjectStore.setState({ ...projectInitial, projectSwitching: true });

    // Act
    render(createElement(Sidebar));

    // Assert
    expect(screen.getByText(LOADING_TEXT).getAttribute('role')).toBe('status');
    expect(screen.queryByText(EMPTY_CTA_TEXT)).toBeNull();
  });

  it('offers the first-agent CTA once the authoritative state is empty', () => {
    // Arrange
    usePaneStore.setState({ ...paneInitial, loaded: true, panes: [] });

    // Act
    render(createElement(Sidebar));

    // Assert
    expect(screen.getByText(EMPTY_CTA_TEXT)).toBeTruthy();
    expect(screen.queryByText(LOADING_TEXT)).toBeNull();
  });

  it('renders pane rows once the authoritative state has panes', () => {
    // Arrange
    usePaneStore.setState({ ...paneInitial, loaded: true, panes: [AGENT_PANE] });

    // Act
    render(createElement(Sidebar));

    // Assert
    expect(screen.getByText('loading-truth')).toBeTruthy();
    expect(screen.queryByText(LOADING_TEXT)).toBeNull();
    expect(screen.queryByText(EMPTY_CTA_TEXT)).toBeNull();
  });

  it('keeps the stable sidebar row marker used by target-size E2E coverage', () => {
    // Arrange
    usePaneStore.setState({
      ...paneInitial,
      loaded: true,
      panes: [AGENT_PANE],
      selectedPaneId: AGENT_PANE.id,
    });

    // Act
    const { container } = render(createElement(Sidebar));

    // Assert
    const row = container.querySelector(
      '[data-testid="app-shell-sidebar"] li [data-sidebar-agent-select="true"]',
    );
    expect(row).toBeTruthy();
    expect(row?.getAttribute('aria-current')).toBe('true');
  });

  it('opens the workspace picker from the nav list', () => {
    // Arrange
    const open = vi.fn();
    usePaneStore.setState({ ...paneInitial, loaded: true, panes: [AGENT_PANE] });
    useWorkspacePickerStore.setState({ open });
    render(createElement(Sidebar));

    // Act
    fireEvent.click(screen.getByTestId('sidebar-open-project'));

    // Assert
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('renders the settings action exactly once', () => {
    // Arrange
    usePaneStore.setState({ ...paneInitial, loaded: true, panes: [AGENT_PANE] });

    // Act
    render(createElement(Sidebar));

    // Assert
    expect(screen.getAllByRole('button', { name: 'Settings' })).toHaveLength(1);
  });
});
