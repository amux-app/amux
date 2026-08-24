import { describe, expect, it } from 'vitest';
import {
  isReadyForMutation,
  type PaneActivityEvent,
} from '../../src/shared/pane-activity';
import { PaneActivityService } from '../../src/main/services/PaneActivityService';
import { makeActivity } from '../helpers/pane-activity-fixtures';

const paneId = '%1';
const paneIncarnationId = 'incarnation-1';

function event(
  kind: PaneActivityEvent['kind'],
  receivedAt: number,
  overrides: Partial<PaneActivityEvent> = {},
): PaneActivityEvent {
  return {
    eventId: `${kind}-${receivedAt}`,
    kind,
    origin: 'adapter',
    paneIncarnationId,
    paneId,
    receivedAt,
    ...overrides,
  };
}

function handshake(service: PaneActivityService, sessionId = 'session-a'): void {
  service.ingest(event('adapter_handshake', 99, {
    eventId: `handshake-${sessionId}`,
    sessionId,
    adapterVersion: '2.1.200',
    adapterSupport: 'full',
    adapterCapabilities: ['turnIds', 'backgroundEntities'],
  }));
}

describe('PaneActivityService', () => {
  it('publishes a provisional candidate immediately, then upgrades only a committed turn event', () => {
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => 100 });
    service.registerPane(paneId, paneIncarnationId);
    handshake(service);

    service.ingest(event('turn_start_candidate', 100, { turnId: 'turn-1' }));
    expect(service.getSnapshot(paneId).activity).toMatchObject({
      state: 'working',
      certainty: 'provisional',
      turnId: 'turn-1',
    });

    service.ingest(event('turn_started', 110, { eventId: 'started', turnId: 'turn-1' }));
    expect(service.getSnapshot(paneId).activity).toMatchObject({
      state: 'working',
      certainty: 'confirmed',
      origin: 'adapter',
      adapterHealth: 'healthy',
    });
  });

  it('does not let a stop candidate claim confirmed idle when the turn continues', () => {
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => 100 });
    service.registerPane(paneId, paneIncarnationId);
    handshake(service);
    service.ingest(event('turn_started', 100, { turnId: 'turn-1' }));
    service.ingest(event('turn_end_candidate', 120, { eventId: 'stop', turnId: 'turn-1' }));

    expect(service.getSnapshot(paneId).activity).toMatchObject({
      state: 'idle',
      certainty: 'provisional',
    });

    service.ingest(event('turn_started', 130, { eventId: 'continued', turnId: 'turn-1' }));
    expect(service.getSnapshot(paneId).activity).toMatchObject({
      state: 'working',
      certainty: 'confirmed',
    });
  });

  it('promotes an end candidate only after the quiescence barrier and independent idle evidence', () => {
    let now = 100;
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => now });
    service.registerPane(paneId, paneIncarnationId);
    handshake(service);
    service.ingest(event('turn_started', 100, { turnId: 'turn-1' }));
    service.ingest(event('turn_end_candidate', 110, { eventId: 'stop', turnId: 'turn-1' }));

    now = 350;
    service.ingest(event('turn_settled', 350, {
      eventId: 'visible-idle',
      origin: 'poll',
      turnId: 'turn-1',
    }));

    expect(service.getSnapshot(paneId).activity).toMatchObject({
      certainty: 'confirmed',
      state: 'idle',
    });
  });

  it('remembers idle corroboration that arrives before the quiescence barrier', () => {
    let now = 100;
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => now });
    service.registerPane(paneId, paneIncarnationId);
    service.ingest(event('turn_started', 100, { turnId: 'turn-1' }));
    service.ingest(event('turn_end_candidate', 110, { eventId: 'stop', turnId: 'turn-1' }));

    now = 200;
    service.ingest(event('turn_settled', 200, {
      eventId: 'early-visible-idle',
      origin: 'poll',
      turnId: 'turn-1',
    }));
    expect(service.getSnapshot(paneId).activity).toMatchObject({ certainty: 'provisional', state: 'idle' });

    now = 360;
    service.sweep();

    expect(service.getSnapshot(paneId).activity).toMatchObject({ certainty: 'confirmed', state: 'idle' });
  });

  it('degrades an uncorroborated open turn to unknown after the evidence lease expires', () => {
    let now = 100;
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => now });
    service.registerPane(paneId, paneIncarnationId);
    service.ingest(event('turn_started', 100, { turnId: 'turn-1' }));

    now += 10_001;
    service.sweep();

    expect(service.getSnapshot(paneId).activity).toMatchObject({
      state: 'unknown',
      certainty: 'provisional',
    });
  });

  it('drops events for a recycled pane incarnation', () => {
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => 100 });
    service.registerPane(paneId, 'incarnation-2');

    service.ingest(event('turn_started', 100, { turnId: 'old-turn' }));

    expect(service.getSnapshot(paneId).activity.state).toBe('unknown');
  });

  it('does not let poll or session evidence revive a confirmed stopped pane', () => {
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => 100 });
    service.registerPane(paneId, paneIncarnationId);
    handshake(service);
    service.setLiveness(paneId, 'stopped');

    service.ingest(event('turn_started', 101, { turnId: 'turn-1', origin: 'poll' }));

    expect(service.getSnapshot(paneId).activity).toMatchObject({ liveness: 'stopped', state: 'stopped' });
  });

  it('allows a new adapter session to reset stale candidates and revive a stopped pane', () => {
    let now = 100;
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => now });
    service.registerPane(paneId, paneIncarnationId);
    service.ingest(event('turn_started', 100, { sessionId: 'old', turnId: 'old-turn' }));
    service.ingest(event('turn_end_candidate', 101, { eventId: 'old-stop', sessionId: 'old', turnId: 'old-turn' }));
    service.setLiveness(paneId, 'stopped');

    now = 200;
    service.ingest(event('session_start', 200, { eventId: 'new-session', sessionId: 'new' }));

    expect(service.getSnapshot(paneId).activity).toMatchObject({
      liveness: 'running',
      sessionId: 'new',
      state: 'starting',
      turnId: undefined,
    });
    now += 60_001;
    service.sweep();
    expect(service.getSnapshot(paneId).activity.state).toBe('unknown');
  });
});

