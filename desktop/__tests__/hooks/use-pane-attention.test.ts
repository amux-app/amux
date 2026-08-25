// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { MuxBasePane } from 'muxbase/core';

const jumpToPaneRecord = vi.hoisted(() => vi.fn());

vi.mock('../../src/renderer/hooks/usePaneActions', () => ({
  jumpToPaneRecord,
}));

import { createEmptySession, type NormalizedSession } from '../../src/shared/agent-session-types';
import { getNextAttentionPaneId, usePaneAttention } from '../../src/renderer/hooks/usePaneAttention';
import type { PaneAttention } from '../../src/renderer/lib/pane-attention';
import { useAgentSessionStore } from '../../src/renderer/stores/agent-session.store';
import { usePaneActivityStore } from '../../src/renderer/stores/pane-activity.store';
import { usePaneStore } from '../../src/renderer/stores/pane.store';
import { useUiStore } from '../../src/renderer/stores/ui.store';
import { makeActivity as activity } from '../helpers/pane-activity-fixtures';

function makePane(id: string, overrides: Partial<MuxBasePane> = {}): MuxBasePane {
  return {
    id,
    slug: id,
    prompt: 'do something',
    paneId: `%${id}`,
    agentStatus: 'idle',
    ...overrides,
  };
}

function makeSession(overrides: Partial<NormalizedSession>): NormalizedSession {
  return { ...createEmptySession('claude', `session-${overrides.sessionId ?? '1'}`), ...overrides };
}

function waiting(paneId: string): PaneAttention {
  return { paneId, kind: 'waiting', reason: 'status' };
}

function ready(paneId: string): PaneAttention {
  return { paneId, kind: 'ready', reason: 'just-finished' };
}

function setPanes(panes: MuxBasePane[], selectedPaneId: string | null = null): void {
  usePaneStore.setState({ panes, selectedPaneId });
}

describe('getNextAttentionPaneId', () => {
  const paneOrder = ['p1', 'p2', 'p3', 'p4'];

  it('returns the first waiting pane in pane order when nothing is selected', () => {
    // Arrange
    const items = [waiting('p3'), waiting('p2')];

    // Act
    const next = getNextAttentionPaneId(items, paneOrder, null);

    // Assert
    expect(next).toBe('p2');
  });

  it('starts after the selected pane position', () => {
    // Arrange
    const items = [waiting('p1'), waiting('p4')];

    // Act
    const next = getNextAttentionPaneId(items, paneOrder, 'p2');

    // Assert
    expect(next).toBe('p4');
  });

  it('wraps once to the first waiting pane when none follows the selection', () => {
    // Arrange
    const items = [waiting('p1'), waiting('p2')];

    // Act
    const next = getNextAttentionPaneId(items, paneOrder, 'p3');

    // Assert
    expect(next).toBe('p1');
  });

  it('moves past a selected pane that is itself waiting', () => {
    // Arrange
    const items = [waiting('p2'), waiting('p4')];

    // Act
    const next = getNextAttentionPaneId(items, paneOrder, 'p2');

    // Assert
    expect(next).toBe('p4');
  });

  it('wraps back to the selected pane when it is the only waiting pane', () => {
    // Arrange
    const items = [waiting('p3')];

    // Act
    const next = getNextAttentionPaneId(items, paneOrder, 'p3');

    // Assert
    expect(next).toBe('p3');
  });

  it('never targets ready panes', () => {
    // Arrange
    const items = [ready('p1'), waiting('p3'), ready('p4')];

    // Act
    const next = getNextAttentionPaneId(items, paneOrder, 'p1');

    // Assert
    expect(next).toBe('p3');
  });

  it('returns null when only ready panes exist', () => {
    // Act
    const next = getNextAttentionPaneId([ready('p1'), ready('p2')], paneOrder, 'p1');

    // Assert
    expect(next).toBeNull();
  });

  it('returns null when nothing needs attention', () => {
    // Act
    const next = getNextAttentionPaneId([], paneOrder, 'p1');

    // Assert
    expect(next).toBeNull();
  });

  it('falls back to the first waiting pane when the selection is unknown', () => {
    // Act
    const next = getNextAttentionPaneId([waiting('p2')], paneOrder, 'gone');

    // Assert
    expect(next).toBe('p2');
  });
});

