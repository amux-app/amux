// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AumxPane } from 'aumx/core';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneCell } from '../src/renderer/components/dashboard/PaneCell';
import {
  useAgentSessionStore,
  usePaneStore,
  usePaneActivityStore,
  useProjectStore,
  useUiStore,
  useWorkspaceTabsStore,
} from '../src/renderer/stores';
import { createEmptySession, type NormalizedSession } from '../src/shared/agent-session-types';

let interactiveTerminalRenderCount = 0;

vi.mock('../src/renderer/components/pane-detail/InteractiveTerminal', () => ({
  InteractiveTerminal: () => {
    interactiveTerminalRenderCount += 1;
    return <div data-testid="interactive-terminal" />;
  },
}));

vi.mock('../src/renderer/components/pane-detail/LazyGitDiffView', () => ({
  LazyGitDiffView: () => <div data-testid="git-diff-view" />,
}));

vi.mock('../src/renderer/components/dashboard/ReviewLaunchButton', () => ({
  ReviewLaunchButton: () => <button type="button">Review</button>,
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

const PANE_ID = 'pane-1';
const EDGE_TEST_ID = 'pane-attention-edge';
const WORD_TEST_ID = 'pane-attention-word';
const EDGE_TOKEN = 'bg-[var(--attention-waiting-edge)]';
const TEXT_TOKEN = 'text-[var(--attention-waiting-text)]';
const CONTAINER_QUERY = '@min-[360px]/panecell:inline';
const QUESTION = 'Which migration should I run first?';

function makePane(overrides: Partial<AumxPane> = {}): AumxPane {
  return {
    agent: 'claude',
    agentStatus: 'idle',
    id: PANE_ID,
    paneId: '%1',
    projectRoot: '/repo',
    prompt: 'ship it',
    slug: 'task-one',
    type: 'worktree',
    worktreePath: '/repo/.aumx/worktrees/task-one',
    ...overrides,
  };
}

function makeSession(overrides: Partial<NormalizedSession>): NormalizedSession {
  return { ...createEmptySession('claude', 'session-1'), ...overrides };
}

function resetStores(pane: AumxPane, options: { justFinished?: boolean; selected?: boolean } = {}): void {
  useAgentSessionStore.setState({ sessions: {} });
  usePaneStore.setState({
    isCreating: false,
    justFinishedPaneIds: new Set(options.justFinished ? [pane.id] : []),
    loaded: true,
    panes: [pane],
    pendingPane: null,
    selectedPaneId: options.selected === false ? null : pane.id,
  });
  const activityState = pane.agentStatus === 'waiting' || pane.agentStatus === 'working' || pane.agentStatus === 'idle'
    ? pane.agentStatus
    : 'unknown';
  usePaneActivityStore.setState({
    activityByPaneId: {
      [pane.id]: {
        activityRevision: 1,
        adapterHealth: 'degraded',
        certainty: 'provisional',
        liveness: 'unknown',
        openBackgroundWork: [],
        origin: 'none',
        paneIncarnationId: `${pane.id}-incarnation`,
        sinceWallMs: Date.now(),
        state: activityState,
      },
    },
    justFinishedPaneIds: new Set(options.justFinished ? [pane.id] : []),
  });
  useProjectStore.setState({ activeProject: null, projectSwitching: false, projects: [] });
  useUiStore.setState({
    activeView: 'dashboard',
    focusPaneId: null,
    theme: 'dark',
    viewMode: 'fleet',
    zenMode: false,
  });
  useWorkspaceTabsStore.setState({ activeTabByScope: {}, tabsByScope: {} });
}

function edge(): HTMLElement {
  return screen.getByTestId(EDGE_TEST_ID);
}

function root(): HTMLElement {
  return screen.getByTestId('pane-cell');
}

function header(): HTMLElement {
  return screen.getByRole('status').closest('div.group\\/header') as HTMLElement;
}

describe('PaneCell attention treatment', () => {
  beforeEach(() => {
    resetStores(makePane());
    interactiveTerminalRenderCount = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it('marks a waiting pane with the edge token, the word and the waiting dot', () => {
    // Arrange
    const pane = makePane({ agentStatus: 'waiting' });
    resetStores(pane);

    // Act
    render(<PaneCell pane={pane} />);

    // Assert
    expect(edge().className).toContain(EDGE_TOKEN);
    expect(screen.getByTestId(WORD_TEST_ID).textContent).toBe('Waiting');
    expect(screen.getByTestId(WORD_TEST_ID).className).toContain(TEXT_TOKEN);
    expect(screen.getByRole('status', { name: 'waiting' })).not.toBeNull();
  });

  it('marks a pane the shared classifier reports as waiting from its session alone', () => {
    // Arrange
    const pane = makePane({ agentStatus: 'idle' });
    resetStores(pane);
    useAgentSessionStore.setState({
      sessions: { [PANE_ID]: makeSession({ awaitingUserInput: true }) },
    });

    // Act
    render(<PaneCell pane={pane} />);

    // Assert
    expect(edge().className).toContain(EDGE_TOKEN);
    expect(screen.getByTestId(WORD_TEST_ID)).not.toBeNull();
    expect(screen.getByRole('status', { name: 'waiting' })).not.toBeNull();
  });

  it('leaves an idle pane with no colored edge and no word', () => {
    // Arrange
    const pane = makePane();
    resetStores(pane);

    // Act
    render(<PaneCell pane={pane} />);

    // Assert
    expect(edge().className).toContain('bg-transparent');
    expect(edge().className).not.toContain(EDGE_TOKEN);
    expect(screen.queryByTestId(WORD_TEST_ID)).toBeNull();
  });

  it('gives a ready pane a dot state only — no edge, no word', () => {
    // Arrange
    const pane = makePane({ agentStatus: 'idle' });
    resetStores(pane, { justFinished: true });

    // Act
    render(<PaneCell pane={pane} />);

    // Assert
    expect(screen.getByRole('status', { name: 'Ready for review' })).not.toBeNull();
    expect(edge().className).not.toContain(EDGE_TOKEN);
    expect(screen.queryByTestId(WORD_TEST_ID)).toBeNull();
  });

  it('renders the options question exactly once beside the waiting treatment', () => {
    // Arrange
    const pane = makePane({ agentStatus: 'idle' });
    resetStores(pane);
    useAgentSessionStore.setState({
      sessions: { [PANE_ID]: makeSession({ awaitingUserInput: true, pendingUserQuestion: QUESTION }) },
    });

    // Act
    render(<PaneCell pane={pane} />);

    // Assert
    expect(screen.getAllByText(QUESTION)).toHaveLength(1);
    expect(screen.getByTestId(WORD_TEST_ID)).not.toBeNull();
    expect(edge().className).toContain(EDGE_TOKEN);
  });

  it('keeps the selected top edge distinct from the attention left edge', () => {
    // Arrange
    const pane = makePane({ agentStatus: 'waiting' });
    resetStores(pane, { selected: true });

    // Act
    render(<PaneCell pane={pane} />);

    // Assert
    expect(header().className).toContain('border-t-2');
    expect(header().className).not.toContain('border-t-transparent');
    expect(header().className).not.toContain(EDGE_TOKEN);
    expect(edge().className).toContain(EDGE_TOKEN);
    expect(header().contains(edge())).toBe(false);
  });

  it('keeps the waiting edge when the pane is not selected', () => {
    // Arrange
    const pane = makePane({ agentStatus: 'waiting' });
    resetStores(pane, { selected: false });

    // Act
    render(<PaneCell pane={pane} />);

    // Assert
    expect(header().className).toContain('border-t-transparent');
    expect(edge().className).toContain(EDGE_TOKEN);
  });

  it('reserves the edge out of flow so waiting never moves the content box', () => {
    // Arrange
    const pane = makePane();
    resetStores(pane);
    const { rerender } = render(<PaneCell pane={pane} />);
    const idleRootClass = root().className;
    const idleEdge = edge();
    const idleHeaderClass = header().className;

    // Act
    const waitingPane = makePane({ agentStatus: 'waiting' });
    usePaneActivityStore.setState({ activityByPaneId: {
      [PANE_ID]: {
        activityRevision: 2,
        adapterHealth: 'degraded',
        certainty: 'provisional',
        liveness: 'unknown',
        openBackgroundWork: [],
        origin: 'none',
        paneIncarnationId: `${PANE_ID}-incarnation`,
        sinceWallMs: Date.now(),
        state: 'waiting',
      },
    } });
    rerender(<PaneCell pane={waitingPane} />);

    // Assert
    expect(root().className).toBe(idleRootClass);
    expect(header().className).toBe(idleHeaderClass);
    expect(edge()).toBe(idleEdge);
    expect(edge().className).toContain('absolute');
    expect(edge().className).toContain('inset-y-0');
    expect(edge().className).toContain('left-0');
    expect(edge().className).toContain('w-0.5');
    expect(edge().className).toContain('pointer-events-none');
    expect(edge().getAttribute('aria-hidden')).toBe('true');
  });

  it('reveals the word only through the panecell container query and keeps the dot name below it', () => {
    // Arrange
    const pane = makePane({ agentStatus: 'waiting' });
    resetStores(pane);

    // Act
    render(<PaneCell pane={pane} />);

    // Assert
    const word = screen.getByTestId(WORD_TEST_ID);
    expect(word.className).toContain('hidden');
    expect(word.className).toContain(CONTAINER_QUERY);
    expect(root().className).toContain('@container/panecell');

    // Act
    const dot = screen.getByRole('status', { name: 'waiting' });
    fireEvent.mouseEnter(dot.parentElement as HTMLElement);

    // Assert
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toBe('Waiting for input');
    expect(dot.parentElement?.getAttribute('aria-describedby')).toBe(tooltip.id);
  });

  it('paints no header tint, no cell outline and no animation on the attention elements', () => {
    // Arrange
    const pane = makePane();
    resetStores(pane);
    const { rerender } = render(<PaneCell pane={pane} />);
    const idleHeaderClass = header().className;

    // Act
    const waitingPane = makePane({ agentStatus: 'waiting' });
    usePaneActivityStore.setState({ activityByPaneId: {
      [PANE_ID]: {
        activityRevision: 2,
        adapterHealth: 'degraded',
        certainty: 'provisional',
        liveness: 'unknown',
        openBackgroundWork: [],
        origin: 'none',
        paneIncarnationId: `${PANE_ID}-incarnation`,
        sinceWallMs: Date.now(),
        state: 'waiting',
      },
    } });
    rerender(<PaneCell pane={waitingPane} />);

    // Assert
    expect(header().className).toBe(idleHeaderClass);
    for (const chrome of ['animate-', 'transition', 'motion-', 'ring-', 'outline-']) {
      expect(edge().className).not.toContain(chrome);
      expect(screen.getByTestId(WORD_TEST_ID).className).not.toContain(chrome);
    }
    expect(root().className).not.toContain('ring-');
    expect(root().className).not.toContain('outline-');
  });

  it('keeps the waiting edge in Zen mode without adding the header word', () => {
    // Arrange
    const pane = makePane({ agentStatus: 'waiting' });
    resetStores(pane);
    useUiStore.setState({ zenMode: true });

    // Act
    render(<PaneCell pane={pane} />);

    // Assert
    expect(edge().className).toContain(EDGE_TOKEN);
    expect(screen.getByRole('status', { name: 'waiting' })).not.toBeNull();
    expect(screen.queryByTestId(WORD_TEST_ID)).toBeNull();
  });

  it('follows live store transitions without remounting the edge', () => {
    // Arrange
    const pane = makePane({ agentStatus: 'idle' });
    resetStores(pane);
    render(<PaneCell pane={pane} />);
    const mountedEdge = edge();

    // Act
    act(() => {
      useAgentSessionStore.setState({
        sessions: { [PANE_ID]: makeSession({ awaitingUserInput: true, pendingUserQuestion: QUESTION }) },
      });
    });

    // Assert
    expect(edge()).toBe(mountedEdge);
    expect(edge().className).toContain(EDGE_TOKEN);

    // Act
    act(() => {
      useAgentSessionStore.setState({ sessions: { [PANE_ID]: makeSession({ turnCompleted: true }) } });
    });

    // Assert
    expect(edge()).toBe(mountedEdge);
    expect(edge().className).not.toContain(EDGE_TOKEN);
    expect(screen.queryByTestId(WORD_TEST_ID)).toBeNull();
  });

  it('does not re-render when an unrelated session field changes without touching awaitingUserInput or pendingUserQuestion', () => {
    // Arrange
    const pane = makePane({ agentStatus: 'idle' });
    resetStores(pane);
    useAgentSessionStore.setState({
      sessions: { [PANE_ID]: makeSession({ awaitingUserInput: false, isOngoing: false }) },
    });
    render(<PaneCell pane={pane} />);
    const rendersBeforeUpdate = interactiveTerminalRenderCount;

    // Act: replace the session with a new object reference where only an
    // unrelated field (isOngoing) changed — awaitingUserInput and
    // pendingUserQuestion are unchanged.
    act(() => {
      useAgentSessionStore.setState({
        sessions: { [PANE_ID]: makeSession({ awaitingUserInput: false, isOngoing: true }) },
      });
    });

    // Assert
    expect(interactiveTerminalRenderCount).toBe(rendersBeforeUpdate);
  });
});
