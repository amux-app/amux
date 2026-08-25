// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MuxBasePane } from 'muxbase/core';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FocusView } from '../src/renderer/components/dashboard/FocusView';
import { Sidebar } from '../src/renderer/components/layout/Sidebar';
import {
  useFileBrowserStore,
  usePaneStore,
  useProjectStore,
  useUiStore,
  useWorkspaceTabsStore,
} from '../src/renderer/stores';

vi.mock('react-resizable-panels', () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Separator: () => <div role="separator" />,
}));

vi.mock('../src/renderer/components/pane-detail/InteractiveTerminal', () => ({
  InteractiveTerminal: ({ pane }: { pane: MuxBasePane }) => (
    <div data-testid="interactive-terminal">{pane.id}</div>
  ),
}));

vi.mock('../src/renderer/components/pane-detail/LazyGitDiffView', () => ({
  LazyGitDiffView: ({ pane }: { pane: MuxBasePane }) => (
    <div data-testid="git-diff-view">{pane.id}</div>
  ),
}));

vi.mock('../src/renderer/components/agent-devtools/AgentActivityPanel', () => ({
  AgentActivityPanel: ({ paneId }: { paneId: string }) => (
    <div data-testid="agent-activity">{paneId}</div>
  ),
}));

vi.mock('../src/renderer/components/agent-devtools/TokenUsageDashboard', () => ({
  TokenUsageDashboard: ({ paneId }: { paneId: string }) => (
    <div data-testid="token-usage">{paneId}</div>
  ),
}));

vi.mock('../src/renderer/components/file-browser/LazyFileViewer', () => ({
  LazyFileViewer: () => <div data-testid="file-viewer" />,
}));

vi.mock('../src/renderer/hooks/useAgentSessionHydration', () => ({
  useAgentSessionHydration: vi.fn(),
}));

function makePane(overrides: Partial<MuxBasePane>): MuxBasePane {
  return {
    agent: 'claude',
    agentStatus: 'idle',
    id: overrides.id ?? 'pane-1',
    paneId: overrides.paneId ?? '%1',
    projectRoot: '/repo',
    prompt: 'test prompt',
    slug: overrides.slug ?? 'feature-one',
    type: 'worktree',
    worktreePath: overrides.worktreePath ?? '/repo/.muxbase/worktrees/feature-one',
    ...overrides,
  };
}

function resetStores(panes: MuxBasePane[]): void {
  usePaneStore.setState({
    isCreating: false,
    loaded: true,
    panes,
    pendingPane: null,
    selectedPaneId: panes[0]?.id ?? null,
  });
  useProjectStore.setState({
    activeProject: {
      configPath: '/repo/.muxbase/muxbase.config.json',
      name: 'repo',
      paneCount: panes.length,
      root: '/repo',
      sessionName: 'muxbase-repo',
    },
    projectSwitching: false,
    projects: [],
    sessionName: 'muxbase-repo',
    sessionProjectName: 'repo',
    sessionProjectRoot: '/repo',
  });
  useUiStore.setState({
    activeView: 'dashboard',
    focusPaneId: panes[0]?.id ?? null,
    helpOverlayOpen: false,
    previousViewMode: null,
    progressAction: null,
    scrollToMessageId: null,
    sidebarCollapsed: false,
    theme: 'dark',
    viewMode: 'focus',
  });
  useFileBrowserStore.setState({
    isOpen: false,
  });
  useWorkspaceTabsStore.setState({
    activeTabByScope: {},
    tabsByScope: {},
  });
}

describe('Focus mode', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers the same diff surface as fleet mode', () => {
    resetStores([makePane({ id: 'pane-1' })]);

    render(<FocusView />);
    fireEvent.click(screen.getByRole('tab', { name: /diff/i }));

    expect(screen.getByTestId('git-diff-view').textContent).toBe('pane-1');
  });

  it('keeps the focused terminal in sync with sidebar agent selection', () => {
    const firstPane = makePane({ id: 'pane-1', slug: 'feature-one' });
    const secondPane = makePane({
      id: 'pane-2',
      paneId: '%2',
      slug: 'feature-two',
      worktreePath: '/repo/.muxbase/worktrees/feature-two',
    });
    resetStores([firstPane, secondPane]);

    render(<Sidebar />);
    fireEvent.click(screen.getByText('feature-two'));

    expect(usePaneStore.getState().selectedPaneId).toBe('pane-2');
    expect(useUiStore.getState().focusPaneId).toBe('pane-2');
    expect(useUiStore.getState().viewMode).toBe('focus');
  });

  it('returns from topics to the dashboard when selecting a sidebar pane', () => {
    resetStores([makePane({ id: 'pane-1' })]);
    useUiStore.setState({
      activeView: 'topics',
      viewMode: 'fleet',
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByText('feature-one'));

    expect(useUiStore.getState().activeView).toBe('dashboard');
    expect(useUiStore.getState().viewMode).toBe('fleet');
    expect(usePaneStore.getState().selectedPaneId).toBe('pane-1');
  });

  it('shows the active pane file tab in focus mode', () => {
    resetStores([makePane({ id: 'pane-1' })]);
    useWorkspaceTabsStore.setState({
      activeTabByScope: { 'pane-1': '/repo/.muxbase/worktrees/feature-one::src/index.ts' },
      tabsByScope: {
        'pane-1': [
          {
            fileName: 'index.ts',
            id: '/repo/.muxbase/worktrees/feature-one::src/index.ts',
            openedAt: 1,
            relativePath: 'src/index.ts',
            rootPath: '/repo/.muxbase/worktrees/feature-one',
          },
        ],
      },
    });

    render(<FocusView />);

    expect(screen.getByRole('tab', { name: /index\.ts/i }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('file-viewer')).toBeTruthy();
  });
});
