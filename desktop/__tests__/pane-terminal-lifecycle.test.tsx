// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AumxPane } from 'aumx/core';
import React, { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneCell } from '../src/renderer/components/dashboard/PaneCell';
import { usePaneActivityStore } from '../src/renderer/stores/pane-activity.store';
import type { PaneActivityState } from '../src/shared/pane-activity';
import { makeActivity } from './helpers/pane-activity-fixtures';
import { KanbanSidePanel } from '../src/renderer/components/kanban/KanbanSidePanel';
import {
  useAgentSessionStore,
  usePaneStore,
  useProjectStore,
  useUiStore,
  useWorkspaceTabsStore,
} from '../src/renderer/stores';

const terminalLifecycle = vi.hoisted(() => ({
  mount: vi.fn(),
  unmount: vi.fn(),
}));

vi.mock('../src/renderer/components/pane-detail/InteractiveTerminal', () => ({
  InteractiveTerminal: ({
    pane,
    terminalVisible,
  }: {
    pane: AumxPane;
    terminalVisible?: boolean;
  }) => {
    useEffect(() => {
      terminalLifecycle.mount(pane.id);
      return () => terminalLifecycle.unmount(pane.id);
    }, [pane.id]);

    return (
      <div data-testid="interactive-terminal" data-terminal-visible={String(terminalVisible)}>
        {pane.id}
      </div>
    );
  },
}));

vi.mock('../src/renderer/components/pane-detail/LazyGitDiffView', () => ({
  LazyGitDiffView: ({ pane }: { pane: AumxPane }) => <div data-testid="git-diff-view">{pane.id}</div>,
}));

vi.mock('../src/renderer/components/pane-detail/WorktreeTab', () => ({
  WorktreeTab: ({ pane }: { pane: AumxPane }) => <div data-testid="worktree-tab-content">{pane.id}</div>,
}));

vi.mock('../src/renderer/components/agent-devtools/AgentActivityPanel', () => ({
  AgentActivityPanel: ({ paneId }: { paneId: string }) => <div data-testid="agent-activity">{paneId}</div>,
}));

vi.mock('../src/renderer/components/agent-devtools/TokenUsageDashboard', () => ({
  TokenUsageDashboard: ({ paneId }: { paneId: string }) => <div data-testid="token-usage">{paneId}</div>,
}));

vi.mock('../src/renderer/components/dashboard/ReviewLaunchButton', () => ({
  ReviewLaunchButton: () => <button type="button">Review</button>,
}));

vi.mock('../src/renderer/components/file-browser/LazyFileViewer', () => ({
  LazyFileViewer: () => <div data-testid="file-viewer" />,
}));

vi.mock('../src/renderer/hooks/useAgentSessionHydration', () => ({
  useAgentSessionHydration: vi.fn(),
}));

vi.mock('../src/renderer/hooks/usePaneActions', () => ({
  usePaneActions: () => ({
    closePane: vi.fn(),
    createWorktree: vi.fn(),
    duplicatePane: vi.fn(),
    jumpToPane: vi.fn(),
    mergePane: vi.fn(),
    renamePane: vi.fn(),
    sendFixesToAuthor: vi.fn(),
    startReview: vi.fn(),
  }),
}));

function makePane(): AumxPane {
  return {
    agent: 'opencode',
    agentStatus: 'working',
    id: 'pane-1',
    paneId: '%1',
    projectRoot: '/repo',
    prompt: 'test prompt',
    slug: 'task-one',
    type: 'worktree',
    worktreePath: '/repo/.aumx/worktrees/task-one',
  };
}

function makeShellPane(): AumxPane {
  return {
    agentStatus: 'idle',
    id: 'pane-1',
    paneId: '%1',
    projectRoot: '/repo',
    prompt: '',
    slug: 'terminal-one',
    type: 'shell',
  };
}

function seedActivity(paneId: string, state: PaneActivityState): void {
  usePaneActivityStore.setState({
    activityByPaneId: { [paneId]: makeActivity({ paneIncarnationId: `${paneId}-incarnation`, state }) },
  });
}