describe('PaneActivityService — turn supersession', () => {
  it('lets a turn_started for a newer turn override an older turn, and ignores a stale turn_settled for the old turn', () => {
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => 100 });
    service.registerPane(paneId, paneIncarnationId);

    service.ingest(event('turn_started', 100, { eventId: 'old-start', turnId: 'turn-1' }));
    service.ingest(event('turn_started', 110, { eventId: 'new-start', turnId: 'turn-2' }));
    expect(service.getSnapshot(paneId).activity).toMatchObject({ state: 'working', turnId: 'turn-2' });

    service.ingest(event('turn_settled', 120, { eventId: 'stale-settle', turnId: 'turn-1' }));

    expect(service.getSnapshot(paneId).activity).toMatchObject({ state: 'working', turnId: 'turn-2' });
  });
});

describe('PaneActivityService — discard rules', () => {
  it('discards an event whose paneIncarnationId does not match the pane\'s current incarnation and traces the discard', () => {
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => 100 });
    service.registerPane(paneId, paneIncarnationId);

    service.ingest(event('turn_started', 100, {
      eventId: 'wrong-incarnation',
      paneIncarnationId: 'some-other-incarnation',
      turnId: 'turn-1',
    }));

    expect(service.getSnapshot(paneId).activity.state).toBe('unknown');
    expect(service.getTrace(paneId)).toContainEqual(
      expect.objectContaining({ detail: 'incarnation mismatch', type: 'discard' }),
    );
  });

  it('discards a turn event for a superseded sessionId, but session_start is exempt from that guard', () => {
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => 100 });
    service.registerPane(paneId, paneIncarnationId);
    service.ingest(event('session_start', 100, { eventId: 'session-a', sessionId: 'session-a' }));
    service.ingest(event('turn_started', 101, { eventId: 'turn-a', sessionId: 'session-a', turnId: 't1' }));

    service.ingest(event('turn_started', 102, { eventId: 'turn-b', sessionId: 'session-b', turnId: 't2' }));
    expect(service.getSnapshot(paneId).activity).toMatchObject({ sessionId: 'session-a', turnId: 't1' });

    service.ingest(event('session_start', 103, { eventId: 'session-b', sessionId: 'session-b' }));
    expect(service.getSnapshot(paneId).activity).toMatchObject({ sessionId: 'session-b', state: 'starting' });

    service.ingest(event('turn_started', 104, { eventId: 'turn-c', sessionId: 'session-b', turnId: 't3' }));
    expect(service.getSnapshot(paneId).activity).toMatchObject({ sessionId: 'session-b', state: 'working', turnId: 't3' });
  });
});

describe('PaneActivityService — candidate promotion and veto', () => {
  it('overwrites a pending turn_end_candidate with a fresh turn_start_candidate, never settling the earlier one into confirmed idle', () => {
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => 100 });
    service.registerPane(paneId, paneIncarnationId);
    service.ingest(event('turn_started', 100, { turnId: 'turn-1' }));

    service.ingest(event('turn_end_candidate', 101, { eventId: 'stop', turnId: 'turn-1' }));
    expect(service.getSnapshot(paneId).activity).toMatchObject({ certainty: 'provisional', state: 'idle' });

    service.ingest(event('turn_start_candidate', 102, { eventId: 'resume', turnId: 'turn-1' }));
    expect(service.getSnapshot(paneId).activity).toMatchObject({ certainty: 'provisional', state: 'working' });
  });

  it('a Stop-hook-continuation pattern never produces a confirmed idle, and reverts to the last committed turn once all candidates expire', () => {
    let now = 100;
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => now });
    service.registerPane(paneId, paneIncarnationId);
    handshake(service);
    service.ingest(event('turn_started', 100, { turnId: 'turn-1' }));
    expect(service.getSnapshot(paneId).activity).toMatchObject({ certainty: 'confirmed', state: 'working' });

    now = 101;
    service.ingest(event('turn_end_candidate', 101, { eventId: 'stop', turnId: 'turn-1' }));
    expect(service.getSnapshot(paneId).activity).toMatchObject({ certainty: 'provisional', state: 'idle' });

    now = 1_000;
    service.ingest(event('turn_start_candidate', 1_000, { eventId: 'bounce', turnId: 'turn-1' }));
    expect(service.getSnapshot(paneId).activity).toMatchObject({ certainty: 'provisional', state: 'working' });

    // The original turn_end_candidate window (101 + 3000 = 3101) has now elapsed,
    // but the renewed candidate (created at 1000, expiring at 4000) must still hold.
    now = 3_200;
    service.sweep();
    expect(service.getSnapshot(paneId).activity).toMatchObject({ certainty: 'provisional', state: 'working' });

    now = 4_001;
    service.sweep();
    expect(service.getSnapshot(paneId).activity).toMatchObject({
      certainty: 'confirmed',
      state: 'working',
      turnId: 'turn-1',
    });
  });
});

