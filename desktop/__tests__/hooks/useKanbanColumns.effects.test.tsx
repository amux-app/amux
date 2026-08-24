// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import type { AumxPane } from 'aumx/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useKanbanColumns } from '../../src/renderer/hooks/useKanbanColumns';
import { usePaneStore } from '../../src/renderer/stores/pane.store';
import { usePaneActivityStore } from '../../src/renderer/stores/pane-activity.store';
import { useAgentSessionStore } from '../../src/renderer/stores/agent-session.store';
import { useDirtyMapStore } from '../../src/renderer/stores/worktree-dirty.store';
import { useColumnOverrideStore } from '../../src/renderer/stores/column-override.store';
import { makeActivity } from '../helpers/pane-activity-fixtures';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/api/ipc', () => ({ invoke: invokeMock }));

function pane(overrides: Partial<AumxPane> = {}): AumxPane {
  return {
    id: 'pane-1',
    paneId: '%1',
    prompt: 'task',
    slug: 'task',
    worktreePath: '/repo/wt',
    ...overrides,
  };
}

describe('useKanbanColumns effects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockResolvedValue({ hasChanges: false });
    usePaneStore.setState({ panes: [] });
    usePaneActivityStore.getState().reset();
    useAgentSessionStore.setState({ sessions: {} });
    useDirtyMapStore.getState().clear();
    useColumnOverrideStore.setState({ overrides: {} });
  });

  afterEach(() => cleanup());

  it('does not duplicate a dirty check while the same pane is pending', async () => {
    let release!: (value: { hasChanges: boolean }) => void;
    invokeMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    usePaneStore.setState({ panes: [pane()] });
    usePaneActivityStore.setState({
      activityByPaneId: { 'pane-1': makeActivity({ state: 'idle' }) },
    });
    renderHook(() => useKanbanColumns());
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledOnce());
    act(() => {
      usePaneActivityStore.setState({
        activityByPaneId: {
          'pane-1': makeActivity({ state: 'idle', activityRevision: 2 }),
        },
      });
    });
    expect(invokeMock).toHaveBeenCalledOnce();
    release({ hasChanges: true });
    await vi.waitFor(() => expect(useDirtyMapStore.getState().dirtyMap['pane-1']).toBe(true));
  });

  it('settles a failed Git status check to a safe clean state', async () => {
    invokeMock.mockRejectedValue(new Error('git unavailable'));
    usePaneStore.setState({ panes: [pane()] });
    usePaneActivityStore.setState({
      activityByPaneId: { 'pane-1': makeActivity({ state: 'idle' }) },
    });
    renderHook(() => useKanbanColumns());
    await vi.waitFor(() => expect(useDirtyMapStore.getState().dirtyMap['pane-1']).toBe(false));
  });

  it('prunes removed panes from dirty and column-override state', async () => {
    useDirtyMapStore.getState().setDirty('removed', true);
    useColumnOverrideStore.getState().set('removed', 'done');
    renderHook(() => useKanbanColumns());
    await vi.waitFor(() => {
      expect(useDirtyMapStore.getState().dirtyMap).toEqual({});
      expect(useColumnOverrideStore.getState().overrides).toEqual({});
    });
  });

  it('removes an override once the natural column catches up', async () => {
    const current = pane({ id: 'pane-1' });
    useColumnOverrideStore.getState().set('pane-1', 'needs-attention');
    usePaneStore.setState({ panes: [current] });
    usePaneActivityStore.setState({
      activityByPaneId: { 'pane-1': makeActivity({ state: 'waiting' }) },
    });
    renderHook(() => useKanbanColumns());
    await vi.waitFor(() => expect(useColumnOverrideStore.getState().overrides).toEqual({}));
  });

  it('rechecks a clean worktree when its pane state changes while idle', async () => {
    usePaneStore.setState({ panes: [pane()] });
    usePaneActivityStore.setState({
      activityByPaneId: { 'pane-1': makeActivity({ state: 'idle' }) },
    });
    renderHook(() => useKanbanColumns());
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(useDirtyMapStore.getState().dirtyMap['pane-1']).toBe(false));
    act(() =>
      useAgentSessionStore.setState({
        sessions: { 'pane-1': { lastUpdateTime: Date.now() + 1 } as never },
      }),
    );
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
  });
});
