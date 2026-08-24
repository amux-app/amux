// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AumxPane } from 'aumx/core';
import React, { Profiler } from 'react';
import { createEmptyMetrics, type NormalizedSession } from '../src/shared/agent-session-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { useAgentSessionStore } from '../src/renderer/stores/agent-session.store';
import { useNotificationStore } from '../src/renderer/stores/notification.store';
import { usePaneActivityStore } from '../src/renderer/stores/pane-activity.store';
import { usePaneStore } from '../src/renderer/stores/pane.store';
import { useProjectStore } from '../src/renderer/stores/project.store';
import { useUiStore } from '../src/renderer/stores/ui.store';
import type { PaneActivity, PaneActivityState } from '../src/shared/pane-activity';
import { makeActivity } from './helpers/pane-activity-fixtures';

const paneApi = vi.hoisted(() => ({ createPane: vi.fn() }));
const settingsApi = vi.hoisted(() => ({
  getElectronSettings: vi.fn(),
  resetElectronSettings: vi.fn(),
  updateElectronSetting: vi.fn(),
}));

vi.mock('../src/renderer/api/pane.api', () => paneApi);
vi.mock('../src/renderer/api/electron-settings.api', () => settingsApi);

import { Sidebar } from '../src/renderer/components/layout/Sidebar';

const TOOLTIP_DWELL_MS = 400;

const ALPHA_ROOT = '/work/alpha';
const BETA_ROOT = '/work/beta';

function pane(id: string, overrides: Partial<AumxPane> = {}): AumxPane {
  return {
    agent: 'claude',
    id,
    paneId: `%${id}`,
    projectRoot: ALPHA_ROOT,
    prompt: 'do the thing',
    slug: id,
    type: 'worktree',
    ...overrides,
  };
}

type ActivitySeed = PaneActivityState | Partial<PaneActivity>;

function seedActivity(seeds: Record<string, ActivitySeed>): void {
  usePaneActivityStore.setState({
    activityByPaneId: Object.fromEntries(
      Object.entries(seeds).map(([paneId, seed]) => [
        paneId,
        makeActivity({
          paneIncarnationId: `${paneId}-incarnation`,
          ...(typeof seed === 'string' ? { state: seed } : seed),
        }),
      ]),
    ),
  });
}

function session(overrides: Partial<NormalizedSession> = {}): NormalizedSession {
  return {
    agent: 'claude',
    compactionEvents: [],
    isOngoing: true,
    messages: [],
    metrics: createEmptyMetrics(),
    sessionId: 'session-1',
    subagents: [],
    ...overrides,
  };
}

function sidebar(): HTMLElement {
  return screen.getByTestId('app-shell-sidebar');
}

function rowNames(): string[] {
  return [...sidebar().querySelectorAll('[data-sidebar-agent-select="true"]')].map((el) => {
    const nameEl = el.querySelector('[data-agent-name="true"]');
    return (nameEl ?? el).textContent?.trim() ?? '';
  });
}

function groupHeaders(): string[] {
  return screen.queryAllByTestId('sidebar-group-header').map((el) => el.textContent?.trim() ?? '');
}

function openMenu(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Sidebar options' }));
}