function resetStores(pane: AumxPane): void {
  useAgentSessionStore.setState({ sessions: {} });
  seedActivity(pane.id, pane.type === 'shell' ? 'idle' : 'working');
  usePaneStore.setState({
    isCreating: false,
    justFinishedPaneIds: new Set<string>(),
    loaded: true,
    panes: [pane],
    pendingPane: null,
    selectedPaneId: pane.id,
  });
  useProjectStore.setState({
    activeProject: {
      configPath: '/repo/.aumx/aumx.config.json',
      name: 'repo',
      paneCount: 1,
      root: '/repo',
      sessionName: 'aumx-repo',
    },
    projectSwitching: false,
    projects: [],
    sessionName: 'aumx-repo',
    sessionProjectName: 'repo',
    sessionProjectRoot: '/repo',
  });
  useUiStore.setState({
    activeView: 'dashboard',
    focusPaneId: null,
    hiddenPaneIds: new Set<string>(),
    theme: 'dark',
    viewMode: 'fleet',
  });
  useWorkspaceTabsStore.setState({
    activeTabByScope: {},
    tabsByScope: {},
  });
}

function terminalLayer(): HTMLElement {
  const layer = screen.getByTestId('interactive-terminal').parentElement;
  expect(layer).not.toBeNull();
  return layer!;
}

describe('terminal tab lifecycle', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    terminalLifecycle.mount.mockClear();
    terminalLifecycle.unmount.mockClear();
    resetStores(makePane());
  });

  it('keeps the fleet terminal mounted while pane tabs are inspected', () => {
    const pane = makePane();
    render(<PaneCell pane={pane} />);

    expect(terminalLifecycle.mount).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('tab', { name: /diff/i }));

    expect(screen.getByTestId('git-diff-view').textContent).toBe(pane.id);
    expect(terminalLayer().getAttribute('aria-hidden')).toBe('true');
    expect(terminalLifecycle.unmount).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('tab', { name: /agent/i }));

    expect(terminalLayer().getAttribute('aria-hidden')).toBe('false');
    expect(terminalLifecycle.mount).toHaveBeenCalledTimes(1);
    expect(terminalLifecycle.unmount).not.toHaveBeenCalled();
  });

  it('labels a plain CLI pane tab as Terminal instead of Agent', () => {
    const pane = makeShellPane();
    resetStores(pane);

    render(<PaneCell pane={pane} />);

    expect(screen.getByRole('tab', { name: /terminal/i })).not.toBeNull();
    expect(screen.queryByRole('tab', { name: /agent/i })).toBeNull();
  });

  it('marks the terminal hidden when its Fleet pane is outside the viewport', () => {
    const pane = makePane();

    render(<PaneCell pane={pane} viewportVisible={false} />);

    expect(screen.getByTestId('interactive-terminal').dataset.terminalVisible).toBe('false');
  });

  it('keeps the pane root and terminal host mounted across attention transitions', () => {
    const pane = makePane();
    const { rerender } = render(<PaneCell pane={pane} />);
    const paneRoot = screen.getByTestId('pane-cell');
    const terminalHost = screen.getByTestId('interactive-terminal');

    act(() => seedActivity(pane.id, 'waiting'));
    rerender(<PaneCell pane={pane} />);

    expect(screen.getByTestId('pane-cell')).toBe(paneRoot);
    expect(screen.getByTestId('interactive-terminal')).toBe(terminalHost);
    expect(screen.getByTestId('pane-attention-edge').className)
      .toContain('bg-[var(--attention-waiting-edge)]');

    act(() => seedActivity(pane.id, 'idle'));
    rerender(<PaneCell pane={pane} />);

    expect(screen.getByTestId('pane-cell')).toBe(paneRoot);
    expect(screen.getByTestId('interactive-terminal')).toBe(terminalHost);
    expect(screen.queryByTestId('pane-attention-word')).toBeNull();

    act(() => usePaneActivityStore.setState({ justFinishedPaneIds: new Set([pane.id]) }));

    expect(screen.getByTestId('pane-cell')).toBe(paneRoot);
    expect(screen.getByTestId('interactive-terminal')).toBe(terminalHost);
    expect(screen.getByRole('status', { name: 'Ready for review' })).not.toBeNull();
    expect(terminalLifecycle.mount).toHaveBeenCalledTimes(1);
    expect(terminalLifecycle.unmount).not.toHaveBeenCalled();
  });

  it('keeps the kanban side-panel terminal mounted while pane tabs are inspected', async () => {
    const pane = makePane();
    render(<KanbanSidePanel pane={pane} onClose={vi.fn()} />);

    expect(terminalLifecycle.mount).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('tab', { name: /activity/i }));

    expect((await screen.findByTestId('agent-activity')).textContent).toBe(pane.id);
    expect(terminalLayer().getAttribute('aria-hidden')).toBe('true');
    expect(terminalLifecycle.unmount).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('tab', { name: /terminal/i }));

    expect(terminalLayer().getAttribute('aria-hidden')).toBe('false');
    expect(terminalLifecycle.mount).toHaveBeenCalledTimes(1);
    expect(terminalLifecycle.unmount).not.toHaveBeenCalled();
  });
});
