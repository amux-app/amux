import { EventEmitter } from 'events';
import {
  clonePaneActivity,
  type ActivityOrigin,
  type ActivitySnapshot,
  type Liveness,
  type PaneActivity,
  type PaneActivityChange,
  type PaneActivityChangedEvent,
  type PaneActivityEvent,
  type PaneActivityEventInput,
  type VersionedActivity,
} from '../../shared/pane-activity.js';

const CANDIDATE_WINDOWS: Partial<Record<PaneActivityEvent['kind'], number>> = {
  turn_start_candidate: 3_000,
  turn_end_candidate: 3_000,
  turn_failure_candidate: 3_000,
  wait_started_candidate: 1_000,
};
const OPEN_TURN_LEASE_MS = 10_000;
// Agent boot legitimately runs far longer than a turn, so `starting` gets its
// own bound rather than blanking the indicator mid-launch.
const STARTING_LEASE_MS = 60_000;
const TURN_END_QUIESCENCE_MS = 250;
const TRACE_LIMIT = 50;

type Candidate = {
  activity: PaneActivity;
  createdAt: number;
  expiresAt: number;
  idleCorroboratedBy?: ActivityOrigin;
  kind: Extract<PaneActivityEvent['kind'], 'turn_start_candidate' | 'turn_end_candidate' | 'turn_failure_candidate' | 'wait_started_candidate'>;
  turnId?: string;
};

/** States that mean "something is in flight", so they need an evidence lease. */
const OPEN_STATES: ReadonlySet<PaneActivity['state']> = new Set(['starting', 'waiting', 'working']);

type PaneRecord = {
  activityRevision: number;
  base: PaneActivity;
  candidate?: Candidate;
  eventIds: Set<string>;
  completedTurnKeys: Set<string>;
  supersededTurnKeys: Set<string>;
  backgroundSessions: Map<string, string | undefined>;
  closedBackgroundEntityIds: Set<string>;
  leaseExpiresAt?: number;
  /** A prompt the user has not answered. Outlives the `waiting` display state. */
  unresolvedWait?: true;
  trace: PaneActivityTraceEntry[];
};

export interface PaneActivityTraceEntry {
  at: number;
  type: 'event' | 'resolution' | 'discard';
  detail: string;
}

export interface PaneActivityServiceOptions {
  epochId?: string;
  /** Monotonic clock used for all expiry, quiescence, lease and freshness work. */
  monotonicNow?: () => number;
  /** Wall clock used only for published display timestamps. */
  wallNow?: () => number;
  /** Deprecated alias retained for callers that only supplied one fake clock. */
  now?: () => number;
}

/**
 * Main-process owner of all live pane activity. It is intentionally agnostic
 * about tmux, hook files, and session logs; those components only submit
 * normalised evidence here.
 */
export class PaneActivityService extends EventEmitter {
  readonly epochId: string;

  private readonly monotonicNow: () => number;
  private readonly wallNow: () => number;
  private readonly panes = new Map<string, PaneRecord>();
  private receiveSeq = 0;
  private revision = 0;

  constructor(options: PaneActivityServiceOptions = {}) {
    super();
    this.epochId = options.epochId ?? createEpochId();
    this.monotonicNow = options.monotonicNow ?? options.now ?? defaultMonotonicNow;
    this.wallNow = options.wallNow ?? options.now ?? Date.now;
  }

  registerPane(paneId: string, paneIncarnationId: string, options: { starting?: boolean; adapterHealth?: PaneActivity['adapterHealth'] } = {}): void {
    const existing = this.panes.get(paneId);
    if (existing?.base.paneIncarnationId === paneIncarnationId) return;

    const starting = options.starting === true;
    const base = createActivity(paneIncarnationId, this.wallNow(), starting ? 'starting' : 'unknown', {
      adapterHealth: options.adapterHealth ?? 'degraded',
    });
    this.panes.set(paneId, {
      activityRevision: 0,
      base,
      completedTurnKeys: new Set(),
      supersededTurnKeys: new Set(),
      backgroundSessions: new Map(),
      closedBackgroundEntityIds: new Set(),
      eventIds: new Set(),
      leaseExpiresAt: starting ? this.monotonicNow() + STARTING_LEASE_MS : undefined,
      trace: [],
    });
    this.publish(paneId, 'registered');
  }