describe('sidebar organize and ordering', () => {
  const paneInitial = usePaneStore.getState();
  const projectInitial = useProjectStore.getState();
  const uiInitial = useUiStore.getState();

  beforeEach(() => {
    settingsApi.updateElectronSetting.mockResolvedValue(null);
    usePaneStore.setState({ ...paneInitial, loaded: true, panes: [], selectedPaneId: null });
    useProjectStore.setState({
      ...projectInitial,
      activeProject: { name: 'alpha', root: ALPHA_ROOT, sessionName: 'aumx-alpha', paneCount: 0 },
      projectSwitching: false,
    });
    useUiStore.setState({ ...uiInitial, sidebarCollapsed: false, sidebarOrganize: 'project', sidebarSort: 'priority' });
    useAgentSessionStore.setState({ sessions: {} });
    usePaneActivityStore.getState().reset();
    useNotificationStore.getState().clearToasts();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
    usePaneStore.setState(paneInitial);
    useProjectStore.setState(projectInitial);
    useUiStore.setState(uiInitial);
    useAgentSessionStore.setState({ sessions: {} });
    usePaneActivityStore.getState().reset();
    useNotificationStore.getState().clearToasts();
  });

  it('renders one uppercase header per project with its full count', () => {
    // Arrange
    usePaneStore.setState({
      loaded: true,
      panes: [pane('a1'), pane('a2'), pane('b1', { projectRoot: BETA_ROOT })],
    });

    // Act
    render(<Sidebar />);

    // Assert
    expect(groupHeaders()).toEqual(['alpha· 2', 'beta· 1']);
  });

  it('renders no header when project mode collapses to a single group', () => {
    // Arrange
    usePaneStore.setState({ loaded: true, panes: [pane('a1'), pane('a2')] });

    // Act
    render(<Sidebar />);

    // Assert
    expect(groupHeaders()).toEqual([]);
    expect(rowNames()).toEqual(['a1', 'a2']);
  });

  it('drops headers entirely in flat mode', () => {
    // Arrange
    useUiStore.setState({ sidebarOrganize: 'flat' });
    usePaneStore.setState({
      loaded: true,
      panes: [pane('a1'), pane('b1', { projectRoot: BETA_ROOT })],
    });

    // Act
    render(<Sidebar />);

    // Assert
    expect(groupHeaders()).toEqual([]);
    expect(rowNames()).toEqual(['a1', 'b1']);
  });

  it('shows a shell creation failure instead of failing silently', async () => {
    // Arrange
    paneApi.createPane.mockResolvedValue({ success: false, error: 'Choose a project first.' });
    render(<Sidebar />);

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Shell' }));

    // Assert
    await waitFor(() => {
      expect(useNotificationStore.getState().toasts).toEqual([
        expect.objectContaining({ message: 'Choose a project first.', severity: 'error' }),
      ]);
    });
  });

  it('floats a waiting pane above idle panes under priority sort', () => {
    // Arrange
    usePaneStore.setState({
      loaded: true,
      panes: [pane('idle-one'), pane('needs-input'), pane('idle-two')],
    });
    seedActivity({ 'idle-one': 'idle', 'idle-two': 'idle', 'needs-input': 'waiting' });

    // Act
    render(<Sidebar />);

    // Assert
    expect(rowNames()[0]).toBe('needs-input');
  });

  it('keeps store order under manual sort', () => {
    // Arrange
    useUiStore.setState({ sidebarSort: 'manual' });
    usePaneStore.setState({
      loaded: true,
      panes: [pane('idle-one'), pane('needs-input'), pane('idle-two')],
    });
    seedActivity({ 'idle-one': 'idle', 'idle-two': 'idle', 'needs-input': 'waiting' });

    // Act
    render(<Sidebar />);

    // Assert
    expect(rowNames()).toEqual(['idle-one', 'needs-input', 'idle-two']);
  });

  it('caps a group at five rows and expands in place, with a two-way toggle', () => {
    // Arrange
    useUiStore.setState({ sidebarSort: 'manual' });
    usePaneStore.setState({
      loaded: true,
      panes: Array.from({ length: 7 }, (_unused, index) => pane(`pane-${index}`)),
    });
    render(<Sidebar />);
    expect(rowNames()).toHaveLength(5);

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }));

    // Assert
    expect(rowNames()).toHaveLength(7);
    expect(screen.queryByRole('button', { name: 'Show 2 more' })).toBeNull();

    // Act — collapse back
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));

    // Assert
    expect(rowNames()).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Show 2 more' })).toBeTruthy();
  });

  it('announces the waiting suffix with a correctly pluralised label', () => {
    // Arrange
    usePaneStore.setState({ loaded: true, panes: [pane('one')] });
    seedActivity({ one: 'waiting' });

    // Act
    const { rerender } = render(<Sidebar />);

    // Assert — singular
    expect(screen.getByRole('button', { name: '1 agent waiting for input' })).toBeTruthy();

    // Act — a second waiting pane
    usePaneStore.setState({ loaded: true, panes: [pane('one'), pane('two')] });
    seedActivity({ one: 'waiting', two: 'waiting' });
    rerender(<Sidebar />);

    // Assert — plural
    expect(screen.getByRole('button', { name: '2 agents waiting for input' })).toBeTruthy();
  });

  it('announces the waiting count through an always-mounted polite live region', () => {
    // Arrange
    usePaneStore.setState({ loaded: true, panes: [pane('one')] });
    seedActivity({ one: 'idle' });

    // Act
    const { container, rerender } = render(<Sidebar />);

    // Assert — nothing waiting yet, the live region stays mounted but empty
    const liveRegion = container.querySelector('[data-testid="app-shell-sidebar"] [role="status"].sr-only') as HTMLElement;
    expect(liveRegion).not.toBeNull();
    expect(liveRegion.textContent).toBe('');

    // Act — a pane starts waiting
    seedActivity({ one: 'waiting' });
    rerender(<Sidebar />);

    // Assert
    expect(liveRegion.textContent).toBe('1 agent waiting for input');
  });

  it('paints the leading indicator and tooltip from the effective status, not the raw activity state', () => {
    // Arrange — activity settled to idle while the session is awaiting input
    usePaneStore.setState({
      loaded: true,
      panes: [pane('stale')],
    });
    seedActivity({ stale: 'idle' });
    useAgentSessionStore.setState({ sessions: { stale: session({ awaitingUserInput: true }) } });

    // Act
    vi.useFakeTimers();
    const { container } = render(<Sidebar />);

    // Assert — the leading dot, its aria-label and the tooltip all say waiting
    const dot = container.querySelector('li [role="status"]');
    expect(dot?.getAttribute('aria-label')).toBe('waiting');

    fireEvent.mouseEnter(container.querySelector('li > span') as HTMLElement);
    act(() => { vi.advanceTimersByTime(TOOLTIP_DWELL_MS); });
    const tooltipText = screen.getByRole('tooltip').textContent ?? '';
    expect(tooltipText).toContain('Waiting for input');
    expect(tooltipText.match(/waiting/gi)).toHaveLength(1);
    vi.useRealTimers();
  });

  it('does not let a stale completed session snapshot override the resolved activity', () => {
    // Arrange — resolved activity still has authoritative evidence that the pane is working.
    usePaneStore.setState({ loaded: true, panes: [pane('finished')] });
    seedActivity({ finished: 'working' });
    useAgentSessionStore.setState({ sessions: { finished: session({ turnCompleted: true }) } });

    // Act
    const { container } = render(<Sidebar />);

    // Assert — the session snapshot cannot hide work or defeat the arbiter's fallback.
    expect(container.querySelector('li [role="status"][aria-label="Loading"]')).not.toBeNull();
  });

  it('hides the waiting suffix when nothing is waiting', () => {
    // Arrange
    usePaneStore.setState({ loaded: true, panes: [pane('one')] });

    // Act
    render(<Sidebar />);

    // Assert
    expect(screen.queryByRole('button', { name: /waiting for input/ })).toBeNull();
  });

  it('renders the spinner in the leading slot for a working pane', () => {
    // Arrange
    usePaneStore.setState({ loaded: true, panes: [pane('one')] });
    seedActivity({ one: 'working' });

    // Act
    const { container } = render(<Sidebar />);

    // Assert
    expect(container.querySelector('li [role="status"][aria-label="Loading"]')).not.toBeNull();
  });

  it('renders an empty leading slot for an idle pane', () => {
    // Arrange
    usePaneStore.setState({ loaded: true, panes: [pane('one')] });

    // Act
    const { container } = render(<Sidebar />);

    // Assert
    const slot = container.querySelector('[data-sidebar-agent-select="true"] > span[aria-hidden="true"]');
    expect(slot?.children).toHaveLength(0);
  });

  it('hides the leading indicator subtree from assistive tech', () => {
    // Arrange
    usePaneStore.setState({ loaded: true, panes: [pane('one')] });
    seedActivity({ one: 'waiting' });

    // Act
    const { container } = render(<Sidebar />);

    // Assert
    const slot = container.querySelector('[data-sidebar-agent-select="true"] > span');
    expect(slot?.getAttribute('aria-hidden')).toBe('true');
  });

  it('exposes the effective status on the row aria-label', () => {
    // Arrange
    usePaneStore.setState({ loaded: true, panes: [pane('one')] });
    seedActivity({ one: 'working' });

    // Act
    const { container } = render(<Sidebar />);

    // Assert
    expect(container.querySelector('[data-sidebar-agent-select="true"]')?.getAttribute('aria-label')).toBe('one · Working');
  });

  it('paints the waiting dot through the --sidebar-status-waiting token', () => {
    // Arrange
    usePaneStore.setState({ loaded: true, panes: [pane('one')] });
    seedActivity({ one: 'waiting' });

    // Act
    const { container } = render(<Sidebar />);

    // Assert
    const dotWrapper = container.querySelector('li [role="status"]')?.parentElement as HTMLElement;
    expect(dotWrapper.style.getPropertyValue('--dot-color')).toBe('var(--sidebar-status-waiting)');
  });

  it('marks group containers and rows with a flip id for reorder animation', () => {
    // Arrange
    usePaneStore.setState({
      loaded: true,
      panes: [pane('a1'), pane('b1', { projectRoot: BETA_ROOT })],
    });

    // Act
    const { container } = render(<Sidebar />);

    // Assert
    expect(container.querySelector(`[data-flip-id="${ALPHA_ROOT}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-flip-id="${BETA_ROOT}"]`)).not.toBeNull();
    expect(container.querySelector('li[data-flip-id="a1"]')).not.toBeNull();
    expect(container.querySelector('li[data-flip-id="b1"]')).not.toBeNull();
  });

  it('labels each grouped list via aria-labelledby pointing at its header', () => {
    // Arrange
    usePaneStore.setState({
      loaded: true,
      panes: [pane('a1'), pane('b1', { projectRoot: BETA_ROOT })],
    });

    // Act
    render(<Sidebar />);

    // Assert
    const headers = screen.getAllByTestId('sidebar-group-header');
    expect(headers).toHaveLength(2);
    for (const header of headers) {
      const list = header.nextElementSibling as HTMLElement;
      expect(list.tagName).toBe('UL');
      expect(list.getAttribute('aria-labelledby')).toBe(header.id);
      expect(header.id).not.toBe('');
    }
  });

  it('labels the single-group list with a generic aria-label instead of a header id', () => {
    // Arrange
    usePaneStore.setState({ loaded: true, panes: [pane('a1'), pane('a2')] });

    // Act
    const { container } = render(<Sidebar />);

    // Assert
    const list = container.querySelector('ul');
    expect(list?.getAttribute('aria-label')).toBe('Agents');
    expect(list?.hasAttribute('aria-labelledby')).toBe(false);
  });

  it('gives distinct header ids even when two project roots sanitize to the same string', () => {
    // Arrange — '/p/my.app' and '/p/my-app' both sanitize to 'p-my-app'
    usePaneStore.setState({
      loaded: true,
      panes: [
        pane('a1', { projectRoot: '/p/my.app' }),
        pane('b1', { projectRoot: '/p/my-app' }),
      ],
    });

    // Act
    render(<Sidebar />);

    // Assert
    const headers = screen.getAllByTestId('sidebar-group-header');
    expect(headers).toHaveLength(2);
    expect(headers[0].id).not.toBe('');
    expect(headers[1].id).not.toBe('');
    expect(headers[0].id).not.toBe(headers[1].id);
  });

  it('holds sidebar order steady while the pointer is inside, then commits on leave', () => {
    // Arrange
    usePaneStore.setState({ loaded: true, panes: [pane('idle-one'), pane('idle-two')] });
    render(<Sidebar />);
    expect(rowNames()).toEqual(['idle-one', 'idle-two']);
    const list = screen.getByTestId('sidebar-agent-list');
    fireEvent.pointerEnter(list);

    // Act — idle-two starts waiting while the pointer is still inside
    act(() => {
      seedActivity({ 'idle-one': 'idle', 'idle-two': 'waiting' });
    });

    // Assert — order stays held, but the row's own status keeps updating live
    expect(rowNames()).toEqual(['idle-one', 'idle-two']);
    expect(screen.getByRole('button', { name: 'idle-two · Waiting for input' })).toBeTruthy();

    // Act — pointer leaves, committing the fresh priority order
    fireEvent.pointerLeave(list);

    // Assert
    expect(rowNames()).toEqual(['idle-two', 'idle-one']);
  });

  it('keeps the working indicator attached to its pane across every sort mode', async () => {
    // Arrange — OpenCode begins in the middle so active sorts must move its row.
    useUiStore.setState({ sidebarOrganize: 'flat', sidebarSort: 'manual' });
    usePaneStore.setState({
      loaded: true,
      panes: [
        pane('claude-idle', { agent: 'claude' }),
        pane('opencode-working', { agent: 'opencode' }),
        pane('codex-idle', { agent: 'codex' }),
      ],
    });
    seedActivity({
      'claude-idle': { state: 'idle', sinceWallMs: 300 },
      'codex-idle': { state: 'idle', sinceWallMs: 200 },
      'opencode-working': { state: 'working', sinceWallMs: 100 },
    });
    const { container } = render(<Sidebar />);

    const expectOpenCodeWorking = (): void => {
      const button = screen.getByRole('button', { name: 'opencode-working · Working' });
      expect(button.closest('li')?.querySelector('[role="status"][aria-label="Loading"]')).not.toBeNull();
      expect(container.querySelectorAll('[role="status"][aria-label="Loading"]')).toHaveLength(1);
    };

    // Act / Assert — priority and last-active both float the active row.
    expectOpenCodeWorking();
    openMenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Priority' }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(rowNames()[0]).toBe('opencode-working');
    expectOpenCodeWorking();

    openMenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Last active' }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(rowNames()[0]).toBe('opencode-working');
    expectOpenCodeWorking();

    // Act / Assert — creation order moves it back without losing the indicator.
    openMenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Creation order' }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(rowNames()).toEqual(['claude-idle', 'opencode-working', 'codex-idle']);
    expectOpenCodeWorking();
  });

  it('does not force a commit when a row is merely selected while the pointer is inside', () => {
    // Arrange
    usePaneStore.setState({ loaded: true, panes: [pane('idle-one'), pane('idle-two')] });
    seedActivity({ 'idle-one': 'idle', 'idle-two': 'idle' });
    render(<Sidebar />);
    const list = screen.getByTestId('sidebar-agent-list');
    fireEvent.pointerEnter(list);
    act(() => {
      seedActivity({ 'idle-one': 'idle', 'idle-two': 'waiting' });
    });

    // Act — click the held (non-waiting-first) row
    fireEvent.click(screen.getByRole('button', { name: 'idle-one · Idle' }));

    // Assert — order is still held after the click
    expect(rowNames()).toEqual(['idle-one', 'idle-two']);
  });

  it('commits immediately even while held when a pane is added mid-hover', () => {
    // Arrange
    usePaneStore.setState({ loaded: true, panes: [pane('idle-one'), pane('idle-two')] });
    render(<Sidebar />);
    const list = screen.getByTestId('sidebar-agent-list');
    fireEvent.pointerEnter(list);

    // Act — a new pane arrives mid-hover
    act(() => {
      usePaneStore.setState({
        panes: [pane('idle-one'), pane('idle-two'), pane('idle-three')],
      });
      seedActivity({ 'idle-one': 'idle', 'idle-three': 'waiting', 'idle-two': 'idle' });
    });

    // Assert — the new pane is never deferred behind a stale hold
    expect(rowNames()).toEqual(['idle-three', 'idle-one', 'idle-two']);
  });

  it('re-arms the hold after a forced membership commit so it keeps holding mid-hover', () => {
    // Arrange
    usePaneStore.setState({ loaded: true, panes: [pane('a'), pane('b')] });
    render(<Sidebar />);
    const list = screen.getByTestId('sidebar-agent-list');
    fireEvent.pointerEnter(list);

    // Act — a new pane arrives mid-hover, forcing an immediate commit to [c, a, b]
    act(() => {
      usePaneStore.setState({ panes: [pane('a'), pane('b'), pane('c')] });
      seedActivity({ a: 'idle', b: 'idle', c: 'waiting' });
    });
    expect(rowNames()).toEqual(['c', 'a', 'b']);

    // Act — a second, membership-neutral status flip lands while still hovering
    act(() => {
      seedActivity({ a: 'idle', b: 'waiting', c: 'waiting' });
    });

    // Assert — the hold resumed from the just-committed order instead of staying
    // broken; without re-arming, a fresh (unheld) sort would read [b, c, a]
    expect(rowNames()).toEqual(['c', 'a', 'b']);
    expect(screen.getByRole('button', { name: 'b · Waiting for input' })).toBeTruthy();
  });

  it('resets the pointer-hold when the list swaps to the empty branch and back', () => {
    // Arrange
    usePaneStore.setState({ loaded: true, panes: [pane('idle-one'), pane('idle-two')] });
    render(<Sidebar />);
    fireEvent.pointerEnter(screen.getByTestId('sidebar-agent-list'));

    // Act — every pane disappears (the empty branch unmounts the list), then a
    // fresh set reappears without a pointerleave ever firing in between
    act(() => {
      usePaneStore.setState({ panes: [] });
    });
    act(() => {
      usePaneStore.setState({ panes: [pane('idle-one'), pane('idle-two')] });
      seedActivity({ 'idle-one': 'idle', 'idle-two': 'waiting' });
    });

    // Assert — the stale hold was cleared, so the fresh priority order applies
    expect(rowNames()).toEqual(['idle-two', 'idle-one']);
  });
});