describe('PaneActivityService — certainty degradation never falls silently to idle', () => {
  it('degrades a provisional (non-adapter) open turn to unknown exactly at the lease boundary', () => {
    let now = 100;
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => now });
    service.registerPane(paneId, paneIncarnationId);
    service.ingest(event('turn_started', 100, { origin: 'poll', turnId: 'turn-1' }));
    expect(service.getSnapshot(paneId).activity).toMatchObject({ certainty: 'provisional', state: 'working' });

    now = 10_099;
    service.sweep();
    expect(service.getSnapshot(paneId).activity.state).toBe('working');

    now = 10_100;
    service.sweep();
    expect(service.getSnapshot(paneId).activity).toMatchObject({ certainty: 'provisional', state: 'unknown' });
  });

  it('degrades an open waiting lease to unknown, never to idle, once it expires uncorroborated', () => {
    let now = 100;
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => now });
    service.registerPane(paneId, paneIncarnationId);
    service.ingest(event('wait_started', 100, { waitReason: 'permission' }));
    expect(service.getSnapshot(paneId).activity.state).toBe('waiting');

    now += 10_001;
    service.sweep();

    expect(service.getSnapshot(paneId).activity).toMatchObject({ certainty: 'provisional', state: 'unknown' });
  });
});

describe('PaneActivityService — liveness and session lifecycle', () => {
  it('never resolves a stopped state from session_end alone; only a confirmed liveness probe does', () => {
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => 100 });
    service.registerPane(paneId, paneIncarnationId);
    service.ingest(event('session_start', 100, { eventId: 'session-a', sessionId: 'session-a' }));
    service.ingest(event('turn_started', 101, { turnId: 'turn-1' }));

    service.ingest(event('session_end', 102, { eventId: 'session-end' }));
    expect(service.getSnapshot(paneId).activity).toMatchObject({ liveness: 'running', state: 'starting' });
    expect(service.getSnapshot(paneId).activity.state).not.toBe('stopped');

    service.setLiveness(paneId, 'stopped');
    expect(service.getSnapshot(paneId).activity).toMatchObject({
      certainty: 'confirmed',
      liveness: 'stopped',
      state: 'stopped',
    });
  });
});

describe('PaneActivityService — poll idle override corroboration', () => {
  const turnId = 'turn-1';

  function establishSessionLogWorking(service: PaneActivityService): void {
    service.registerPane(paneId, paneIncarnationId);
    service.ingest(event('session_start', 100, { eventId: 'session-start', origin: 'session-log', sessionId: 'session-a' }));
    service.ingest(event('turn_started', 101, { eventId: 'session-turn-start', origin: 'session-log', turnId }));
  }

  it('accepts the detector poll-idle edge after its redraw-separated capture confirmation', () => {
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => 100 });
    establishSessionLogWorking(service);

    service.ingest(event('turn_settled', 102, { eventId: 'poll-idle-1', origin: 'poll', turnId }));

    expect(service.getSnapshot(paneId).activity).toMatchObject({ origin: 'poll', state: 'idle' });
    expect(service.getTrace(paneId)).not.toContainEqual(
      expect.objectContaining({ detail: expect.stringContaining('poll idle override needs corroboration') }),
    );
  });

  it('resolves idle on the first poll-idle reading when the pane has no session/adapter tracking at all', () => {
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => 100 });
    service.registerPane(paneId, paneIncarnationId);
    service.ingest(event('turn_started', 100, { eventId: 'poll-start', origin: 'poll', turnId }));

    service.ingest(event('turn_settled', 101, { eventId: 'poll-idle-1', origin: 'poll', turnId }));

    expect(service.getSnapshot(paneId).activity).toMatchObject({ origin: 'poll', state: 'idle' });
  });

  it('confirms boot-time idle when session-log and poll independently agree', () => {
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => 100 });
    service.registerPane(paneId, paneIncarnationId);
    service.setLiveness(paneId, 'running');

    service.ingest(event('turn_settled', 101, { eventId: 'session-idle', origin: 'session-log' }));
    expect(service.getSnapshot(paneId).activity).toMatchObject({ certainty: 'provisional', state: 'idle' });

    service.ingest(event('turn_settled', 102, { eventId: 'poll-idle', origin: 'poll' }));

    const activity = service.getSnapshot(paneId).activity;
    expect(activity).toMatchObject({ certainty: 'confirmed', liveness: 'running', state: 'idle' });
    expect(isReadyForMutation(activity)).toBe(true);
  });

  it('treats a poll restatement of working as freshness, keeping the stronger standing evidence', () => {
    // Arrange
    let now = 100;
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => now });
    establishSessionLogWorking(service);

    // Act — restate working past the point the original lease would have lapsed
    for (let elapsed = 0; elapsed < 30_000; elapsed += 5_000) {
      now += 5_000;
      service.sweep();
      service.ingest(event('turn_started', now, { eventId: `poll-working-${now}`, origin: 'poll', turnId }));
    }

    // Assert
    expect(service.getSnapshot(paneId).activity).toMatchObject({ origin: 'session-log', state: 'working' });
  });
});

