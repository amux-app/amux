// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AumxPane } from 'aumx/core';

const paneApi = vi.hoisted(() => ({ createPane: vi.fn(), jumpToPane: vi.fn() }));

vi.mock('../src/renderer/api/pane.api', () => paneApi);

import { AttentionStat } from '../src/renderer/components/dashboard/AttentionStat';
import { ResourceBar } from '../src/renderer/components/dashboard/ResourceBar';
import type { PaneAttentionReason } from '../src/renderer/lib/pane-attention';
import { createEmptySession, type NormalizedSession } from '../src/shared/agent-session-types';
import { useAgentSessionStore } from '../src/renderer/stores/agent-session.store';
import { useCommandPaletteStore } from '../src/renderer/stores/command-palette.store';
import { usePaneStore } from '../src/renderer/stores/pane.store';
import { usePaneActivityStore } from '../src/renderer/stores/pane-activity.store';
import { useUiStore } from '../src/renderer/stores/ui.store';

const MORE_TEST_ID = 'attention-peek-more';
const PEEK_LABEL = 'Waiting agents';
const ROW_TEST_ID = 'attention-peek-row';
const STAT_TEST_ID = 'resource-attention-stat';
const TOOLTIP_DELAY_MS = 200;

function makePane(id: string, overrides: Partial<AumxPane> = {}): AumxPane {
  return {
    agentStatus: 'idle',
    id,
    paneId: `%${id}`,
    prompt: 'do something',
    slug: id,
    title: `Pane ${id}`,
    type: 'worktree',
    ...overrides,
  };
}

