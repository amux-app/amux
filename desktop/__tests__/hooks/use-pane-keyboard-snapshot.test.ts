// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { MuxBasePane } from 'muxbase/core';
import { usePaneKeyboardSnapshot, usePaneStore } from '../../src/renderer/stores/pane.store';

function makePane(overrides: Partial<MuxBasePane> = {}): MuxBasePane {
  return {
    id: 'muxbase-1',
    slug: 'test-pane',
    prompt: 'do something',
    paneId: '%1',
    ...overrides,
  };
}

function resetPaneStore(): void {
  usePaneStore.setState({
    panes: [],
    loaded: false,
    selectedPaneId: null,
    isCreating: false,
    pendingPane: null,
  });
}

describe('usePaneKeyboardSnapshot', () => {
  beforeEach(() => {
    resetPaneStore();
  });

  it('returns an empty snapshot when there are no panes', () => {
    // Arrange + Act
    const { result } = renderHook(() => usePaneKeyboardSnapshot());

    // Assert
    expect(result.current).toEqual({
      paneIds: [],
      selectedPaneId: null,
      selectedTmuxPaneId: null,
    });
  });

  it('exposes pane ids in store order', () => {
    // Arrange
    act(() => {
      usePaneStore.getState().setPanes([
        makePane({ id: 'p1' }),
        makePane({ id: 'p2' }),
        makePane({ id: 'p3' }),
      ]);
    });

    // Act
    const { result } = renderHook(() => usePaneKeyboardSnapshot());

    // Assert
    expect(result.current.paneIds).toEqual(['p1', 'p2', 'p3']);
  });

  it('resolves selectedTmuxPaneId from the currently selected pane', () => {
    // Arrange
    act(() => {
      usePaneStore.getState().setPanes([
        makePane({ id: 'p1', paneId: '%11' }),
        makePane({ id: 'p2', paneId: '%22' }),
      ]);
      usePaneStore.getState().selectPane('p2');
    });

    // Act
    const { result } = renderHook(() => usePaneKeyboardSnapshot());

    // Assert
    expect(result.current.selectedPaneId).toBe('p2');
    expect(result.current.selectedTmuxPaneId).toBe('%22');
  });

  it('keeps the paneIds reference stable when an unrelated field changes (useShallow guard)', () => {
    // This is the regression guard: usePaneKeyboardSnapshot must use a shallow
    // selector so a status tick on a pane does not produce a fresh paneIds
    // array and re-render every keyboard-shortcut consumer.

    // Arrange
    act(() => {
      usePaneStore.getState().setPanes([makePane({ id: 'p1' })]);
    });
    const { result, rerender } = renderHook(() => usePaneKeyboardSnapshot());
    const paneIdsBefore = result.current.paneIds;

    // Act — a status update replaces the panes array but not the set of ids
    act(() => {
      usePaneStore.getState().updatePaneStatus('p1', 'working');
    });
    rerender();

    // Assert — same reference, so shallow-equality holds and consumers are spared
    expect(result.current.paneIds).toBe(paneIdsBefore);
  });
});
