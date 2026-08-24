// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react';
import type { AumxPane } from 'aumx/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePaneEffectiveStatus } from '../../src/renderer/hooks/usePaneEffectiveStatus';
import { useAgentSessionStore } from '../../src/renderer/stores/agent-session.store';
import { usePaneActivityStore } from '../../src/renderer/stores/pane-activity.store';
import { makeActivity as activity } from '../helpers/pane-activity-fixtures';

function pane(overrides: Partial<AumxPane> = {}): AumxPane {
  return {
    id: 'p1',
    paneId: '%1',
    prompt: 'do the thing',
    slug: 'p1',
    ...overrides,
  };
}

beforeEach(() => {
  useAgentSessionStore.setState({ sessions: {} });
  usePaneActivityStore.getState().reset();
});

afterEach(() => cleanup());

describe('usePaneEffectiveStatus', () => {
  it('returns unknown for a missing pane without reading any store', () => {
    const { result } = renderHook(() => usePaneEffectiveStatus(null));
    expect(result.current).toBe('unknown');
  });

  it('prefers runtime activity over a stale legacy agentStatus', () => {
    usePaneActivityStore.setState({ activityByPaneId: { p1: activity({ state: 'working' }) } });

    const { result } = renderHook(() => usePaneEffectiveStatus(pane({ agentStatus: 'idle' })));

    expect(result.current).toBe('working');
  });

  it('does not fall back to legacy agentStatus while no activity is known yet', () => {
    const { result } = renderHook(() => usePaneEffectiveStatus(pane({ agentStatus: 'working' })));

    expect(result.current).toBe('unknown');
  });
});