function makeSession(overrides: Partial<NormalizedSession>): NormalizedSession {
  return { ...createEmptySession('claude', 'session-1'), ...overrides };
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

function waitingPanes(count: number): AumxPane[] {
  return Array.from({ length: count }, (_unused, index) => makePane(`w${index + 1}`, { agentStatus: 'waiting' }));
}

function stat(): HTMLElement {
  return screen.getByTestId(STAT_TEST_ID);
}

function peek(): HTMLElement | null {
  return screen.queryByRole('menu', { name: PEEK_LABEL });
}

function rowTexts(): string[] {
  return screen.getAllByTestId(ROW_TEST_ID).map((row) => row.textContent ?? '');
}

function openPeek(): void {
  fireEvent.click(stat());
}

let paneRenderCount = 0;

function PaneProbe() {
  const panes = usePaneStore((s) => s.panes);
  paneRenderCount += 1;
  return <div data-testid="pane-probe">{panes.length}</div>;
}

function renderBar() {
  return render(
    <>
      <ResourceBar />
      <PaneProbe />
    </>,
  );
}

describe('AttentionPeek', () => {
  const paneInitial = usePaneStore.getState();
  const uiInitial = useUiStore.getState();

  beforeEach(() => {
    vi.useRealTimers();
    paneApi.jumpToPane.mockResolvedValue(undefined);
    paneRenderCount = 0;
    useAgentSessionStore.setState({ sessions: {} });
    usePaneActivityStore.getState().reset();
    useCommandPaletteStore.setState({ activeTab: 'all', isOpen: false });
    useUiStore.setState({ ...uiInitial, viewMode: 'fleet', zenMode: false });
    setPanes([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useCommandPaletteStore.setState({ activeTab: 'all', isOpen: false });
    usePaneStore.setState(paneInitial);
    useUiStore.setState(uiInitial);
  });

  describe('opening', () => {
    it('never opens on hover, even after the tooltip has appeared', async () => {
      // Arrange
      setPanes(waitingPanes(2));
      renderBar();

      // Act
      fireEvent.pointerEnter(stat().parentElement!);
      fireEvent.mouseEnter(stat().parentElement!);
      await act(() => new Promise((resolve) => setTimeout(resolve, TOOLTIP_DELAY_MS)));

      // Assert
      expect(screen.getByRole('tooltip')).not.toBeNull();
      expect(peek()).toBeNull();
      expect(screen.queryAllByTestId(ROW_TEST_ID)).toHaveLength(0);
    });

    it('opens on click and closes again on a second click', () => {
      // Arrange
      setPanes(waitingPanes(2));
      renderBar();

      // Act
      openPeek();

      // Assert
      expect(peek()).not.toBeNull();
      expect(stat().getAttribute('aria-expanded')).toBe('true');
      expect(stat().getAttribute('aria-haspopup')).toBe('menu');

      // Act
      fireEvent.click(stat());

      // Assert
      expect(peek()).toBeNull();
      expect(stat().getAttribute('aria-expanded')).toBe('false');
    });

    it('opens from the keyboard with Enter and with Space', () => {
      // Arrange — a native button is what turns both keys into a click
      setPanes(waitingPanes(2));
      renderBar();
      expect(stat().tagName).toBe('BUTTON');
      expect(stat().getAttribute('type')).toBe('button');

      for (const key of ['Enter', ' ']) {
        // Act
        stat().focus();
        fireEvent.keyDown(stat(), { key });
        fireEvent.click(stat());

        // Assert
        expect(peek(), key).not.toBeNull();
        fireEvent.keyDown(peek()!, { key: 'Escape' });
        expect(peek(), key).toBeNull();
      }
    });

    it('keeps the Zen numeral on the direct jump with no peek', () => {
      // Arrange
      setPanes(waitingPanes(2), 'w1');
      render(<AttentionStat variant="zen" />);

      // Act
      fireEvent.click(screen.getByTestId('zen-attention-stat'));

      // Assert
      expect(peek()).toBeNull();
      expect(usePaneStore.getState().selectedPaneId).toBe('w2');
    });
  });

  describe('rows', () => {
    it('shows every waiting pane up to three rows without an overflow row', () => {
      // Arrange
      setPanes(waitingPanes(3));
      renderBar();

      // Act
      openPeek();

      // Assert
      expect(screen.getAllByTestId(ROW_TEST_ID)).toHaveLength(3);
      expect(screen.queryByTestId(MORE_TEST_ID)).toBeNull();
    });

    it('replaces the third row with the remaining count past three waiting panes', () => {
      // Arrange
      setPanes(waitingPanes(4));
      renderBar();

      // Act
      openPeek();

      // Assert
      expect(screen.getAllByTestId(ROW_TEST_ID)).toHaveLength(2);
      expect(screen.getByTestId(MORE_TEST_ID).textContent).toBe('+2 more');
      expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    });

    it('counts every hidden pane in the overflow row for a large fleet', () => {
      // Arrange
      setPanes(waitingPanes(9));
      renderBar();

      // Act
      openPeek();

      // Assert
      expect(screen.getByTestId(MORE_TEST_ID).textContent).toBe('+7 more');
    });

    it('keeps rows in pane order when statuses arrive shuffled', () => {
      // Arrange
      setPanes([makePane('p1'), makePane('p2'), makePane('p3')]);
      renderBar();
      act(() => usePaneStore.getState().updatePaneStatus('p3', 'waiting'));
      act(() => usePaneStore.getState().updatePaneStatus('p1', 'waiting'));
      act(() => usePaneStore.getState().updatePaneStatus('p2', 'waiting'));

      // Act
      openPeek();

      // Assert
      expect(rowTexts()).toEqual([
        'Pane p1Waiting · asked a question',
        'Pane p2Waiting · asked a question',
        'Pane p3Waiting · asked a question',
      ]);
    });

    it('renders the state word and the reason phrase for every reason', () => {
      // Arrange
      const cases: Array<[Partial<AumxPane>, Partial<NormalizedSession> | null, PaneAttentionReason, string]> = [
        [{}, { awaitingUserInput: true }, 'session-input', 'Waiting · needs input'],
        [{}, { pendingUserQuestion: 'Which one?' }, 'session-question', 'Waiting · asked a question'],
      ];

      for (const [paneOverrides, session, reason, expected] of cases) {
        // Act
        setPanes([makePane('p1', paneOverrides)]);
        useAgentSessionStore.setState({ sessions: session ? { p1: makeSession(session) } : {} });
        renderBar();
        openPeek();

        // Assert
        expect(screen.getByTestId(ROW_TEST_ID).textContent, reason).toContain(expected);
        cleanup();
      }
    });

    it('renders a muted elapsed time from the session and omits it when there is none', () => {
      // Arrange
      setPanes([makePane('p1', { agentStatus: 'waiting' }), makePane('p2', { agentStatus: 'waiting' })]);
      useAgentSessionStore.setState({
        sessions: { p1: makeSession({ lastUpdateTime: Date.now() - 4 * 60_000 }) },
      });
      renderBar();

      // Act
      openPeek();

      // Assert
      const [withSession, withoutSession] = screen.getAllByTestId(ROW_TEST_ID);
      expect(withSession.textContent).toContain('4m ago');
      expect(withoutSession.textContent).toBe('Pane p2Waiting · asked a question');
    });

    it('never leaks the banned phrase into the peek', () => {
      // Arrange
      setPanes(waitingPanes(4));
      renderBar();

      // Act
      openPeek();

      // Assert
      expect(document.body.textContent).not.toContain('Needs you');
      expect(stat().textContent).toBe('4 waiting');
    });
  });

  describe('selection', () => {
    it('sends a clicked row through the shared jump path', () => {
      // Arrange
      setPanes(waitingPanes(3));
      renderBar();
      openPeek();

      // Act
      fireEvent.click(screen.getAllByTestId(ROW_TEST_ID)[1]);

      // Assert
      expect(usePaneStore.getState().selectedPaneId).toBe('w2');
      expect(paneApi.jumpToPane).toHaveBeenCalledWith({ paneId: 'w2' });
      expect(peek()).toBeNull();
    });

    it('selects the arrowed-to row with Enter', () => {
      // Arrange
      setPanes(waitingPanes(3));
      renderBar();
      openPeek();

      // Act
      fireEvent.keyDown(peek()!, { key: 'ArrowDown' });
      fireEvent.keyDown(document.activeElement!, { key: 'Enter' });

      // Assert
      expect(usePaneStore.getState().selectedPaneId).toBe('w2');
      expect(paneApi.jumpToPane).toHaveBeenCalledWith({ paneId: 'w2' });
    });

    it('hands a long queue to the command palette on the panes tab', () => {
      // Arrange
      setPanes(waitingPanes(4));
      renderBar();
      openPeek();

      // Act
      fireEvent.click(screen.getByTestId(MORE_TEST_ID));

      // Assert
      expect(useCommandPaletteStore.getState().isOpen).toBe(true);
      expect(useCommandPaletteStore.getState().activeTab).toBe('panes');
      expect(peek()).toBeNull();
      expect(paneApi.jumpToPane).not.toHaveBeenCalled();
    });
  });

  describe('dismissal', () => {
    it('closes on Escape and returns focus to the stat', () => {
      // Arrange
      setPanes(waitingPanes(2));
      renderBar();
      openPeek();
      expect(document.activeElement).toBe(screen.getAllByTestId(ROW_TEST_ID)[0]);

      // Act
      fireEvent.keyDown(peek()!, { key: 'Escape' });

      // Assert
      expect(peek()).toBeNull();
      expect(document.activeElement).toBe(stat());
    });

    it('closes on an outside pointer down', () => {
      // Arrange
      setPanes(waitingPanes(2));
      renderBar();
      openPeek();

      // Act
      fireEvent.pointerDown(document.body);

      // Assert
      expect(peek()).toBeNull();
    });

    it('leaves no residual node behind once closed', () => {
      // Arrange
      setPanes(waitingPanes(4));
      const { container } = renderBar();
      openPeek();

      // Act
      fireEvent.keyDown(peek()!, { key: 'Escape' });

      // Assert
      expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
      expect(document.body.querySelectorAll('[role="menu"]')).toHaveLength(0);
      expect(container.querySelector(`[data-testid="${ROW_TEST_ID}"]`)).toBeNull();
    });
  });

  describe('interplay', () => {
    it('drops the hover tooltip the moment the peek opens and keeps it away', () => {
      // Arrange
      setPanes(waitingPanes(2));
      renderBar();
      const anchor = stat().parentElement!;
      fireEvent.mouseEnter(anchor);
      expect(screen.getByRole('tooltip').textContent).toBe('2 agents waiting for input · ⌘⇧J');

      // Act
      openPeek();

      // Assert
      expect(screen.queryByRole('tooltip')).toBeNull();
      expect(peek()).not.toBeNull();

      // Act — a fresh hover while the peek is open must not bring it back
      fireEvent.mouseLeave(anchor);
      fireEvent.mouseEnter(anchor);

      // Assert
      expect(screen.queryByRole('tooltip')).toBeNull();

      // Act
      fireEvent.keyDown(peek()!, { key: 'Escape' });
      fireEvent.mouseEnter(anchor);

      // Assert
      expect(screen.getByRole('tooltip')).not.toBeNull();
    });

    it('opens without re-rendering pane consumers', () => {
      // Arrange
      setPanes(waitingPanes(2));
      renderBar();
      const probe = screen.getByTestId('pane-probe');
      const rendersBefore = paneRenderCount;

      // Act
      openPeek();

      // Assert
      expect(paneRenderCount).toBe(rendersBefore);
      expect(screen.getByTestId('pane-probe')).toBe(probe);
    });
  });
});
