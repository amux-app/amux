import { describe, it, expect, beforeEach } from 'vitest';
import { usePaneStore } from '../../src/renderer/stores/pane.store';
import type { AumxPane } from 'aumx/core';

function makePane(overrides: Partial<AumxPane> = {}): AumxPane {
  return {
    id: `aumx-${Math.random().toString(36).slice(2, 6)}`,
    slug: 'test-pane',
    prompt: 'do something',
    paneId: '%1',
    ...overrides,
  };
}

describe('usePaneStore', () => {
  beforeEach(() => {
    usePaneStore.setState({
      panes: [],
      selectedPaneId: null,
      isCreating: false,
      pendingPane: null,
    });
  });

  it('has correct initial state', () => {
    const state = usePaneStore.getState();
    expect(state.panes).toEqual([]);
    expect(state.selectedPaneId).toBeNull();
    expect(state.isCreating).toBe(false);
  });

  it('setPanes replaces entire pane list', () => {
    const panes = [makePane({ id: 'aumx-1' }), makePane({ id: 'aumx-2' })];
    usePaneStore.getState().setPanes(panes);

    expect(usePaneStore.getState().panes).toHaveLength(2);
    expect(usePaneStore.getState().panes[0].id).toBe('aumx-1');
    expect(usePaneStore.getState().panes[1].id).toBe('aumx-2');
  });

  it('setPanes overwrites previous panes', () => {
    usePaneStore.getState().setPanes([makePane({ id: 'aumx-old' })]);
    usePaneStore.getState().setPanes([makePane({ id: 'aumx-new' })]);

    const { panes } = usePaneStore.getState();
    expect(panes).toHaveLength(1);
    expect(panes[0].id).toBe('aumx-new');
  });

  it('setPanes does not merge runtime activity fields from the previous pane record', () => {
    usePaneStore.getState().setPanes([
      makePane({
        id: 'aumx-1',
        agentStatus: 'waiting',
        optionsQuestion: 'Continue?',
        terminalTranscriptPath: '/tmp/transcript.ansi',
      }),
    ]);

    usePaneStore.getState().setPanes([
      makePane({
        id: 'aumx-1',
        slug: 'renamed-pane',
        agentStatus: undefined,
        optionsQuestion: undefined,
        terminalTranscriptPath: undefined,
      }),
    ]);

    const pane = usePaneStore.getState().panes[0];
    expect(pane.slug).toBe('renamed-pane');
    expect(pane.agentStatus).toBeUndefined();
    expect(pane.optionsQuestion).toBeUndefined();
    expect(pane.terminalTranscriptPath).toBe('/tmp/transcript.ansi');
  });

  it('setPanes keeps pane and list references stable across a no-op push', () => {
    // Arrange - IPC pushes structurally identical (but freshly allocated) panes
    const snapshot = (): AumxPane[] => [
      makePane({ id: 'aumx-1', slug: 'first', agentStatus: 'working' }),
      makePane({ id: 'aumx-2', slug: 'second', agentStatus: 'idle' }),
    ];
    usePaneStore.getState().setPanes(snapshot());
    const first = usePaneStore.getState().panes;

    // Act
    usePaneStore.getState().setPanes(snapshot());

    // Assert
    const second = usePaneStore.getState().panes;
    expect(second).toBe(first);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it('setPanes gives a changed pane a new reference and leaves siblings untouched', () => {
    // Arrange
    usePaneStore.getState().setPanes([
      makePane({ id: 'aumx-1', slug: 'first', agentStatus: 'working' }),
      makePane({ id: 'aumx-2', slug: 'second', agentStatus: 'idle' }),
    ]);
    const before = usePaneStore.getState().panes;

    // Act
    usePaneStore.getState().setPanes([
      makePane({ id: 'aumx-1', slug: 'first', agentStatus: 'waiting' }),
      makePane({ id: 'aumx-2', slug: 'second', agentStatus: 'idle' }),
    ]);

    // Assert
    const after = usePaneStore.getState().panes;
    expect(after).not.toBe(before);
    expect(after[0]).not.toBe(before[0]);
    expect(after[0].agentStatus).toBe('waiting');
    expect(after[1]).toBe(before[1]);
  });

  it('selectPane sets selectedPaneId', () => {
    usePaneStore.getState().selectPane('aumx-1');
    expect(usePaneStore.getState().selectedPaneId).toBe('aumx-1');
  });

  it('selectPane accepts null to deselect', () => {
    usePaneStore.getState().selectPane('aumx-1');
    usePaneStore.getState().selectPane(null);
    expect(usePaneStore.getState().selectedPaneId).toBeNull();
  });

  it('addPane appends to pane list', () => {
    const pane1 = makePane({ id: 'aumx-1', slug: 'first' });
    const pane2 = makePane({ id: 'aumx-2', slug: 'second' });

    usePaneStore.getState().addPane(pane1);
    usePaneStore.getState().addPane(pane2);

    const { panes } = usePaneStore.getState();
    expect(panes).toHaveLength(2);
    expect(panes[0].id).toBe('aumx-1');
    expect(panes[1].id).toBe('aumx-2');
  });

  it('removePane filters out the specified pane', () => {
    const panes = [makePane({ id: 'aumx-1' }), makePane({ id: 'aumx-2' })];
    usePaneStore.getState().setPanes(panes);

    usePaneStore.getState().removePane('aumx-1');

    const remaining = usePaneStore.getState().panes;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('aumx-2');
  });

  it('removePane clears selectedPaneId when the selected pane is removed', () => {
    usePaneStore.getState().setPanes([makePane({ id: 'aumx-1' }), makePane({ id: 'aumx-2' })]);
    usePaneStore.getState().selectPane('aumx-1');

    usePaneStore.getState().removePane('aumx-1');

    expect(usePaneStore.getState().selectedPaneId).toBeNull();
  });

  it('removePane preserves selectedPaneId when a different pane is removed', () => {
    usePaneStore.getState().setPanes([makePane({ id: 'aumx-1' }), makePane({ id: 'aumx-2' })]);
    usePaneStore.getState().selectPane('aumx-2');

    usePaneStore.getState().removePane('aumx-1');

    expect(usePaneStore.getState().selectedPaneId).toBe('aumx-2');
  });

  it('setCreating toggles isCreating', () => {
    usePaneStore.getState().setCreating(true);
    expect(usePaneStore.getState().isCreating).toBe(true);

    usePaneStore.getState().setCreating(false);
    expect(usePaneStore.getState().isCreating).toBe(false);
  });

  it('keeps pending pane while no new pane has appeared yet', () => {
    usePaneStore.getState().setPendingPane({ agent: 'claude', prompt: 'test', targetPaneId: 'aumx-2' });
    usePaneStore.getState().setPanes([makePane({ id: 'aumx-1' })]);

    expect(usePaneStore.getState().pendingPane).not.toBeNull();
  });

  it('clears pending pane when target pane arrives', () => {
    usePaneStore.getState().setPendingPane({ agent: 'claude', prompt: 'test', targetPaneId: 'aumx-2' });
    usePaneStore.getState().setPanes([makePane({ id: 'aumx-2' })]);

    expect(usePaneStore.getState().pendingPane).toBeNull();
  });

});