  removePane(paneId: string): void {
    if (!this.panes.delete(paneId)) return;
    this.revision += 1;
    this.emitChanged([], [paneId]);
  }

  dispose(): void {
    this.panes.clear();
    this.removeAllListeners();
  }

  getSnapshot(): ActivitySnapshot;
  getSnapshot(paneId: string): VersionedActivity;
  getSnapshot(paneId?: string): ActivitySnapshot | VersionedActivity {
    if (paneId !== undefined) {
      const record = this.panes.get(paneId);
      if (!record) {
        throw new Error(`No activity is registered for pane ${paneId}`);
      }
      return {
        activity: clonePaneActivity(this.current(record)),
        epochId: this.epochId,
        revision: this.revision,
      };
    }

    const panes: Record<string, PaneActivity> = {};
    for (const [id, record] of this.panes) panes[id] = clonePaneActivity(this.current(record));
    return { epochId: this.epochId, revision: this.revision, panes };
  }

  getTrace(paneId: string): readonly PaneActivityTraceEntry[] {
    return [...(this.panes.get(paneId)?.trace ?? [])];
  }

  setLiveness(paneId: string, liveness: Liveness): void {
    const record = this.panes.get(paneId);
    if (!record || record.base.liveness === liveness) return;
    const previous = this.current(record);

    if (liveness === 'stopped') {
      record.candidate = undefined;
      record.leaseExpiresAt = undefined;
      record.unresolvedWait = undefined;
      record.base = {
        ...record.base,
        certainty: 'confirmed',
        liveness,
        origin: 'liveness',
        sinceWallMs: this.wallNow(),
        state: 'stopped',
        turnId: undefined,
      };
    } else {
      // Only liveness produces `stopped`, so only liveness may retract it.
      const wasStopped = record.base.state === 'stopped';
      record.base = {
        ...record.base,
        liveness,
        ...(wasStopped
          ? { certainty: 'provisional' as const, origin: 'none' as const, sinceWallMs: this.wallNow(), state: 'unknown' as const }
          : {}),
      };
    }

    this.publishIfChanged(paneId, previous, 'liveness');
  }

  setAdapterHealth(paneId: string, adapterHealth: PaneActivity['adapterHealth']): void {
    const record = this.panes.get(paneId);
    if (!record || record.base.adapterHealth === adapterHealth) return;
    const previous = this.current(record);
    record.base = {
      ...record.base,
      adapterHealth,
      ...(adapterHealth !== 'healthy' && record.base.origin === 'adapter' ? { certainty: 'provisional' as const } : {}),
    };
    if (record.candidate) {
      record.candidate = {
        ...record.candidate,
        activity: {
          ...record.candidate.activity,
          adapterHealth,
          ...(adapterHealth !== 'healthy' && record.candidate.activity.origin === 'adapter'
            ? { certainty: 'provisional' as const }
            : {}),
        },
      };
    }
    this.publishIfChanged(paneId, previous, 'adapter health');
  }

  ingest(event: PaneActivityEventInput): void {
    this.applyEvent(this.normalizeEvent(event), true);
  }

  private applyEvent(event: PaneActivityEvent, publishChange: boolean): boolean {
    const record = this.panes.get(event.paneId);
    if (!record) return false;
    const previous = this.current(record);
    const monotonicNow = this.monotonicNow();

    const discardReason = this.discardReason(record, event);
    if (discardReason) {
      this.trace(record, monotonicNow, 'discard', discardReason);
      return false;
    }
    record.eventIds.add(event.eventId);
    this.trimEventIds(record);
    this.trace(record, monotonicNow, 'event', `${event.kind}#${event.receiveSeq}`);
    const previousSessionId = record.base.sessionId;
    const previousTurnId = record.base.turnId;
    if (event.sessionId && (event.kind === 'session_start' || !record.base.sessionId)) {
      record.base = { ...record.base, sessionId: event.sessionId };
    }

    if (!this.handleSessionEvent(record, event, monotonicNow, previousSessionId, previousTurnId)
      && !this.handleTurnEvent(record, event, monotonicNow)
      && !this.handleWaitEvent(record, event, monotonicNow)) {
      this.handleSideEffectEvent(record, event, monotonicNow);
    }

    if (publishChange) this.publishIfChanged(event.paneId, previous, event.kind);
    return true;
  }