describe('usePaneAttention', () => {
  const uiInitial = useUiStore.getState();

  beforeEach(() => {
    vi.clearAllMocks();
    setPanes([]);
    useAgentSessionStore.setState({ sessions: {} });
    usePaneActivityStore.getState().reset();
    useUiStore.setState({ ...uiInitial, focusPaneId: null, viewMode: 'fleet' });
  });

  afterEach(() => {
    cleanup();
    useUiStore.setState(uiInitial);
  });

  it('derives waiting items in pane order with their reasons', () => {
    // Arrange
    setPanes([
      makePane('p1', { agentStatus: 'working' }),
      makePane('p2', { agentStatus: 'idle' }),
      makePane('p3', { agentStatus: 'waiting' }),
    ]);
    useAgentSessionStore.setState({
      sessions: { p2: makeSession({ awaitingUserInput: true }) },
    });

    // Act
    const { result } = renderHook(() => usePaneAttention());

    // Assert
    expect(result.current.waitingItems).toEqual([
      { paneId: 'p2', kind: 'waiting', reason: 'session-input' },
    ]);
    expect(result.current.waitingCount).toBe(1);
  });

  it('counts panes the agent session reports as awaiting input', () => {
    // Arrange
    setPanes([makePane('p1'), makePane('p2')]);
    useAgentSessionStore.setState({
      sessions: { p2: makeSession({ awaitingUserInput: true }) },
    });

    // Act
    const { result } = renderHook(() => usePaneAttention());

    // Assert
    expect(result.current.waitingItems).toEqual([
      { paneId: 'p2', kind: 'waiting', reason: 'session-input' },
    ]);
  });

  it('uses runtime activity over a stale waiting agentStatus to count attention', () => {
    // Arrange
    setPanes([makePane('p1', { agentStatus: 'waiting' })]);
    usePaneActivityStore.setState({ activityByPaneId: { p1: activity({ state: 'idle' }) } });

    // Act
    const { result } = renderHook(() => usePaneAttention());

    // Assert
    expect(result.current.waitingCount).toBe(0);
    expect(result.current.waitingItems).toEqual([]);
  });

  it('recounts when a session starts awaiting input after the first render', () => {
    // Arrange
    setPanes([makePane('p1'), makePane('p2')]);
    const { result } = renderHook(() => usePaneAttention());
    expect(result.current.waitingCount).toBe(0);

    // Act
    act(() => {
      useAgentSessionStore.setState({ sessions: { p2: makeSession({ awaitingUserInput: true }) } });
    });

    // Assert
    expect(result.current.waitingCount).toBe(1);
    expect(result.current.waitingItems.map((item) => item.paneId)).toEqual(['p2']);
  });

  it('excludes ready panes from the count and the items', () => {
    // Arrange
    setPanes([makePane('p1'), makePane('p2', { agentStatus: 'waiting' })]);
    usePaneActivityStore.setState({ justFinishedPaneIds: new Set(['p1']), activityByPaneId: { p2: activity({ state: 'waiting' }) } });

    // Act
    const { result } = renderHook(() => usePaneAttention());

    // Assert
    expect(result.current.waitingCount).toBe(1);
    expect(result.current.waitingItems.map((item) => item.paneId)).toEqual(['p2']);
  });

  it('keeps item order aligned with pane order across repeated status updates', () => {
    // Arrange
    setPanes([makePane('p1'), makePane('p2'), makePane('p3')]);
    const { result } = renderHook(() => usePaneAttention());

    // Act — activity deltas arrive out of pane order
    act(() => usePaneActivityStore.setState({ activityByPaneId: { p2: activity({ state: 'waiting' }) } }));
    act(() => usePaneActivityStore.setState({ activityByPaneId: { p1: activity({ state: 'waiting' }), p2: activity({ state: 'waiting' }) } }));
    act(() => usePaneActivityStore.setState({ activityByPaneId: { p1: activity({ state: 'waiting' }), p2: activity({ state: 'waiting' }), p3: activity({ state: 'waiting' }) } }));

    // Assert
    expect(result.current.waitingItems.map((item) => item.paneId)).toEqual(['p1', 'p2', 'p3']);
    expect(usePaneStore.getState().panes.map((pane) => pane.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('selects the next waiting pane and reuses the pane-jump path', () => {
    // Arrange
    setPanes(
      [
        makePane('p1', { agentStatus: 'waiting' }),
        makePane('p2'),
        makePane('p3', { agentStatus: 'waiting' }),
      ],
      'p1',
    );
    usePaneActivityStore.setState({ activityByPaneId: { p1: activity({ state: 'waiting' }), p3: activity({ state: 'waiting' }) } });
    const { result } = renderHook(() => usePaneAttention());

    // Act
    act(() => result.current.jumpToNextWaitingPane());

    // Assert
    expect(usePaneStore.getState().selectedPaneId).toBe('p3');
    expect(jumpToPaneRecord).toHaveBeenCalledWith(expect.objectContaining({ id: 'p3' }));
  });

  it('jumps the resolved pane even when its tmux id is not known yet', () => {
    // Arrange
    setPanes(
      [makePane('p1', { paneId: '' }), makePane('p2', { agentStatus: 'waiting', paneId: '' })],
      'p1',
    );
    usePaneActivityStore.setState({ activityByPaneId: { p2: activity({ state: 'waiting' }) } });
    const { result } = renderHook(() => usePaneAttention());

    // Act
    act(() => result.current.jumpToNextWaitingPane());

    // Assert
    expect(usePaneStore.getState().selectedPaneId).toBe('p2');
    expect(jumpToPaneRecord).toHaveBeenCalledWith(expect.objectContaining({ id: 'p2' }));
  });

  it('wraps to the first waiting pane after the last one', () => {
    // Arrange
    setPanes(
      [makePane('p1', { agentStatus: 'waiting' }), makePane('p2'), makePane('p3', { agentStatus: 'waiting' })],
      'p3',
    );
    usePaneActivityStore.setState({ activityByPaneId: { p1: activity({ state: 'waiting' }), p3: activity({ state: 'waiting' }) } });
    const { result } = renderHook(() => usePaneAttention());

    // Act
    act(() => result.current.jumpToNextWaitingPane());

    // Assert
    expect(usePaneStore.getState().selectedPaneId).toBe('p1');
    expect(jumpToPaneRecord).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
  });

  it('keeps the selection when the selected pane is the only waiting pane', () => {
    // Arrange
    setPanes([makePane('p1', { agentStatus: 'waiting' }), makePane('p2')], 'p1');
    usePaneActivityStore.setState({ activityByPaneId: { p1: activity({ state: 'waiting' }) } });
    const { result } = renderHook(() => usePaneAttention());

    // Act
    act(() => result.current.jumpToNextWaitingPane());

    // Assert
    expect(usePaneStore.getState().selectedPaneId).toBe('p1');
    expect(jumpToPaneRecord).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
  });

  it('moves the focused pane so the jump is visible in focus mode', () => {
    // Arrange
    setPanes([makePane('p1', { agentStatus: 'waiting' }), makePane('p2'), makePane('p3', { agentStatus: 'waiting' })], 'p1');
    usePaneActivityStore.setState({ activityByPaneId: { p1: activity({ state: 'waiting' }), p3: activity({ state: 'waiting' }) } });
    useUiStore.setState({ focusPaneId: 'p1', viewMode: 'focus' });
    const { result } = renderHook(() => usePaneAttention());

    // Act
    act(() => result.current.jumpToNextWaitingPane());

    // Assert
    expect(useUiStore.getState().focusPaneId).toBe('p3');
    expect(usePaneStore.getState().selectedPaneId).toBe('p3');
  });

  it('never forces focus mode when the fleet is on screen', () => {
    // Arrange
    setPanes([makePane('p1'), makePane('p2', { agentStatus: 'waiting' })], 'p1');
    usePaneActivityStore.setState({ activityByPaneId: { p2: activity({ state: 'waiting' }) } });
    const { result } = renderHook(() => usePaneAttention());

    // Act
    act(() => result.current.jumpToNextWaitingPane());

    // Assert
    expect(useUiStore.getState().viewMode).toBe('fleet');
    expect(useUiStore.getState().focusPaneId).toBeNull();
  });

  it('is a safe no-op when no pane is waiting', () => {
    // Arrange
    setPanes([makePane('p1'), makePane('p2')], 'p2');
    usePaneStore.setState({ justFinishedPaneIds: new Set(['p1']) });
    const { result } = renderHook(() => usePaneAttention());

    // Act
    act(() => result.current.jumpToNextWaitingPane());

    // Assert
    expect(result.current.waitingCount).toBe(0);
    expect(usePaneStore.getState().selectedPaneId).toBe('p2');
    expect(jumpToPaneRecord).not.toHaveBeenCalled();
  });
});
