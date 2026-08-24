// @vitest-environment happy-dom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AumxPane } from 'aumx/core';

const paneApi = vi.hoisted(() => ({ createPane: vi.fn(), jumpToPane: vi.fn() }));

vi.mock('../src/renderer/api/pane.api', () => paneApi);

import { AttentionStat } from '../src/renderer/components/dashboard/AttentionStat';
import { ResourceBar } from '../src/renderer/components/dashboard/ResourceBar';
import { useAgentSessionStore } from '../src/renderer/stores/agent-session.store';
import { useCommandPaletteStore } from '../src/renderer/stores/command-palette.store';
import { useElectronSettingsStore } from '../src/renderer/stores/electron-settings.store';
import { usePaneStore } from '../src/renderer/stores/pane.store';
import { usePaneActivityStore } from '../src/renderer/stores/pane-activity.store';
import { useUiStore } from '../src/renderer/stores/ui.store';

const BANNED_PHRASE = 'Needs you';
const STAT_TEST_ID = 'resource-attention-stat';
const STATS_GROUP_TEST_ID = 'resource-bar-stats';
const ZEN_TEST_ID = 'zen-attention-stat';

function makePane(id: string, overrides: Partial<AumxPane> = {}): AumxPane {
  return {
    agentStatus: 'idle',
    id,
    paneId: `%${id}`,
    prompt: 'do something',
    slug: id,
    type: 'worktree',
    ...overrides,
  };
}

function baseFleet(waitingIds: string[]): AumxPane[] {
  return [
    makePane('p1', { agentStatus: 'working' }),
    makePane('p2', { agentStatus: waitingIds.includes('p2') ? 'waiting' : 'idle' }),
    makePane('p3', { type: 'shell' }),
  ];
}

function setPanes(panes: AumxPane[], selectedPaneId: string | null = null): void {
  usePaneStore.setState({ loaded: true, panes, selectedPaneId });
  usePaneActivityStore.setState({
    activityByPaneId: Object.fromEntries(panes.map((pane) => [pane.id, {
      activityRevision: 1,
      adapterHealth: 'degraded' as const,
      certainty: 'provisional' as const,
      liveness: 'unknown' as const,
      openBackgroundWork: [],
      origin: 'none' as const,
      paneIncarnationId: `${pane.id}-incarnation`,
      sinceWallMs: Date.now(),
      state: pane.agentStatus === 'waiting' ? 'waiting' : pane.agentStatus === 'working' ? 'working' : 'idle',
    }])),
  });
}

function statSpans(): HTMLElement[] {
  const bar = screen.getByTestId('resource-bar');
  const stats = screen.getByTestId(STATS_GROUP_TEST_ID);
  return [...Array.from(stats.children), ...Array.from(bar.children)].filter(
    (el): el is HTMLElement => el.tagName === 'SPAN',
  );
}