  private handleSessionEvent(
    record: PaneRecord,
    event: PaneActivityEvent,
    now: number,
    previousSessionId: string | undefined,
    previousTurnId: string | undefined,
  ): boolean {
    if (event.kind === 'session_start') {
      if (previousTurnId) this.supersedeTurn(record, previousSessionId, previousTurnId);
      record.backgroundSessions.clear();
      record.closedBackgroundEntityIds.clear();
      record.candidate = undefined;
      record.unresolvedWait = undefined;
      record.base = {
        ...record.base,
        liveness: event.origin === 'adapter' ? 'running' : 'unknown',
        waitReason: undefined,
      };
      this.resolve(record, now, 'starting', 'provisional', event.origin, { ...event, turnId: undefined });
      return true;
    }
    if (event.kind === 'session_end') {
      // Never `stopped`: /clear and resume end a session with the process alive.
      if (previousTurnId) this.supersedeTurn(record, previousSessionId, previousTurnId);
      record.candidate = undefined;
      record.unresolvedWait = undefined;
      this.resolve(record, now, record.base.liveness === 'running' ? 'starting' : 'unknown', 'provisional', event.origin, {
        kind: 'session_end',
        sessionId: undefined,
        turnId: undefined,
      });
      return true;
    }
    return false;
  }

  private handleTurnEvent(record: PaneRecord, event: PaneActivityEvent, now: number): boolean {
    switch (event.kind) {
      case 'turn_start_candidate':
        // Overlay only. Superseding the standing turn here would strand it if
        // the candidate is never corroborated; `turn_started` does that once
        // the new turn is real.
        this.setCandidate(record, now, 'working', event);
        return true;
      case 'turn_end_candidate':
        if (this.matchesCurrentTurn(record, event)) {
          if (event.backgroundSnapshot) this.reconcileBackgroundWork(record, event, this.wallNow());
          this.setCandidate(record, now, 'idle', event);
        }
        return true;
      case 'turn_failure_candidate':
        if (this.matchesCurrentTurn(record, event)) this.setCandidate(record, now, 'unknown', event);
        return true;
      case 'turn_started':
        // Freshness for the working state we already hold. A working candidate
        // may carry a newer turn, so it is promoted through the normal path
        // instead; any other candidate is refuted by the visible marker.
        if (event.origin === 'poll'
          && record.base.state === 'working'
          && record.candidate?.activity.state !== 'working') {
          record.candidate = undefined;
          this.renewOpenStateLease(record, now);
          return true;
        }
        this.beginTurn(record, event);
        record.candidate = undefined;
        if (event.origin !== 'poll') record.unresolvedWait = undefined;
        this.resolve(record, now, 'working', certaintyFor(record, event), event.origin, event);
        return true;
      case 'turn_settled':
      case 'turn_failed':
      case 'turn_interrupted':
        this.settleTurn(record, event, now);
        return true;
      default:
        return false;
    }
  }

  private settleTurn(record: PaneRecord, event: PaneActivityEvent, now: number): void {
    if (!this.matchesCurrentTurn(record, event)) return;
    // A permission prompt paints no working marker, so the visible frame reads
    // as idle. Only the agent can retire a wait, and the wait outlives the
    // `waiting` display state — its lease may already have degraded it.
    if (record.unresolvedWait && event.origin === 'poll') {
      this.trace(record, now, 'discard', 'poll idle cannot settle an open wait');
      return;
    }
    record.unresolvedWait = undefined;
    const certainty = this.settleCertainty(record, event, now);
    if (certainty === 'provisional' && record.candidate?.kind === 'turn_end_candidate') {
      record.candidate = { ...record.candidate, idleCorroboratedBy: event.origin };
      this.trace(record, now, 'resolution', `idle corroborated before quiescence by ${event.origin}`);
      return;
    }
    record.candidate = undefined;
    this.completeTurn(record, event);
    this.resolve(record, now, 'idle', certainty, event.origin, event);
  }

