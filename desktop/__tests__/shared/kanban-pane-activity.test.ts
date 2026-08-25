import { describe, expect, it } from 'vitest';
import type { MuxBasePane } from 'muxbase/core';
import type { PaneActivity } from '../../src/shared/pane-activity';
import { getPaneKanbanActivityState, getPaneKanbanNextTransitionTime } from '../../src/shared/kanban-pane-activity';

function makePane(overrides: Partial<MuxBasePane> = {}): MuxBasePane {
  return { id: 'pane-1', slug: 'pane-1', prompt: 'do something', paneId: '%1', ...overrides };
}

function activity(state: PaneActivity['state']): PaneActivity {
  return {
    activityRevision: 1,
    adapterHealth: 'degraded',
    certainty: 'provisional',
    liveness: 'unknown',
    openBackgroundWork: [],
    origin: 'none',
    paneIncarnationId: 'incarnation-1',
    sinceWallMs: 0,
    state,
  };
}

describe('getPaneKanbanActivityState', () => {
  it.each([
    ['unknown', false],
    ['starting', true],
    ['working', true],
    ['waiting', false],
    ['idle', false],
    ['stopped', false],
  ] as const)('uses activity state %s without a grace window', (state, isBusy) => {
    expect(getPaneKanbanActivityState(makePane(), undefined, Date.now(), activity(state))).toMatchObject({
      isBusy,
      holdInProgressOnIdle: false,
      holdReason: null,
    });
  });

  it('fails closed when the activity snapshot is unavailable', () => {
    expect(getPaneKanbanActivityState(makePane(), undefined)).toEqual({
      isBusy: false,
      holdInProgressOnIdle: false,
      holdReason: 'activity-unavailable',
    });
  });
});

describe('getPaneKanbanNextTransitionTime', () => {
  it('never schedules a wall-clock grace transition', () => {
    expect(getPaneKanbanNextTransitionTime(makePane(), undefined, Date.now(), activity('working'))).toBeNull();
  });
});
