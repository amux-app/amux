import type { MuxBasePane } from 'muxbase/core';
import type { NormalizedSession } from '../../shared/agent-session-types';
import type { AgentTurnStateSnapshot } from '../../shared/agent-turn-state';
import type { PaneActivity, PaneActivityState } from '../../shared/pane-activity';

type PaneAttentionKind = 'waiting' | 'ready';

export type PaneAttentionReason =
  | 'just-finished'
  | 'session-input'
  | 'session-question';

export interface PaneAttention {
  paneId: string;
  kind: PaneAttentionKind;
  reason: PaneAttentionReason;
}

export type PaneAttentionSession =
  | (AgentTurnStateSnapshot & Pick<NormalizedSession, 'pendingUserQuestion'>)
  | null
  | undefined;

export const PANE_ATTENTION_PHRASES: Record<PaneAttentionReason, string> = {
  'just-finished': 'finished',
  'session-input': 'needs input',
  'session-question': 'asked a question',
};

function hasText(value: string | undefined): boolean {
  return value !== undefined && value.length > 0;
}

function isSessionAwaitingUser(session: PaneAttentionSession): boolean {
  return session?.awaitingUserInput === true || hasText(session?.pendingUserQuestion);
}

export function getEffectivePaneStatus(
  pane: MuxBasePane,
  session: PaneAttentionSession,
  activity?: PaneActivity,
): PaneActivityState {
  // Once the activity stream exists it is the only live-state authority. A
  // missing snapshot is deliberately unknown during boot, never a persisted
  // working/waiting value from the pane record.
  if (activity) {
    // A confirmed idle activity state plus an independently parsed user-input
    // marker is a valid waiting overlay. Never let that overlay revive a
    // starting/working/stopped pane.
    if (activity.state === 'idle' && isSessionAwaitingUser(session)) return 'waiting';
    return activity.state;
  }
  if (isSessionAwaitingUser(session)) return 'waiting';
  return 'unknown';
}

export function isPaneWaitingForUser(
  pane: MuxBasePane,
  session: PaneAttentionSession,
  effectiveStatus: PaneActivityState | undefined,
): boolean {
  if (effectiveStatus === 'waiting') return true;
  if (effectiveStatus !== 'unknown') return false;
  return isSessionAwaitingUser(session);
}

function resolveWaitingReason(session: PaneAttentionSession): PaneAttentionReason {
  return session?.awaitingUserInput === true ? 'session-input' : 'session-question';
}

export function getPaneAttention(
  pane: MuxBasePane,
  session: PaneAttentionSession,
  justFinishedPaneIds: ReadonlySet<string>,
  activity?: PaneActivity,
): PaneAttention | null {
  if (isPaneWaitingForUser(pane, session, getEffectivePaneStatus(pane, session, activity))) {
    return { paneId: pane.id, kind: 'waiting', reason: resolveWaitingReason(session) };
  }
  if (justFinishedPaneIds.has(pane.id)) {
    return { paneId: pane.id, kind: 'ready', reason: 'just-finished' };
  }
  return null;
}