  private handleWaitEvent(record: PaneRecord, event: PaneActivityEvent, now: number): boolean {
    switch (event.kind) {
      case 'wait_started_candidate':
        if (this.matchesCurrentTurn(record, event, true)) this.setCandidate(record, now, 'waiting', event);
        return true;
      case 'wait_started':
        record.candidate = undefined;
        record.unresolvedWait = true;
        this.resolve(record, now, 'waiting', certaintyFor(record, event), event.origin, event);
        return true;
      case 'wait_resolved':
        if (this.matchesCurrentTurn(record, event, true)) {
          record.candidate = undefined;
          record.unresolvedWait = undefined;
          this.resolve(record, now, 'working', certaintyFor(record, event), event.origin, event);
        }
        return true;
      default:
        return false;
    }
  }

  /** Evidence that annotates a pane without moving its activity state. */
  private handleSideEffectEvent(record: PaneRecord, event: PaneActivityEvent, now: number): void {
    switch (event.kind) {
      case 'adapter_handshake':
        this.applyAdapterHandshake(record, event);
        break;
      case 'background_started':
        this.startBackgroundWork(record, event, this.wallNow());
        break;
      case 'background_ended':
        this.endBackgroundWork(record, event);
        break;
      case 'background_snapshot':
        this.reconcileBackgroundWork(record, event, this.wallNow());
        break;
      case 'compaction_started':
      case 'compaction_settled':
        // Maintenance inside the current state: liveness evidence, not a turn.
        this.renewOpenStateLease(record, now);
        break;
    }
  }

  /** Journal recovery reconstructs shape but must never become action-ready. */
  replay(event: PaneActivityEventInput): void {
    const normalized = this.normalizeEvent(event);
    const record = this.panes.get(normalized.paneId);
    if (!record || record.base.paneIncarnationId !== normalized.paneIncarnationId) return;
    const previous = clonePaneActivity(this.current(record));
    if (!this.applyEvent(normalized, false)) return;
    record.base = { ...record.base, adapterHealth: 'degraded', certainty: 'provisional' };
    if (record.candidate) {
      record.candidate = {
        ...record.candidate,
        activity: { ...record.candidate.activity, adapterHealth: 'degraded', certainty: 'provisional' },
      };
    }
    this.publishIfChanged(normalized.paneId, previous, 'journal replay');
  }

  /** Runs once per second by the bridge; no interval is hidden in this service. */
  sweep(): void {
    const monotonicNow = this.monotonicNow();
    for (const [paneId, record] of this.panes) {
      const previous = this.current(record);
      this.promoteCorroboratedTurnEnd(record, monotonicNow);
      this.expireUncorroboratedCandidate(record, monotonicNow);
      this.expireOpenStateLease(record, monotonicNow);
      this.publishIfChanged(paneId, previous, 'sweep');
    }
  }

  private promoteCorroboratedTurnEnd(record: PaneRecord, now: number): void {
    const candidate = record.candidate;
    if (candidate?.kind !== 'turn_end_candidate'
      || !candidate.idleCorroboratedBy
      || now - candidate.createdAt < TURN_END_QUIESCENCE_MS) return;
    record.candidate = undefined;
    const turnId = candidate.activity.turnId ?? candidate.turnId;
    this.completeTurn(record, { sessionId: candidate.activity.sessionId, turnId });
    this.resolve(record, now, 'idle', 'confirmed', candidate.idleCorroboratedBy, {
      sessionId: candidate.activity.sessionId,
      turnId,
    });
    this.trace(record, now, 'resolution', 'turn end promoted after quiescence');
  }

  /**
   * A window closing proves nothing. Hooks can be blocked or continued by a
   * sibling hook, so an uncorroborated candidate is neither its proposed state
   * nor the state it replaced — both are unverified. Degrade to `unknown` and
   * let the next real observation say what is true.
   */
  private expireUncorroboratedCandidate(record: PaneRecord, now: number): void {
    const candidate = record.candidate;
    if (!candidate || candidate.expiresAt > now) return;
    record.candidate = undefined;
    this.trace(record, now, 'resolution', `${candidate.kind} expired uncorroborated`);
    // A candidate that only restated the standing state made no new claim, so
    // its expiry invalidates nothing. The state's own lease still bounds it.
    if (candidate.activity.state === record.base.state || record.base.state === 'unknown') return;
    this.resolve(record, now, 'unknown', 'provisional', 'none', {});
  }