describe('sidebar options menu', () => {
  const paneInitial = usePaneStore.getState();
  const uiInitial = useUiStore.getState();

  beforeEach(() => {
    settingsApi.updateElectronSetting.mockResolvedValue(null);
    usePaneStore.setState({ ...paneInitial, loaded: true, panes: [pane('a1')], selectedPaneId: null });
    useUiStore.setState({ ...uiInitial, sidebarCollapsed: false, sidebarOrganize: 'project', sidebarSort: 'priority' });
    seedActivity({ a1: 'idle' });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    usePaneStore.setState(paneInitial);
    useUiStore.setState(uiInitial);
    usePaneActivityStore.getState().reset();
  });

  it('exposes both preferences as radio groups with the current value checked', () => {
    // Arrange
    render(<Sidebar />);

    // Act
    openMenu();

    // Assert
    const menu = screen.getByRole('menu', { name: 'Sidebar options' });
    const radios = within(menu).getAllByRole('menuitemradio');
    expect(radios.map((item) => item.textContent?.trim())).toEqual([
      'By project',
      'In one list',
      'Priority',
      'Last active',
      'Creation order',
    ]);
    expect(radios.filter((item) => item.getAttribute('aria-checked') === 'true').map((i) => i.textContent?.trim()))
      .toEqual(['By project', 'Priority']);
    expect(within(menu).getAllByRole('group')).toHaveLength(2);
  });

  it('applies a choice immediately, persists it, and closes', async () => {
    // Arrange
    render(<Sidebar />);
    openMenu();

    // Act
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'In one list' }));

    // Assert
    expect(useUiStore.getState().sidebarOrganize).toBe('flat');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(settingsApi.updateElectronSetting).toHaveBeenCalledWith({ key: 'sidebarOrganize', value: 'flat' });
  });

  it('changes the sort preference from the second group', async () => {
    // Arrange
    render(<Sidebar />);
    openMenu();

    // Act
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Last active' }));

    // Assert
    expect(useUiStore.getState().sidebarSort).toBe('updated');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('has no serious a11y violations while open', async () => {
    // Arrange
    render(<Sidebar />);

    // Act
    openMenu();

    // Assert
    const results = await axe(document.body);
    const serious = (results.violations ?? []).filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => v.id)).toEqual([]);
  });
});


