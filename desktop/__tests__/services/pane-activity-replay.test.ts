import { describe, expect, it } from 'vitest';
import { isReadyForMutation, type PaneActivityEventInput } from '../../src/shared/pane-activity';
import { PaneActivityService } from '../../src/main/services/PaneActivityService';

const PANE_ID = 'pane-replay';
const INCARNATION = 'incarnation-replay';

type ReplayCase = { name: string; events: PaneActivityEventInput[] };

function event(kind: PaneActivityEventInput['kind'], id: string, overrides: Partial<PaneActivityEventInput> = {}): PaneActivityEventInput {
  return {
    eventId: id,
    kind,
    origin: 'adapter',
    paneId: PANE_ID,
    paneIncarnationId: INCARNATION,
    sessionId: 'session-1',
    turnId: 'turn-1',
    ...overrides,
  };
}

const replayCases: ReplayCase[] = Array.from({ length: 80 }, (_, index) => {
  const variant = index % 8;
  const events: PaneActivityEventInput[] = [
    event('adapter_handshake', `handshake-${index}`, {
      adapterVersion: '2.1.200',
      adapterSupport: 'full',
      adapterCapabilities: ['turnIds', 'backgroundEntities'],
      turnId: undefined,
    }),
  ];
  if (variant === 0) {
    events.push(event('turn_start_candidate', `start-candidate-${index}`));
    events.push(event('turn_started', `start-${index}`));
    events.push(event('turn_end_candidate', `end-candidate-${index}`));
    events.push(event('turn_started', `continuation-${index}`));
  } else if (variant === 1) {
    events.push(event('turn_started', `start-${index}`));
    events.push(event('turn_started', `new-start-${index}`, { turnId: 'turn-2' }));
    events.push(event('turn_settled', `late-old-settle-${index}`));
  } else if (variant === 2) {
    events.push(event('turn_started', `start-${index}`));
    events.push(event('wait_started', `wait-${index}`, { waitReason: 'permission' }));
    events.push(event('wait_resolved', `resume-${index}`));
  } else if (variant === 3) {
    events.push(event('turn_started', `start-${index}`));
    events.push(event('background_started', `background-start-${index}`, {
      entityId: `task-${index}`,
      entity: { kind: 'task', mutating: true, sinceWallMs: index },
    }));
    events.push(event('turn_settled', `settle-${index}`));
    events.push(event('background_ended', `background-end-${index}`, { entityId: `task-${index}` }));
  } else if (variant === 4) {
    events.push(event('turn_started', `start-${index}`));
    events.push(event('background_snapshot', `snapshot-${index}`, {
      backgroundSnapshot: [{ entityId: `task-${index}`, kind: 'task', mutating: 'unknown', sinceWallMs: index }],
    }));
    events.push(event('turn_settled', `settle-${index}`));
  } else if (variant === 5) {
    events.push(event('turn_started', `start-${index}`));
    events.push(event('turn_failure_candidate', `failure-${index}`));
    events.push(event('turn_started', `retry-${index}`));
  } else if (variant === 6) {
    events.push(event('turn_started', `start-${index}`));
    events.push(event('compaction_started', `compact-start-${index}`, { turnId: undefined }));
    events.push(event('compaction_settled', `compact-end-${index}`, { turnId: undefined }));
  } else {
    events.push(event('turn_started', `start-${index}`));
    events.push(event('session_start', `new-session-${index}`, { sessionId: `session-${index}` , turnId: undefined }));
    events.push(event('turn_started', `new-turn-${index}`, { sessionId: `session-${index}`, turnId: `turn-new-${index}` }));
    events.push(event('turn_settled', `old-session-settle-${index}`));
  }
  return { name: `replay-${String(index + 1).padStart(2, '0')}`, events };
});

describe('PaneActivityService deterministic replay matrix', () => {
  it.each(replayCases)('$name produces a bounded, policy-safe state after every event', ({ events }) => {
    let monotonic = 0;
    let wall = 1_700_000_000_000;
    const service = new PaneActivityService({
      epochId: 'replay-epoch',
      monotonicNow: () => monotonic,
      wallNow: () => wall,
    });
    service.registerPane(PANE_ID, INCARNATION);

    for (const [index, replayEvent] of events.entries()) {
      monotonic = index * 100;
      wall += 50;
      service.ingest(replayEvent);
      const activity = service.getSnapshot(PANE_ID).activity;
      expect(['unknown', 'starting', 'working', 'waiting', 'idle', 'stopped']).toContain(activity.state);
      expect(['confirmed', 'provisional']).toContain(activity.certainty);
      expect(activity.openBackgroundWork.every((entity) => entity.entityId.length > 0)).toBe(true);
      if (activity.state !== 'idle' || activity.certainty !== 'confirmed') {
        expect(isReadyForMutation(activity)).toBe(false);
      }
    }
  });
});