  private expireOpenStateLease(record: PaneRecord, now: number): void {
    if (record.leaseExpiresAt === undefined || record.leaseExpiresAt > now) return;
    // A candidate still inside its window is live evidence; let it commit.
    if (record.candidate) return;
    if (!OPEN_STATES.has(record.base.state)) {
      record.leaseExpiresAt = undefined;
      return;
    }
    record.candidate = undefined;
    this.resolve(record, now, 'unknown', 'provisional', 'none', {});
    this.trace(record, now, 'resolution', 'open-state evidence lease expired');
  }

  private renewOpenStateLease(record: PaneRecord, now: number): void {
    if (record.leaseExpiresAt === undefined) return;
    record.leaseExpiresAt = now + leaseFor(record.base.state);
  }

  private matchesCurrentTurn(record: PaneRecord, event: PaneActivityEvent, allowNoTurn = false): boolean {
    if (!event.turnId) return allowNoTurn || record.base.turnId === undefined;
    return record.base.turnId === undefined || record.base.turnId === event.turnId;
  }

  private discardReason(record: PaneRecord, event: PaneActivityEvent): string | undefined {
    if (event.paneIncarnationId !== record.base.paneIncarnationId) return 'incarnation mismatch';
    if (record.eventIds.has(event.eventId)) return 'duplicate event';
    if (record.base.sessionId && event.sessionId && event.sessionId !== record.base.sessionId && event.kind !== 'session_start') {
      return 'superseded session';
    }
    if (record.base.liveness === 'stopped' && event.kind !== 'session_start') return 'confirmed stopped liveness';
    // Only a turn-scoped event dies with its turn. Background work legitimately
    // outlives the turn that spawned it and is guarded by session and entity id.
    if (isTurnScoped(event.kind) && this.isClosedOrSupersededTurn(record, event)) {
      return 'completed or superseded turn';
    }
    return undefined;
  }

  private normalizeEvent(event: PaneActivityEventInput): PaneActivityEvent {
    return {
      ...event,
      receivedAt: this.monotonicNow(),
      receiveSeq: this.nextReceiveSeq(),
    };
  }

  private nextReceiveSeq(): number {
    this.receiveSeq += 1;
    return this.receiveSeq;
  }

  private isClosedOrSupersededTurn(record: PaneRecord, event: PaneActivityEvent): boolean {
    if (!event.turnId) return false;
    const key = turnKey(event.sessionId ?? record.base.sessionId, event.turnId);
    return record.completedTurnKeys.has(key) || record.supersededTurnKeys.has(key);
  }

  private beginTurn(record: PaneRecord, event: PaneActivityEvent): void {
    if (!event.turnId) return;
    if (record.base.turnId && record.base.turnId !== event.turnId) {
      this.supersedeTurn(record, record.base.sessionId, record.base.turnId);
    }
  }

  private completeTurn(record: PaneRecord, event: Pick<PaneActivityEvent, 'sessionId' | 'turnId'>): void {
    if (!event.turnId) return;
    addBounded(record.completedTurnKeys, turnKey(event.sessionId ?? record.base.sessionId, event.turnId));
  }

  private supersedeTurn(record: PaneRecord, sessionId: string | undefined, turnId: string): void {
    addBounded(record.supersededTurnKeys, turnKey(sessionId, turnId));
  }

  private applyAdapterHandshake(record: PaneRecord, event: PaneActivityEvent): void {
    const support = event.adapterSupport;
    const capabilities = event.adapterCapabilities;
    const valid = event.origin === 'adapter'
      && typeof event.adapterVersion === 'string'
      && event.adapterVersion.length > 0
      && (support === 'full' || support === 'partial' || support === 'none')
      && Array.isArray(capabilities);
    if (!valid) {
      record.base = { ...record.base, adapterHealth: 'degraded' };
      return;
    }
    record.base = {
      ...record.base,
      adapterHealth: support === 'full' ? 'healthy' : support === 'partial' ? 'degraded' : 'absent',
      adapterSupport: support,
      adapterVersion: event.adapterVersion,
      adapterCapabilities: [...capabilities],
    };
  }