describe('PaneActivityService — pane removal', () => {
  it('emits a removedPaneIds signal instead of a no-op empty changes array', () => {
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => 100 });
    service.registerPane(paneId, paneIncarnationId);
    const changedEvents: unknown[] = [];
    service.on('changed', (event) => changedEvents.push(event));

    service.removePane(paneId);

    expect(changedEvents).toEqual([
      { changes: [], epochId: 'test-epoch', removedPaneIds: [paneId], revision: 2 },
    ]);
  });

  it('does not emit anything when removing a pane that was never registered', () => {
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => 100 });
    const changedEvents: unknown[] = [];
    service.on('changed', (event) => changedEvents.push(event));

    service.removePane('never-registered');

    expect(changedEvents).toEqual([]);
  });
});

describe('PaneActivityService — journal replay', () => {
  it('never publishes an intermediate confirmed state while replaying adapter history', () => {
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => 100 });
    service.registerPane(paneId, paneIncarnationId);
    const published: Array<{ certainty: string; state: string }> = [];
    service.on('changed', (changed) => {
      for (const change of changed.changes) {
        published.push({ certainty: change.activity.certainty, state: change.activity.state });
      }
    });

    service.replay(event('turn_started', 100, { turnId: 'turn-1' }));

    expect(published).toEqual([{ certainty: 'provisional', state: 'working' }]);
    expect(service.getSnapshot(paneId).activity).toMatchObject({
      adapterHealth: 'degraded',
      certainty: 'provisional',
      state: 'working',
    });
  });
});

describe('PaneActivityService — background work', () => {
  it('mutates openBackgroundWork without changing state, and isReadyForMutation blocks only while an entity is mutating', () => {
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => 100 });
    service.registerPane(paneId, paneIncarnationId);
    handshake(service);
    service.ingest(event('session_start', 100, { eventId: 'session-a', sessionId: 'session-a' }));
    service.ingest(event('turn_started', 101, { turnId: 'turn-1' }));
    service.ingest(event('turn_settled', 102, { eventId: 'settle', turnId: 'turn-1' }));
    expect(service.getSnapshot(paneId).activity).toMatchObject({ certainty: 'confirmed', liveness: 'running', state: 'idle' });
    expect(isReadyForMutation(service.getSnapshot(paneId).activity)).toBe(true);

    service.ingest(event('background_started', 103, {
      entity: { kind: 'subagent', mutating: true, sinceWallMs: 103 },
      entityId: 'sub-1',
    }));
    const midFlight = service.getSnapshot(paneId).activity;
    expect(midFlight.state).toBe('idle');
    expect(midFlight.openBackgroundWork).toEqual([
      { entityId: 'sub-1', kind: 'subagent', mutating: true, sinceWallMs: 103 },
    ]);
    expect(isReadyForMutation(midFlight)).toBe(false);

    service.ingest(event('background_ended', 104, { entityId: 'sub-1' }));
    const settled = service.getSnapshot(paneId).activity;
    expect(settled.state).toBe('idle');
    expect(settled.openBackgroundWork).toEqual([]);
    expect(isReadyForMutation(settled)).toBe(true);
  });
});

describe('isReadyForMutation', () => {
  const ready = makeActivity({ paneIncarnationId, sinceWallMs: 0 });

  it.each([
    ['provisional certainty', { certainty: 'provisional' as const }],
    ['unknown liveness', { liveness: 'unknown' as const }],
    ['stopped liveness', { liveness: 'stopped' as const }],
    ['working state', { state: 'working' as const }],
    ['unknown background mutation', { openBackgroundWork: [{ entityId: 'task-1', kind: 'task' as const, mutating: 'unknown' as const, sinceWallMs: 0 }] }],
  ])('fails closed for %s', (_name, change) => {
    expect(isReadyForMutation({ ...ready, ...change })).toBe(false);
  });

  it('admits only a confirmed, live idle pane with non-mutating background work', () => {
    expect(isReadyForMutation({
      ...ready,
      openBackgroundWork: [{ entityId: 'read-only-task', kind: 'task', mutating: false, sinceWallMs: 0 }],
    })).toBe(true);
  });
});