describe('ResourceBar attention stat', () => {
  const paneInitial = usePaneStore.getState();
  const settingsInitial = useElectronSettingsStore.getState();
  const uiInitial = useUiStore.getState();

  beforeEach(() => {
    paneApi.createPane.mockResolvedValue({ success: true });
    paneApi.jumpToPane.mockResolvedValue(undefined);
    useAgentSessionStore.setState({ sessions: {} });
    usePaneActivityStore.getState().reset();
    useCommandPaletteStore.setState({ isOpen: false });
    useUiStore.setState({ ...uiInitial, viewMode: 'fleet', zenMode: false });
    setPanes([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useCommandPaletteStore.setState({ isOpen: false });
    useElectronSettingsStore.setState(settingsInitial);
    usePaneStore.setState(paneInitial);
    useUiStore.setState(uiInitial);
  });

  it('renders nothing — not even a divider — when no agent is waiting', () => {
    // Arrange
    setPanes(baseFleet([]));

    // Act
    render(<ResourceBar />);

    // Assert
    expect(screen.queryByTestId(STAT_TEST_ID)).toBeNull();
    expect(statSpans()).toHaveLength(5);
    expect(statSpans().map((span) => span.textContent)).toEqual([
      '3 panes',
      '|',
      '2 worktrees',
      '|',
      '1 active',
    ]);
  });

  it('appends the waiting term after "active" with the same divider treatment', () => {
    // Arrange
    setPanes(baseFleet(['p2']));

    // Act
    render(<ResourceBar />);

    // Assert
    const spans = statSpans();
    expect(spans.map((span) => span.textContent)).toEqual([
      '3 panes',
      '|',
      '2 worktrees',
      '|',
      '1 active',
      '|',
      '1 waiting',
    ]);
    expect(spans[5].className).toBe(spans[1].className);
  });

  it('never branches the noun and caps the numeral at 99+', () => {
    // Arrange
    const cases: Array<[number, string]> = [[1, '1 waiting'], [2, '2 waiting'], [150, '99+ waiting']];

    for (const [count, expected] of cases) {
      // Act
      setPanes(Array.from({ length: count }, (_unused, i) => makePane(`w${i}`, { agentStatus: 'waiting' })));
      render(<ResourceBar />);

      // Assert
      expect(screen.getByTestId(STAT_TEST_ID).textContent).toBe(expected);
      cleanup();
    }
  });

  it('names the stat after the peek it opens, not the jump the Zen numeral performs', () => {
    // Arrange
    setPanes(baseFleet(['p2']));

    // Act
    render(<ResourceBar />);

    // Assert
    const button = screen.getByRole('button', { name: '1 agents waiting for input. Open waiting agents.' });
    expect(button).toBe(screen.getByTestId(STAT_TEST_ID));
    expect(button.getAttribute('type')).toBe('button');
    expect(button.className).toContain('[-webkit-app-region:no-drag]');
    expect(button.className).toContain('cursor-pointer');
    expect(button.className).toContain('hover:underline');
    expect(button.className).toContain('focus-visible:ring-2');
  });

  it('paints the waiting term with the attention token while siblings stay on the bar tone', () => {
    // Arrange
    setPanes(baseFleet(['p2']));

    // Act
    render(<ResourceBar />);

    // Assert
    expect(screen.getByTestId(STAT_TEST_ID).className).toContain('text-[var(--attention-waiting-text)]');
    expect(screen.getByTestId('resource-bar').className).toContain('text-[var(--text-secondary)]');
    for (const index of [0, 2]) {
      expect(statSpans()[index].className).toBe('[-webkit-app-region:no-drag]');
    }
    expect(statSpans()[4].className).toContain('[-webkit-app-region:no-drag]');
  });

  it('reflows before clipping labels while every action stays whole', () => {
    // Arrange
    setPanes(baseFleet(['p2']));

    // Act
    render(<ResourceBar />);

    // Assert
    const bar = screen.getByTestId('resource-bar');
    const stats = screen.getByTestId(STATS_GROUP_TEST_ID);
    const actions = screen.getByTestId('resource-command-palette').closest('div.ml-auto');
    for (const token of ['min-h-6', 'shrink-0', 'whitespace-nowrap']) {
      expect(stats.className).toContain(token);
    }
    expect(stats.className).not.toContain('overflow-hidden');
    expect(stats.lastElementChild!.className).not.toContain('truncate');
    expect(bar.className).toContain('flex-wrap');
    expect(bar.className).not.toContain('whitespace-nowrap');
    expect(bar.className).toContain('[-webkit-app-region:drag]');
    expect(actions?.className).toContain('shrink-0');
    expect(stats.contains(screen.getByTestId(STAT_TEST_ID))).toBe(false);
    expect(stats.contains(actions)).toBe(false);
    expect(stats.contains(screen.getByTestId('resource-new-pane'))).toBe(false);
  });

  it('carries no pill, dot, icon, border, fill or animation chrome', () => {
    // Arrange
    setPanes(baseFleet(['p2']));

    // Act
    render(<ResourceBar />);

    // Assert
    const button = screen.getByTestId(STAT_TEST_ID);
    for (const chrome of ['bg-', 'border', 'shadow', 'animate-', 'rounded-full', 'w-[', 'min-w-']) {
      expect(button.className).not.toContain(chrome);
    }
    expect(button.querySelector('svg')).toBeNull();
  });

  it('shows the shortcut only in the tooltip', () => {
    // Arrange
    setPanes(baseFleet(['p2']));
    render(<ResourceBar />);
    const button = screen.getByTestId(STAT_TEST_ID);

    // Act
    fireEvent.mouseEnter(button.parentElement!);

    // Assert
    expect(screen.getByRole('tooltip').textContent).toBe('1 agents waiting for input · ⌘⇧J');
    expect(button.textContent).toBe('1 waiting');
  });

  it('clicking the stat opens the peek instead of navigating', () => {
    // Arrange
    setPanes(baseFleet(['p2']));
    render(<ResourceBar />);

    // Act
    fireEvent.click(screen.getByTestId(STAT_TEST_ID));

    // Assert
    expect(screen.getByRole('menu', { name: 'Waiting agents' })).not.toBeNull();
    expect(usePaneStore.getState().selectedPaneId).toBeNull();
    expect(paneApi.jumpToPane).not.toHaveBeenCalled();
  });

  it('opens the command palette from the quiet ⌘K door', () => {
    // Arrange
    render(<ResourceBar />);
    const button = screen.getByTestId('resource-command-palette');

    // Act
    fireEvent.click(button);

    // Assert
    expect(button.textContent).toBe('⌘K');
    expect(button.getAttribute('aria-label')).toBe('Open command palette (⌘K)');
    expect(useCommandPaletteStore.getState().isOpen).toBe(true);
  });

  it('renders a bare numeral with the full accessible name in the Zen variant', () => {
    // Arrange
    setPanes(baseFleet(['p2']));

    // Act
    render(<AttentionStat variant="zen" />);

    // Assert
    const button = screen.getByTestId(ZEN_TEST_ID);
    expect(button.textContent).toBe('1');
    expect(button.getAttribute('aria-label')).toBe('1 agents waiting for input. Jump to next.');
    expect(button.className).toContain('h-6');
    expect(button.className).toContain('min-w-6');
    expect(screen.queryByText('|')).toBeNull();
  });

  it('renders no Zen numeral and no divider when nothing is waiting', () => {
    // Arrange
    setPanes(baseFleet([]));

    // Act
    const { container } = render(<AttentionStat variant="zen" />);

    // Assert
    expect(container.innerHTML).toBe('');
  });

  it('jumps from the Zen numeral through the same action', () => {
    // Arrange
    setPanes(baseFleet(['p2']));
    render(<AttentionStat variant="zen" />);

    // Act
    fireEvent.click(screen.getByTestId(ZEN_TEST_ID));

    // Assert
    expect(usePaneStore.getState().selectedPaneId).toBe('p2');
    expect(paneApi.jumpToPane).toHaveBeenCalledWith({ paneId: 'p2' });
  });

  it('never renders the phrase "Needs you"', () => {
    // Arrange
    setPanes(baseFleet(['p2']));

    // Act
    render(<ResourceBar />);
    fireEvent.mouseEnter(screen.getByTestId(STAT_TEST_ID).parentElement!);

    // Assert
    expect(document.body.textContent).not.toContain(BANNED_PHRASE);
    const labelled = Array.from(document.body.querySelectorAll('[aria-label]'));
    expect(labelled.some((el) => el.getAttribute('aria-label')?.includes(BANNED_PHRASE))).toBe(false);
  });
});