describe('sidebar re-render budget', () => {
  const paneInitial = usePaneStore.getState();
  const uiInitial = useUiStore.getState();

  beforeEach(() => {
    settingsApi.updateElectronSetting.mockResolvedValue(null);
    usePaneStore.setState({ ...paneInitial, loaded: true, panes: [pane('a1')], selectedPaneId: null });
    useUiStore.setState({ ...uiInitial, sidebarCollapsed: false });
    useAgentSessionStore.setState({ sessions: {} });
    seedActivity({ a1: 'idle' });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    usePaneStore.setState(paneInitial);
    useUiStore.setState(uiInitial);
    useAgentSessionStore.setState({ sessions: {} });
    usePaneActivityStore.getState().reset();
  });

  it('ignores raw session ticks and renders once per effective-status change', () => {
    // Arrange
    const onRender = vi.fn();
    render(
      <Profiler id="sidebar" onRender={onRender}>
        <Sidebar />
      </Profiler>,
    );
    // React settles one extra commit on the first update after mount; measure steady state.
    act(() => {
      useAgentSessionStore.setState({ sessions: { a1: session({ awaitingUserInput: true }) } });
    });
    onRender.mockClear();

    // Act — three raw pushes that leave every painted field alone
    act(() => {
      useAgentSessionStore.setState({ sessions: { a1: session({ awaitingUserInput: true, lastUpdateTime: 1 }) } });
      useAgentSessionStore.setState({ sessions: { a1: session({ awaitingUserInput: true, lastUpdateTime: 2 }) } });
      useAgentSessionStore.setState({ sessions: { a1: session({ awaitingUserInput: true, metrics: createEmptyMetrics() }) } });
    });

    // Assert — a raw tick never reaches the tree
    expect(onRender).not.toHaveBeenCalled();

    // Act — one push that actually moves the effective status
    act(() => {
      useAgentSessionStore.setState({ sessions: { a1: session({ turnCompleted: true }) } });
    });

    // Assert
    expect(onRender).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /waiting for input/ })).toBeNull();

    // Act — and back again
    onRender.mockClear();
    act(() => {
      useAgentSessionStore.setState({ sessions: { a1: session({ awaitingUserInput: true }) } });
    });

    // Assert
    expect(onRender).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '1 agent waiting for input' })).toBeTruthy();
  });
});