describe('PaneActivityService — deterministic ordering and clocks', () => {
  it('does not treat arbitrary adapter events or malformed handshakes as healthy evidence', () => {
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => 100 });
    service.registerPane(paneId, paneIncarnationId);
    service.ingest(event('turn_started', 1, { eventId: 'before-handshake', turnId: 'turn-1' }));
    expect(service.getSnapshot(paneId).activity).toMatchObject({ adapterHealth: 'degraded', certainty: 'provisional' });

    service.ingest(event('adapter_handshake', 2, {
      eventId: 'malformed-handshake',
      adapterVersion: '2.1.200',
      adapterSupport: 'full',
    }));
    expect(service.getSnapshot(paneId).activity.adapterHealth).toBe('degraded');

    service.ingest(event('adapter_handshake', 3, {
      eventId: 'partial-handshake',
      adapterVersion: '2.1.100',
      adapterSupport: 'partial',
      adapterCapabilities: ['turnIds'],
    }));
    expect(service.getSnapshot(paneId).activity.adapterHealth).toBe('degraded');
  });

  it.each([
    ['delayed old start after newer settle', (service: PaneActivityService) => {
      service.ingest(event('turn_started', 1, { eventId: 'a-start', sessionId: 's', turnId: 'a' }));
      service.ingest(event('turn_started', 2, { eventId: 'b-start', sessionId: 's', turnId: 'b' }));
      service.ingest(event('turn_settled', 3, { eventId: 'b-settle', sessionId: 's', turnId: 'b' }));
      service.ingest(event('turn_start_candidate', 4, { eventId: 'late-a-start', sessionId: 's', turnId: 'a' }));
    }],
    ['delayed old settle after newer start', (service: PaneActivityService) => {
      service.ingest(event('turn_started', 1, { eventId: 'a-start', sessionId: 's', turnId: 'a' }));
      service.ingest(event('turn_started', 2, { eventId: 'b-start', sessionId: 's', turnId: 'b' }));
      service.ingest(event('turn_settled', 3, { eventId: 'late-a-settle', sessionId: 's', turnId: 'a' }));
    }],
    ['duplicate event', (service: PaneActivityService) => {
      service.ingest(event('turn_started', 1, { eventId: 'same', sessionId: 's', turnId: 'a' }));
      service.ingest(event('turn_started', 1, { eventId: 'same', sessionId: 's', turnId: 'a' }));
    }],
    ['concurrent sessions', (service: PaneActivityService) => {
      service.ingest(event('session_start', 1, { eventId: 'session-a', sessionId: 'a' }));
      service.ingest(event('turn_started', 2, { eventId: 'a-start', sessionId: 'a', turnId: 'a-turn' }));
      service.ingest(event('session_start', 3, { eventId: 'session-b', sessionId: 'b' }));
      service.ingest(event('turn_started', 4, { eventId: 'b-start', sessionId: 'b', turnId: 'b-turn' }));
      service.ingest(event('turn_settled', 5, { eventId: 'late-a-settle', sessionId: 'a', turnId: 'a-turn' }));
    }],
    ['old-incarnation event', (service: PaneActivityService) => {
      service.ingest(event('turn_started', 1, { eventId: 'old-incarnation', paneIncarnationId: 'old', turnId: 'a' }));
    }],
    ['out-of-order background edge', (service: PaneActivityService) => {
      service.ingest(event('session_start', 1, { eventId: 'session-a', sessionId: 'a' }));
      service.ingest(event('background_started', 2, {
        eventId: 'background-a', sessionId: 'a', entityId: 'task-a',
        entity: { kind: 'task', mutating: true, sinceWallMs: 1 },
      }));
      service.ingest(event('session_start', 3, { eventId: 'session-b', sessionId: 'b' }));
      service.ingest(event('background_ended', 4, { eventId: 'late-a-end', sessionId: 'a', entityId: 'task-a' }));
    }],
  ])('%s is delivery-order safe', (_name, arrange) => {
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => 100 });
    service.registerPane(paneId, paneIncarnationId);
    handshake(service, 's');
    arrange(service);

    const activity = service.getSnapshot(paneId).activity;
    expect(activity.paneIncarnationId).toBe(paneIncarnationId);
    expect(service.getTrace(paneId).some((entry) => entry.type === 'discard')).toBe(true);
  });

  it('uses monotonic time for quiescence and leases while wall time is display-only', () => {
    let monotonic = 0;
    let wall = 1_000_000;
    const service = new PaneActivityService({
      epochId: 'test-epoch',
      monotonicNow: () => monotonic,
      wallNow: () => wall,
    });
    service.registerPane(paneId, paneIncarnationId);
    handshake(service, 's');
    service.ingest(event('turn_started', 0, { eventId: 'start', sessionId: 's', turnId: 'turn-1' }));
    expect(service.getSnapshot(paneId).activity.sinceWallMs).toBe(wall);

    service.ingest(event('turn_end_candidate', 1, { eventId: 'stop', sessionId: 's', turnId: 'turn-1' }));
    monotonic = 100;
    wall += 60 * 60 * 1000;
    service.ingest(event('turn_settled', 100, { eventId: 'early-idle', origin: 'poll', sessionId: 's', turnId: 'turn-1' }));
    expect(service.getSnapshot(paneId).activity.certainty).toBe('provisional');

    monotonic = 250;
    wall -= 2 * 60 * 60 * 1000;
    service.sweep();
    expect(service.getSnapshot(paneId).activity).toMatchObject({ state: 'idle', certainty: 'confirmed', sinceWallMs: wall });

    service.ingest(event('turn_started', 300, { eventId: 'turn-2', sessionId: 's', turnId: 'turn-2' }));
    monotonic = 10_249;
    wall += 60 * 60 * 1000;
    service.sweep();
    expect(service.getSnapshot(paneId).activity.state).toBe('working');
    monotonic = 10_250;
    service.sweep();
    expect(service.getSnapshot(paneId).activity.state).toBe('unknown');
  });

  it('does not reopen an entity when a delayed background start arrives after its end edge', () => {
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => 100 });
    service.registerPane(paneId, paneIncarnationId);
    handshake(service, 's');
    service.ingest(event('background_ended', 1, { eventId: 'end-first', sessionId: 's', entityId: 'task-1' }));
    service.ingest(event('background_started', 2, {
      eventId: 'start-late', sessionId: 's', entityId: 'task-1',
      entity: { kind: 'task', mutating: true, sinceWallMs: 1 },
    }));
    expect(service.getSnapshot(paneId).activity.openBackgroundWork).toEqual([]);
  });
});

