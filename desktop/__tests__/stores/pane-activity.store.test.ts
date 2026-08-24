import { beforeEach, describe, expect, it } from 'vitest';
import { PaneActivityService } from '../../src/main/services/PaneActivityService';
import { usePaneActivityStore } from '../../src/renderer/stores/pane-activity.store';
import type { PaneActivityChangedEvent } from '../../src/shared/pane-activity';

function activity(state: 'unknown' | 'working' | 'idle', revision: number, overrides: Record<string, unknown> = {}) {
  return {
    activityRevision: revision,
    adapterHealth: 'degraded' as const,
    certainty: 'provisional' as const,
    liveness: 'unknown' as const,
    openBackgroundWork: [],
    origin: 'none' as const,
    paneIncarnationId: 'incarnation-1',
    sinceWallMs: revision,
    state,
    ...overrides,
  };
}

describe('pane activity renderer store', () => {
  beforeEach(() => usePaneActivityStore.getState().reset());

  it('buffers a pre-snapshot change and applies it only when it is newer than the snapshot', () => {
    const store = usePaneActivityStore.getState();
    expect(store.acceptChangedEvent({
      changes: [{ activity: activity('working', 2), paneId: 'pane-1' }],
      epochId: 'epoch-1',
      revision: 2,
    })).toBe('buffered');

    store.replaceSnapshot({
      epochId: 'epoch-1',
      panes: { 'pane-1': activity('unknown', 1) },
      revision: 1,
    });

    expect(usePaneActivityStore.getState()).toMatchObject({
      activityByPaneId: { 'pane-1': { state: 'working' } },
      epochId: 'epoch-1',
      revision: 2,
    });
  });

  it('rejects a delta from a different service epoch instead of merging incomparable revisions', () => {
    const store = usePaneActivityStore.getState();
    store.replaceSnapshot({ epochId: 'epoch-1', panes: {}, revision: 3 });

    expect(store.acceptChangedEvent({
      changes: [{ activity: activity('idle', 1), paneId: 'pane-1' }],
      epochId: 'epoch-2',
      revision: 1,
    })).toBe('epoch-mismatch');
    expect(usePaneActivityStore.getState().activityByPaneId).toEqual({});
  });

  it('leaves no residue from a prior epoch after a simulated window reopen', () => {
    const store = usePaneActivityStore.getState();
    store.replaceSnapshot({
      epochId: 'epoch-old',
      panes: { 'pane-1': activity('working', 5), 'pane-2': activity('idle', 5) },
      revision: 5,
    });
    store.acceptChangedEvent({
      changes: [{ activity: activity('waiting', 6), paneId: 'pane-1' }],
      epochId: 'epoch-old',
      revision: 6,
    });

    const freshSnapshot = {
      epochId: 'epoch-new',
      panes: { 'pane-3': activity('unknown', 1) },
      revision: 1,
    };

    store.reset();
    store.replaceSnapshot(freshSnapshot);
    const reopened = usePaneActivityStore.getState();

    usePaneActivityStore.getState().reset();
    usePaneActivityStore.getState().replaceSnapshot(freshSnapshot);
    const blank = usePaneActivityStore.getState();

    expect(reopened.activityByPaneId).toEqual(blank.activityByPaneId);
    expect(reopened.epochId).toEqual(blank.epochId);
    expect(reopened.revision).toEqual(blank.revision);
    expect(reopened.bufferedChanges).toEqual(blank.bufferedChanges);
    expect(reopened.activityByPaneId['pane-1']).toBeUndefined();
    expect(reopened.activityByPaneId['pane-2']).toBeUndefined();
    expect(reopened.activityByPaneId['pane-3']).toMatchObject({ state: 'unknown' });
  });

  it('discards a buffered-but-unapplied change from the old epoch instead of leaking it after reset', () => {
    const store = usePaneActivityStore.getState();

    expect(store.acceptChangedEvent({
      changes: [{ activity: activity('working', 9), paneId: 'ghost-pane' }],
      epochId: 'epoch-orphan',
      revision: 9,
    })).toBe('buffered');
    expect(usePaneActivityStore.getState().bufferedChanges).toHaveLength(1);

    store.reset();

    const freshSnapshot = {
      epochId: 'epoch-orphan',
      panes: { 'pane-only': activity('idle', 1) },
      revision: 1,
    };
    store.replaceSnapshot(freshSnapshot);

    const state = usePaneActivityStore.getState();
    expect(state.bufferedChanges).toEqual([]);
    expect(state.activityByPaneId).toEqual({ 'pane-only': activity('idle', 1) });
    expect(state.activityByPaneId['ghost-pane']).toBeUndefined();
  });

  it('deletes a removed pane from activityByPaneId instead of leaving a stale entry behind', () => {
    const store = usePaneActivityStore.getState();
    store.replaceSnapshot({
      epochId: 'epoch-1',
      panes: { 'pane-1': activity('working', 1), 'pane-2': activity('idle', 1) },
      revision: 1,
    });

    const removalEvent: PaneActivityChangedEvent = {
      changes: [],
      epochId: 'epoch-1',
      removedPaneIds: ['pane-1'],
      revision: 2,
    };
    expect(store.acceptChangedEvent(removalEvent)).toBe('applied');

    const state = usePaneActivityStore.getState();
    expect(state.activityByPaneId['pane-1']).toBeUndefined();
    expect(state.activityByPaneId['pane-2']).toMatchObject({ state: 'idle' });
  });

  it('propagates a main-process pane removal all the way to the renderer store deleting that entry', () => {
    const service = new PaneActivityService({ epochId: 'e2e-epoch', now: () => 100 });
    service.registerPane('pane-1', 'incarnation-1');
    service.registerPane('pane-2', 'incarnation-2');

    const store = usePaneActivityStore.getState();
    store.replaceSnapshot(service.getSnapshot());
    expect(usePaneActivityStore.getState().activityByPaneId['pane-1']).toBeDefined();

    service.on('changed', (event: PaneActivityChangedEvent) => {
      usePaneActivityStore.getState().acceptChangedEvent(event);
    });
    service.removePane('pane-1');

    const state = usePaneActivityStore.getState();
    expect(state.activityByPaneId['pane-1']).toBeUndefined();
    expect(state.activityByPaneId['pane-2']).toBeDefined();
  });

  it('derives just-finished attention from a confirmed working-to-idle activity transition', () => {
    const store = usePaneActivityStore.getState();
    store.replaceSnapshot({ epochId: 'epoch-1', panes: { 'pane-1': activity('working', 1) }, revision: 1 });

    store.acceptChangedEvent({
      changes: [{ paneId: 'pane-1', activity: activity('idle', 2, { certainty: 'confirmed' }) }],
      epochId: 'epoch-1',
      revision: 2,
    });

    expect(usePaneActivityStore.getState().justFinishedPaneIds).toEqual(new Set(['pane-1']));
    usePaneActivityStore.getState().acknowledgeFinished('pane-1');
    expect(usePaneActivityStore.getState().justFinishedPaneIds).toEqual(new Set());
  });
});
