// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import type { AumxPane } from 'aumx/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyMetrics, type NormalizedSession } from '../src/shared/agent-session-types';
import { useSidebarSession } from '../src/renderer/hooks/useSidebarSession';
import { useAgentSessionStore } from '../src/renderer/stores/agent-session.store';
import { usePaneActivityStore } from '../src/renderer/stores/pane-activity.store';
import { makeActivity as activity } from './helpers/pane-activity-fixtures';

function pane(id: string, overrides: Partial<AumxPane> = {}): AumxPane {
  return {
    agent: 'claude',
    agentStatus: 'idle',
    id,
    paneId: `%${id}`,
    projectRoot: '/work/alpha',
    prompt: 'do the thing',
    slug: id,
    type: 'worktree',
    ...overrides,
  };
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

afterEach(() => {
  cleanup();
  useAgentSessionStore.setState({ sessions: {} });
  usePaneActivityStore.getState().reset();
});

describe('useSidebarSession status entry reuse', () => {
  it('reuses the same status object reference across renders when its pane is unaffected', () => {
    // Arrange
    const panes = [pane('a'), pane('b')];
    const { result, rerender } = renderHook(({ panes: p }) => useSidebarSession(p), {
      initialProps: { panes },
    });
    const firstA = result.current.statusOf.get('a');

    // Act — an unrelated pane's session changes; "a" isn't affected
    act(() => {
      useAgentSessionStore.setState({ sessions: { b: session({ awaitingUserInput: true }) } });
    });
    rerender({ panes });

    // Assert
    expect(result.current.statusOf.get('a')).toBe(firstA);
  });

  it('produces a new status object reference only for the pane whose encoding changed', () => {
    // Arrange
    const panes = [pane('a')];
    const { result, rerender } = renderHook(({ panes: p }) => useSidebarSession(p), {
      initialProps: { panes },
    });
    const before = result.current.statusOf.get('a');

    // Act
    act(() => {
      useAgentSessionStore.setState({ sessions: { a: session({ awaitingUserInput: true }) } });
    });
    rerender({ panes });

    // Assert
    expect(result.current.statusOf.get('a')).not.toBe(before);
    expect(result.current.statusOf.get('a')?.waiting).toBe(true);
  });

  it('drops cache entries for panes that are no longer present', () => {
    // Arrange
    const { result, rerender } = renderHook(({ panes: p }) => useSidebarSession(p), {
      initialProps: { panes: [pane('a'), pane('b')] },
    });
    expect(result.current.statusOf.has('b')).toBe(true);

    // Act
    rerender({ panes: [pane('a')] });

    // Assert
    expect(result.current.statusOf.has('b')).toBe(false);
  });
});

describe('useSidebarSession activity precedence', () => {
  it('prefers runtime activity over a stale legacy agentStatus', () => {
    // Arrange
    const panes = [pane('a', { agentStatus: 'waiting' })];
    usePaneActivityStore.setState({ activityByPaneId: { a: activity({ state: 'idle' }) } });

    // Act
    const { result } = renderHook(({ panes: p }) => useSidebarSession(p), {
      initialProps: { panes },
    });

    // Assert
    expect(result.current.statusOf.get('a')).toEqual({ status: 'idle', waiting: false });
  });

  it('updates status when activity changes with no session-store change', () => {
    // Arrange
    const panes = [pane('a', { agentStatus: 'idle' })];
    const { result, rerender } = renderHook(({ panes: p }) => useSidebarSession(p), {
      initialProps: { panes },
    });
    expect(result.current.statusOf.get('a')?.status).toBe('unknown');

    // Act
    act(() => {
      usePaneActivityStore.setState({ activityByPaneId: { a: activity({ state: 'working' }) } });
    });
    rerender({ panes });

    // Assert
    expect(result.current.statusOf.get('a')?.status).toBe('working');
  });
});