describe('PaneActivityService — indicator stays synced without a lifecycle adapter', () => {
  function pollService(nowRef: { value: number }): PaneActivityService {
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => nowRef.value });
    service.registerPane(paneId, paneIncarnationId, { starting: true });
    service.setLiveness(paneId, 'running');
    return service;
  }

  function poll(service: PaneActivityService, status: 'working' | 'idle', at: number): void {
    service.ingest(event(status === 'working' ? 'turn_started' : 'turn_settled', at, {
      eventId: `poll-${status}-${at}`,
      origin: 'poll',
    }));
  }

  it('cycles working and idle repeatedly on poll evidence alone', () => {
    // Arrange
    const now = { value: 100 };
    const service = pollService(now);

    // Act + Assert
    for (let cycle = 0; cycle < 3; cycle += 1) {
      poll(service, 'working', now.value += 1_000);
      expect(service.getSnapshot(paneId).activity.state).toBe('working');
      poll(service, 'idle', now.value += 1_000);
      expect(service.getSnapshot(paneId).activity.state).toBe('idle');
    }
  });

  it('keeps working across a long tool call while the poll re-asserts', () => {
    // Arrange
    const now = { value: 100 };
    const service = pollService(now);
    poll(service, 'working', now.value += 1_000);

    // Act: a 60s stretch with a re-assert every 5s
    for (let elapsed = 0; elapsed < 60_000; elapsed += 5_000) {
      now.value += 5_000;
      service.sweep();
      poll(service, 'working', now.value);
    }

    // Assert
    expect(service.getSnapshot(paneId).activity.state).toBe('working');
  });

  it('degrades to unknown rather than idle when poll evidence stops entirely', () => {
    // Arrange
    const now = { value: 100 };
    const service = pollService(now);
    poll(service, 'working', now.value += 1_000);

    // Act
    now.value += 10_001;
    service.sweep();

    // Assert
    expect(service.getSnapshot(paneId).activity).toMatchObject({ certainty: 'provisional', state: 'unknown' });
  });

  it('recovers to live evidence after a stopped pane comes back', () => {
    // Arrange
    const now = { value: 100 };
    const service = pollService(now);
    service.setLiveness(paneId, 'stopped');
    expect(service.getSnapshot(paneId).activity.state).toBe('stopped');

    // Act
    service.setLiveness(paneId, 'running');
    poll(service, 'working', now.value += 1_000);

    // Assert
    expect(service.getSnapshot(paneId).activity).toMatchObject({ liveness: 'running', state: 'working' });
  });

  it('does not publish a change when the poll re-asserts an unchanged status', () => {
    // Arrange
    const now = { value: 100 };
    const service = pollService(now);
    poll(service, 'idle', now.value += 1_000);
    const changes: number[] = [];
    service.on('changed', () => changes.push(1));

    // Act
    for (let i = 0; i < 5; i += 1) poll(service, 'idle', now.value += 5_000);

    // Assert
    expect(changes).toHaveLength(0);
  });
});

describe('PaneActivityService — an adapter turn always closes', () => {
  it('degrades a Stop candidate that no other evidence corroborates to unknown, never a fabricated idle', () => {
    // Arrange
    const now = { value: 100 };
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => now.value });
    service.registerPane(paneId, paneIncarnationId);
    handshake(service);
    service.ingest(event('turn_started', 100, { turnId: 'turn-1' }));

    // Act
    now.value = 101;
    service.ingest(event('turn_end_candidate', 101, { eventId: 'stop', turnId: 'turn-1' }));
    now.value = 3_200;
    service.sweep();

    // Assert
    expect(service.getSnapshot(paneId).activity).toMatchObject({ certainty: 'provisional', state: 'unknown' });
  });

  it('does not let a blocked prompt candidate harden into working', () => {
    // Arrange — UserPromptSubmit fires, then a sibling hook blocks the prompt,
    // so nothing ever corroborates the turn.
    const now = { value: 100 };
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => now.value });
    service.registerPane(paneId, paneIncarnationId);
    handshake(service);

    // Act
    service.ingest(event('turn_start_candidate', 100, { turnId: 'turn-1' }));
    expect(service.getSnapshot(paneId).activity.state).toBe('working');
    now.value = 3_200;
    service.sweep();

    // Assert
    expect(service.getSnapshot(paneId).activity.state).toBe('unknown');
  });

  it('keeps a real turn working when the poll corroborates the prompt candidate', () => {
    // Arrange
    const now = { value: 100 };
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => now.value });
    service.registerPane(paneId, paneIncarnationId);
    handshake(service);

    // Act
    service.ingest(event('turn_start_candidate', 100, { turnId: 'turn-1' }));
    now.value = 1_100;
    service.ingest(event('turn_started', 1_100, { eventId: 'poll-working', origin: 'poll', turnId: 'turn-1' }));
    now.value = 3_200;
    service.sweep();

    // Assert
    expect(service.getSnapshot(paneId).activity).toMatchObject({ state: 'working', turnId: 'turn-1' });
  });

  it('lets unscoped poll evidence confirm an idle that an adapter turn opened', () => {
    // Arrange
    const now = { value: 100 };
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => now.value });
    service.registerPane(paneId, paneIncarnationId);
    service.setLiveness(paneId, 'running');
    handshake(service);
    service.ingest(event('turn_started', 100, { turnId: 'turn-1' }));

    // Act
    now.value = 200;
    service.ingest(event('turn_settled', 200, { eventId: 'adapter-stop', turnId: 'turn-1' }));
    now.value = 1_200;
    service.ingest(event('turn_settled', 1_200, { eventId: 'poll-idle', origin: 'poll' }));

    // Assert
    expect(isReadyForMutation(service.getSnapshot(paneId).activity)).toBe(true);
  });
});

