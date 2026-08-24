// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import type { AumxPane } from 'aumx/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCommandPalette } from '../../src/renderer/hooks/useCommandPalette';
import { useCommandPaletteStore, usePaneActivityStore, usePaneStore } from '../../src/renderer/stores';
import { makeActivity as activity } from '../helpers/pane-activity-fixtures';

vi.mock('../../src/renderer/api/agent-session.api', () => ({
  searchSessions: vi.fn(),
}));

vi.mock('../../src/renderer/api/system.api', () => ({
  searchProjectFiles: vi.fn(),
  searchProjectText: vi.fn(),
}));

function pane(overrides: Partial<AumxPane> = {}): AumxPane {
  return {
    id: 'p1',
    paneId: '%1',
    prompt: 'do the thing',
    slug: 'p1',
    ...overrides,
  };
}

describe('useCommandPalette filteredPanes status', () => {
  beforeEach(() => {
    useCommandPaletteStore.setState({ activeTab: 'panes', isOpen: true, search: '' });
    usePaneStore.setState({ panes: [pane({ agentStatus: 'waiting' })], selectedPaneId: null });
  });

  afterEach(() => {
    cleanup();
    usePaneActivityStore.getState().reset();
  });

  it('prefers runtime activity over a stale legacy agentStatus', () => {
    // Arrange
    usePaneActivityStore.setState({ activityByPaneId: { p1: activity({ state: 'idle' }) } });

    // Act
    const { result } = renderHook(() => useCommandPalette());

    // Assert
    expect(result.current.filteredPanes).toEqual([
      { id: 'p1', slug: 'p1', agent: undefined, status: 'idle' },
    ]);
  });

  it('returns unknown while no activity is known yet', () => {
    // Act
    const { result } = renderHook(() => useCommandPalette());

    // Assert
    expect(result.current.filteredPanes).toEqual([
      { id: 'p1', slug: 'p1', agent: undefined, status: 'unknown' },
    ]);
  });

  it('ignores activity changes while closed, then reflects current activity once opened', () => {
    // Arrange
    useCommandPaletteStore.setState({ activeTab: 'all', isOpen: false, search: '' });
    const { result } = renderHook(() => useCommandPalette());
    const closedFilteredPanes = result.current.filteredPanes;

    // Act
    act(() => {
      usePaneActivityStore.setState({ activityByPaneId: { p1: activity({ state: 'idle' }) } });
    });

    // Assert: unchanged while closed — same reference, still unknown.
    expect(result.current.filteredPanes).toBe(closedFilteredPanes);
    expect(result.current.filteredPanes).toEqual([
      { id: 'p1', slug: 'p1', agent: undefined, status: 'unknown' },
    ]);

    // Act
    act(() => {
      useCommandPaletteStore.setState({ isOpen: true });
    });

    // Assert: picks up the current activity once opened
    expect(result.current.filteredPanes).toEqual([
      { id: 'p1', slug: 'p1', agent: undefined, status: 'idle' },
    ]);
  });
});