  private setCandidate(record: PaneRecord, now: number, state: PaneActivity['state'], event: PaneActivityEvent): void {
    const window = CANDIDATE_WINDOWS[event.kind];
    if (!window) return;
    if (state === 'waiting') record.unresolvedWait = true;
    const base = record.base;
    record.candidate = {
      activity: {
        ...base,
        certainty: 'provisional',
        origin: event.origin,
        sinceWallMs: this.wallNow(),
        state,
        turnId: event.turnId ?? base.turnId,
        waitReason: state === 'waiting' ? event.waitReason : undefined,
      },
      createdAt: now,
      expiresAt: now + window,
      kind: event.kind as Candidate['kind'],
      turnId: event.turnId,
    };
    this.renewOpenStateLease(record, now);
  }

  private settleCertainty(record: PaneRecord, event: PaneActivityEvent, now: number): PaneActivity['certainty'] {
    if (certaintyFor(record, event) === 'confirmed') return 'confirmed';
    const candidate = record.candidate;
    if (candidate?.kind === 'turn_end_candidate' && candidate.turnId === event.turnId) {
      return now - candidate.createdAt >= TURN_END_QUIESCENCE_MS ? 'confirmed' : 'provisional';
    }
    // PaneStatusAnalyzer emits idle only after redraw-separated stable captures,
    // so one poll edge already represents corroborated evidence. Requiring
    // repeated status-change deliveries is impossible because the detector
    // intentionally suppresses unchanged idle states.
    if (event.origin === 'poll' && event.kind === 'turn_settled') return 'confirmed';
    if (record.base.state === 'idle'
      && record.base.certainty === 'provisional'
      && record.base.origin !== event.origin
      && isIdleCorroborator(record.base.origin)
      && isIdleCorroborator(event.origin)) {
      return 'confirmed';
    }
    return 'provisional';
  }

  /** Single place activity state changes; also owns the evidence lease. */
  private resolve(
    record: PaneRecord,
    now: number,
    state: PaneActivity['state'],
    certainty: PaneActivity['certainty'],
    origin: ActivityOrigin,
    event: Partial<PaneActivityEvent>,
  ): void {
    const resetsSessionScope = event.kind === 'session_end' || event.kind === 'session_start';
    const isOpen = OPEN_STATES.has(state);
    record.base = {
      ...record.base,
      certainty,
      origin,
      sessionId: resetsSessionScope && event.sessionId === undefined ? undefined : event.sessionId ?? record.base.sessionId,
      sinceWallMs: record.base.state === state ? record.base.sinceWallMs : this.wallNow(),
      state,
      // A turn id identifies an open turn only; clearing it lets later unscoped
      // evidence corroborate the pane instead of being dropped as a closed turn.
      turnId: isOpen && !resetsSessionScope ? event.turnId ?? record.base.turnId : undefined,
      waitReason: state === 'waiting' ? event.waitReason ?? record.base.waitReason : undefined,
    };
    record.leaseExpiresAt = isOpen ? now + leaseFor(state) : undefined;
  }

  private startBackgroundWork(record: PaneRecord, event: PaneActivityEvent, now: number): void {
    if (!event.entityId) return;
    if (record.closedBackgroundEntityIds.has(event.entityId)) return;
    const current = new Map(record.base.openBackgroundWork.map((entity) => [entity.entityId, entity]));
    current.set(event.entityId, {
      entityId: event.entityId,
      kind: event.entity?.kind ?? 'unknown',
      mutating: event.entity?.mutating ?? 'unknown',
      sinceWallMs: event.entity?.sinceWallMs ?? now,
    });
    record.backgroundSessions.set(event.entityId, event.sessionId);
    record.base = { ...record.base, openBackgroundWork: [...current.values()] };
  }

  private endBackgroundWork(record: PaneRecord, event: PaneActivityEvent): void {
    if (!event.entityId) return;
    addBounded(record.closedBackgroundEntityIds, event.entityId);
    const entitySession = record.backgroundSessions.get(event.entityId);
    if (entitySession !== undefined && entitySession !== event.sessionId) return;
    record.backgroundSessions.delete(event.entityId);
    record.base = {
      ...record.base,
      openBackgroundWork: record.base.openBackgroundWork.filter((entity) => entity.entityId !== event.entityId),
    };
  }