describe('PaneActivityService — bounds never blank a pane that is still reporting', () => {
  it('keeps a booting pane in starting well past the turn lease', () => {
    // Arrange
    let now = 100;
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => now });
    service.registerPane(paneId, paneIncarnationId, { starting: true });

    // Act
    now += 30_000;
    service.sweep();

    // Assert
    expect(service.getSnapshot(paneId).activity.state).toBe('starting');
  });

  it('resolves a stop candidate that straddles the lease boundary through its own window', () => {
    // Arrange
    let now = 100;
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => now });
    service.registerPane(paneId, paneIncarnationId);
    handshake(service);
    service.ingest(event('turn_started', 100, { turnId: 'turn-1' }));

    // Act — Stop lands 8s in, so its window closes after the 10s lease would have
    now = 8_000;
    service.ingest(event('turn_end_candidate', 8_000, { eventId: 'stop', turnId: 'turn-1' }));
    now = 11_200;
    service.sweep();

    // Assert — the candidate window, not the lease, decides; uncorroborated is unknown
    expect(service.getSnapshot(paneId).activity.state).toBe('unknown');
  });

  it('does not let a screen-scraped idle retire an open permission wait', () => {
    // Arrange
    const now = { value: 100 };
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => now.value });
    service.registerPane(paneId, paneIncarnationId);
    service.setLiveness(paneId, 'running');
    handshake(service);
    service.ingest(event('wait_started', 100, { turnId: 'turn-1', waitReason: 'permission' }));
    expect(service.getSnapshot(paneId).activity.state).toBe('waiting');

    // Act
    now.value = 1_100;
    service.ingest(event('turn_settled', 1_100, { eventId: 'poll-idle', origin: 'poll', turnId: 'turn-1' }));

    // Assert
    const activity = service.getSnapshot(paneId).activity;
    expect(activity.state).toBe('waiting');
    expect(isReadyForMutation(activity)).toBe(false);
  });

  it('lets the agent itself resolve the wait', () => {
    // Arrange
    const now = { value: 100 };
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => now.value });
    service.registerPane(paneId, paneIncarnationId);
    service.setLiveness(paneId, 'running');
    handshake(service);
    service.ingest(event('wait_started', 100, { turnId: 'turn-1', waitReason: 'permission' }));

    // Act
    now.value = 1_100;
    service.ingest(event('wait_resolved', 1_100, { eventId: 'granted', turnId: 'turn-1' }));

    // Assert
    expect(service.getSnapshot(paneId).activity.state).toBe('working');
  });
});

describe('PaneActivityService — cross-source contradiction', () => {
  it('lets a visible working marker refute a stop candidate without weakening the adapter evidence', () => {
    // Arrange — a sibling Stop hook continued the turn, so the agent is still working
    let now = 100;
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => now });
    service.registerPane(paneId, paneIncarnationId);
    handshake(service);
    service.setLiveness(paneId, 'running');
    service.ingest(event('turn_started', 100, { turnId: 'turn-1' }));
    now = 200;
    service.ingest(event('turn_end_candidate', 200, { eventId: 'stop', turnId: 'turn-1' }));
    expect(service.getSnapshot(paneId).activity.state).toBe('idle');

    // Act
    now = 1_200;
    service.ingest(event('turn_started', 1_200, { eventId: 'poll-working', origin: 'poll', turnId: 'turn-1' }));

    // Assert
    expect(service.getSnapshot(paneId).activity).toMatchObject({
      certainty: 'confirmed',
      origin: 'adapter',
      state: 'working',
    });

    now = 4_000;
    service.sweep();
    expect(service.getSnapshot(paneId).activity.state).toBe('working');
  });
});

