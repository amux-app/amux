import type { AgentName } from 'aumx/core';

/**
 * Runtime-only agent activity. This contract deliberately contains no pane
 * configuration fields: activity is observed truth, never durable config.
 */
export type PaneActivityState = 'unknown' | 'starting' | 'working' | 'waiting' | 'idle' | 'stopped';
type ActivityCertainty = 'confirmed' | 'provisional';
export type ActivityOrigin = 'adapter' | 'session-log' | 'stream' | 'poll' | 'liveness' | 'none';
export type Liveness = 'running' | 'stopped' | 'unknown';
type AdapterHealth = 'healthy' | 'degraded' | 'absent';
type AdapterSupportLevel = 'full' | 'partial' | 'none';
type ActivityAdapterCapability =
  | 'turnIds'
  | 'notifications'
  | 'backgroundSnapshots'
  | 'compaction'
  | 'backgroundEntities';
type BackgroundEntityKind = 'subagent' | 'task' | 'cron' | 'shell' | 'mcp' | 'unknown';

interface BackgroundEntity {
  entityId: string;
  kind: BackgroundEntityKind;
  mutating: boolean | 'unknown';
  sinceWallMs: number;
}

export interface PaneActivity {
  activityRevision: number;
  state: PaneActivityState;
  certainty: ActivityCertainty;
  origin: ActivityOrigin;
  liveness: Liveness;
  adapterHealth: AdapterHealth;
  adapterSupport?: AdapterSupportLevel;
  adapterVersion?: string;
  adapterCapabilities?: ActivityAdapterCapability[];
  paneIncarnationId: string;
  sessionId?: string;
  turnId?: string;
  waitReason?: 'permission' | 'question' | 'elicitation';
  openBackgroundWork: BackgroundEntity[];
  sinceWallMs: number;
}

export interface VersionedActivity {
  epochId: string;
  revision: number;
  activity: PaneActivity;
}

export interface ActivitySnapshot {
  epochId: string;
  revision: number;
  panes: Record<string, PaneActivity>;
}

type ActivityEventKind =
  | 'turn_start_candidate'
  | 'turn_end_candidate'
  | 'turn_failure_candidate'
  | 'wait_started_candidate'
  | 'turn_started'
  | 'turn_settled'
  | 'turn_failed'
  | 'turn_interrupted'
  | 'wait_started'
  | 'wait_resolved'
  | 'session_start'
  | 'session_end'
  | 'adapter_handshake'
  | 'background_started'
  | 'background_ended'
  | 'background_snapshot'
  | 'compaction_started'
  | 'compaction_settled';

export interface PaneActivityEvent {
  paneId: string;
  paneIncarnationId: string;
  sessionId?: string;
  turnId?: string;
  entityId?: string;
  entity?: Omit<BackgroundEntity, 'entityId'>;
  kind: ActivityEventKind;
  origin: ActivityOrigin;
  eventId: string;
  emittedAt?: number;
  receivedAt: number;
  receiveSeq: number;
  waitReason?: PaneActivity['waitReason'];
  adapterSupport?: AdapterSupportLevel;
  adapterVersion?: string;
  adapterCapabilities?: ActivityAdapterCapability[];
  backgroundSnapshot?: BackgroundEntity[];
}

/** Events entering the main-process owner before receive ordering is assigned. */
export type PaneActivityEventInput = Omit<PaneActivityEvent, 'receivedAt' | 'receiveSeq'> & {
  receivedAt?: number;
  receiveSeq?: number;
};

export interface PaneActivityChange {
  paneId: string;
  activity: PaneActivity;
}

export interface PaneActivityChangedEvent {
  epochId: string;
  revision: number;
  changes: PaneActivityChange[];
  removedPaneIds?: string[];
}

/** Safe for any action that can mutate source, worktree, or review state. */
export function isReadyForMutation(activity: PaneActivity | undefined): boolean {
  return activity?.state === 'idle'
    && activity.certainty === 'confirmed'
    && activity.liveness === 'running'
    && activity.openBackgroundWork.every((entity) => entity.mutating === false);
}

export function isBusyForKanban(activity: PaneActivity | undefined): boolean {
  return activity?.state === 'working' || activity?.state === 'starting';
}

/** Claude's observer is part of its existing session settings; other adapters require explicit consent. */
export function shouldConsumeLifecycleAdapterEvents(
  agent: AgentName | undefined,
  adaptersEnabled: boolean,
): boolean {
  return agent === 'claude' || adaptersEnabled;
}

export function clonePaneActivity(activity: PaneActivity): PaneActivity {
  return {
    ...activity,
    openBackgroundWork: activity.openBackgroundWork.map((entity) => ({ ...entity })),
  };
}

export interface ReadinessToken {
  activityRevision: number;
  epochId: string;
  paneIncarnationId: string;
}

export function captureReadinessToken(snapshot: VersionedActivity): ReadinessToken {
  return {
    activityRevision: snapshot.activity.activityRevision,
    epochId: snapshot.epochId,
    paneIncarnationId: snapshot.activity.paneIncarnationId,
  };
}

export type ReadinessRevalidation =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Re-checks readiness right before a mutating action commits, closing the
 * gap between an earlier readiness check and the point of mutation. Only
 * the pane's identity changing (rebind/recreate, or the whole activity
 * epoch resetting) or it no longer being ready is a reason to abort.
 */
export function revalidateReadiness(
  token: ReadinessToken | undefined,
  current: VersionedActivity | undefined,
  blockReason: string | undefined,
): ReadinessRevalidation {
  if (token && !current) {
    return { ok: false, reason: 'The pane activity is no longer available' };
  }
  if (token && current
    && (current.epochId !== token.epochId || current.activity.paneIncarnationId !== token.paneIncarnationId)) {
    return { ok: false, reason: 'The pane was recreated since this action started' };
  }
  if (token && current && current.activity.activityRevision !== token.activityRevision) {
    return { ok: false, reason: 'The pane activity changed while this action was preparing' };
  }
  if (blockReason) {
    return { ok: false, reason: blockReason };
  }
  return { ok: true };
}