  private reconcileBackgroundWork(record: PaneRecord, event: PaneActivityEvent, now: number): void {
    const snapshot = event.backgroundSnapshot;
    if (!snapshot) return;
    const next = new Map(snapshot.map((entity) => [entity.entityId, entity]));
    record.backgroundSessions.clear();
    for (const entity of next.values()) {
      record.backgroundSessions.set(entity.entityId, event.sessionId);
      record.closedBackgroundEntityIds.delete(entity.entityId);
    }
    record.base = {
      ...record.base,
      openBackgroundWork: [...next.values()].map((entity) => ({ ...entity, sinceWallMs: entity.sinceWallMs || now })),
    };
  }

  private current(record: PaneRecord): PaneActivity {
    return record.candidate?.activity ?? record.base;
  }

  private publishIfChanged(paneId: string, previous: PaneActivity, detail: string): void {
    const record = this.panes.get(paneId);
    if (!record || activitiesEqual(previous, this.current(record))) return;
    this.publish(paneId, detail);
  }

  private publish(paneId: string, detail: string): void {
    const record = this.panes.get(paneId);
    if (!record) return;
    this.revision += 1;
    // Counted on the record, not the activity: a candidate and its base carry
    // separate copies, so deriving it from the current value can go backwards.
    record.activityRevision += 1;
    const activity = { ...this.current(record), activityRevision: record.activityRevision };
    if (record.candidate) record.candidate = { ...record.candidate, activity };
    else record.base = activity;
    this.trace(record, this.monotonicNow(), 'resolution', detail);
    this.emitChanged([{ paneId, activity: clonePaneActivity(activity) }]);
  }

  private emitChanged(changes: PaneActivityChange[], removedPaneIds: string[] = []): void {
    const event: PaneActivityChangedEvent = { changes, epochId: this.epochId, revision: this.revision };
    if (removedPaneIds.length > 0) event.removedPaneIds = removedPaneIds;
    this.emit('changed', event);
  }

  private trace(record: PaneRecord, at: number, type: PaneActivityTraceEntry['type'], detail: string): void {
    record.trace.push({ at, detail, type });
    if (record.trace.length > TRACE_LIMIT) record.trace.splice(0, record.trace.length - TRACE_LIMIT);
  }

  private trimEventIds(record: PaneRecord): void {
    while (record.eventIds.size > 1_000) {
      const first = record.eventIds.values().next().value;
      if (!first) break;
      record.eventIds.delete(first);
    }
  }
}

function leaseFor(state: PaneActivity['state']): number {
  return state === 'starting' ? STARTING_LEASE_MS : OPEN_TURN_LEASE_MS;
}

function isTurnScoped(kind: PaneActivityEvent['kind']): boolean {
  return kind.startsWith('turn_') || kind.startsWith('wait_');
}

function certaintyFor(record: PaneRecord, event: Pick<PaneActivityEvent, 'origin' | 'kind'>): PaneActivity['certainty'] {
  return event.origin === 'adapter' && record.base.adapterHealth === 'healthy'
    ? 'confirmed'
    : 'provisional';
}

function isIdleCorroborator(origin: ActivityOrigin): boolean {
  return origin === 'session-log' || origin === 'poll';
}

function createActivity(
  paneIncarnationId: string,
  now: number,
  state: PaneActivity['state'],
  overrides: Partial<PaneActivity> = {},
): PaneActivity {
  return {
    activityRevision: 0,
    adapterHealth: 'degraded',
    certainty: 'provisional',
    liveness: 'unknown',
    openBackgroundWork: [],
    origin: 'none',
    paneIncarnationId,
    sinceWallMs: now,
    state,
    ...overrides,
  };
}

function activitiesEqual(left: PaneActivity, right: PaneActivity): boolean {
  return JSON.stringify({ ...left, activityRevision: 0 }) === JSON.stringify({ ...right, activityRevision: 0 });
}

function createEpochId(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultMonotonicNow(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function turnKey(sessionId: string | undefined, turnId: string): string {
  return `${sessionId ?? ''}\u0000${turnId}`;
}

function addBounded(set: Set<string>, value: string): void {
  set.add(value);
  while (set.size > 512) {
    const first = set.values().next().value;
    if (first === undefined) return;
    set.delete(first);
  }
}