describe('PaneActivityService — an open prompt outlives its display state', () => {
  it('refuses a poll idle after the waiting state has already degraded to unknown', () => {
    // Arrange — the prompt is still on screen, but its lease has lapsed
    let now = 100;
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => now });
    service.registerPane(paneId, paneIncarnationId);
    handshake(service);
    service.setLiveness(paneId, 'running');
    service.ingest(event('wait_started', 100, { turnId: 'turn-1', waitReason: 'permission' }));
    now = 10_200;
    service.sweep();
    expect(service.getSnapshot(paneId).activity.state).toBe('unknown');

    // Act
    now = 11_000;
    service.ingest(event('turn_settled', 11_000, { eventId: 'poll-idle', origin: 'poll' }));

    // Assert
    const activity = service.getSnapshot(paneId).activity;
    expect(activity.state).toBe('unknown');
    expect(isReadyForMutation(activity)).toBe(false);
  });

  it('accepts a poll idle again once the agent itself resolved the wait', () => {
    // Arrange
    let now = 100;
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => now });
    service.registerPane(paneId, paneIncarnationId);
    handshake(service);
    service.setLiveness(paneId, 'running');
    service.ingest(event('wait_started', 100, { turnId: 'turn-1', waitReason: 'permission' }));

    // Act
    now = 1_000;
    service.ingest(event('wait_resolved', 1_000, { turnId: 'turn-1' }));
    now = 2_000;
    service.ingest(event('turn_settled', 2_000, { eventId: 'poll-idle', origin: 'poll', turnId: 'turn-1' }));

    // Assert
    expect(service.getSnapshot(paneId).activity.state).toBe('idle');
  });
});

describe('PaneActivityService — back-to-back turns', () => {
  it('promotes a newer turn candidate instead of shortcutting back to the superseded turn', () => {
    // Arrange — a follow-up prompt lands while the previous Stop is still pending
    let now = 100;
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => now });
    service.registerPane(paneId, paneIncarnationId);
    handshake(service);
    service.setLiveness(paneId, 'running');
    service.ingest(event('turn_started', 100, { turnId: 'turn-1' }));
    now = 200;
    service.ingest(event('turn_end_candidate', 200, { eventId: 'stop-1', turnId: 'turn-1' }));
    now = 300;
    service.ingest(event('turn_start_candidate', 300, { eventId: 'start-2', turnId: 'turn-2' }));

    // Act
    now = 1_000;
    service.ingest(event('turn_started', 1_000, { eventId: 'poll-working', origin: 'poll', turnId: 'turn-2' }));
    now = 4_000;
    service.sweep();

    // Assert — the new turn owns the record, so its settle still lands
    expect(service.getSnapshot(paneId).activity).toMatchObject({ state: 'working', turnId: 'turn-2' });
    now = 4_100;
    service.ingest(event('turn_settled', 4_100, { eventId: 'stop-2', turnId: 'turn-2' }));
    expect(service.getSnapshot(paneId).activity.state).toBe('idle');
  });
});

describe('PaneActivityService — a candidate is an overlay, not a commitment', () => {
  it('leaves the standing turn usable when a start candidate is never corroborated', () => {
    // Arrange — a sibling hook blocks the new prompt, so T2 never becomes real
    let now = 100;
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => now });
    service.registerPane(paneId, paneIncarnationId);
    handshake(service);
    service.setLiveness(paneId, 'running');
    service.ingest(event('turn_started', 100, { turnId: 'turn-1' }));
    now = 300;
    service.ingest(event('turn_start_candidate', 300, { eventId: 'blocked-2', turnId: 'turn-2' }));
    now = 3_400;
    service.sweep();
    expect(service.getSnapshot(paneId).activity).toMatchObject({ state: 'working', turnId: 'turn-1' });

    // Act — the original turn is still running and the poll still sees it
    for (let elapsed = 4_000; elapsed <= 20_000; elapsed += 4_000) {
      now = elapsed;
      service.sweep();
      service.ingest(event('turn_started', now, { eventId: `poll-${now}`, origin: 'poll', turnId: 'turn-1' }));
    }

    // Assert — freshness for turn-1 is still accepted well past the original lease
    expect(service.getSnapshot(paneId).activity).toMatchObject({ state: 'working', turnId: 'turn-1' });
    expect(service.getTrace(paneId)).not.toContainEqual(
      expect.objectContaining({ detail: 'completed or superseded turn' }),
    );
  });
});

describe('PaneActivityService — background work outlives its turn', () => {
  it('accepts the completion of a subagent that finished after its parent turn settled', () => {
    // Arrange
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => 100 });
    service.registerPane(paneId, paneIncarnationId);
    handshake(service);
    service.setLiveness(paneId, 'running');
    service.ingest(event('turn_started', 100, { sessionId: 'session-a', turnId: 'turn-1' }));
    service.ingest(event('background_started', 101, {
      sessionId: 'session-a',
      turnId: 'turn-1',
      entityId: 'sub-1',
      entity: { kind: 'subagent', mutating: true, sinceWallMs: 1 },
    }));
    service.ingest(event('turn_settled', 102, { sessionId: 'session-a', turnId: 'turn-1' }));
    expect(isReadyForMutation(service.getSnapshot(paneId).activity)).toBe(false);

    // Act — the subagent finishes after its parent turn already closed
    service.ingest(event('background_ended', 103, { sessionId: 'session-a', turnId: 'turn-1', entityId: 'sub-1' }));

    // Assert
    const activity = service.getSnapshot(paneId).activity;
    expect(activity.openBackgroundWork).toEqual([]);
    expect(isReadyForMutation(activity)).toBe(true);
  });
});
