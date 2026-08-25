import type { AgentStatus } from 'muxbase/core';
import type { NormalizedSession } from '../../shared/agent-session-types.js';
import { deriveAgentTurnState } from '../../shared/agent-turn-state.js';
import {
  captureReadinessToken,
  isReadyForMutation,
  revalidateReadiness,
  type PaneActivity,
  type ReadinessToken,
  type VersionedActivity,
} from '../../shared/pane-activity.js';
import type { PaneActivityService } from './PaneActivityService.js';

const READINESS_UNVERIFIED_MESSAGE = 'Could not confirm the pane is still idle — try again in a moment';

/**
 * Projects PaneActivityService's evidence sources onto the shared readiness
 * policy used by main-process mutating actions.
 */
export class PaneActivityProjection {
  private pollSeq = 0;

  constructor(private readonly getService: () => PaneActivityService | null) {}

  recordPollActivity(paneId: string, status: AgentStatus): void {
    const service = this.getService();
    if (!service) return;
    let current;
    try {
      current = service.getSnapshot(paneId).activity;
    } catch {
      return;
    }
    const receivedAt = Date.now();
    const working = status === 'working' || status === 'analyzing';
    // Every delivery is a fresh observation, never a retransmission, so the id
    // must be unique per delivery — a wall-clock stamp collides within a tick.
    this.pollSeq += 1;
    service.ingest({
      eventId: `poll:${paneId}:${status}:${this.pollSeq}`,
      kind: working ? 'turn_started' : 'turn_settled',
      origin: 'poll',
      paneId,
      paneIncarnationId: current.paneIncarnationId,
      receivedAt,
      sessionId: current.sessionId,
      turnId: current.turnId,
    });
  }

  recordSessionActivity(paneId: string, session: NormalizedSession): void {
    const service = this.getService();
    if (!service) return;
    let current;
    try {
      current = service.getSnapshot(paneId).activity;
    } catch {
      return;
    }
    const receivedAt = Date.now();
    const derivedTurnState = deriveAgentTurnState(session);
    if (derivedTurnState === 'unknown') return;
    const turnState = derivedTurnState === 'awaiting_input'
      ? 'wait_started'
      : derivedTurnState === 'completed'
        ? 'turn_settled'
        : 'turn_started';
    service.ingest({
      eventId: `session:${paneId}:${session.sessionId ?? 'unknown'}:${turnState}:${session.lastUpdateTime ?? receivedAt}`,
      kind: turnState,
      origin: 'session-log',
      paneId,
      paneIncarnationId: current.paneIncarnationId,
      receivedAt,
      sessionId: session.sessionId,
      turnId: current.turnId,
      waitReason: session.awaitingUserInput === true ? 'question' : undefined,
    });
  }

  getPaneActivity(paneId: string): PaneActivity | undefined {
    return this.getPaneActivitySnapshotFor(paneId)?.activity;
  }

  getPaneActivitySnapshotFor(paneId: string): VersionedActivity | undefined {
    try {
      return this.getService()?.getSnapshot(paneId);
    } catch {
      return undefined;
    }
  }

  captureReadinessTokenFor(paneId: string): ReadinessToken | undefined {
    const snapshot = this.getPaneActivitySnapshotFor(paneId);
    return snapshot ? captureReadinessToken(snapshot) : undefined;
  }

  /**
   * Re-fetches `pane` and re-runs `blockReasonFn` right before a mutating
   * action commits, closing the gap since `token` was captured. Collapses
   * the "pane vanished" and "pane no longer ready" cases into one rejection
   * so call sites only need a single branch.
   *
   * When no token was captured, identity was never verified; require a fresh,
   * genuinely ready activity snapshot instead of repeating a stale check.
   */
  revalidateReadinessOrReject<T extends { id: string }>(
    pane: T | undefined,
    token: ReadinessToken | undefined,
    blockReasonFn: (pane: T) => string | undefined,
    notFoundReason: string,
  ): { ok: true; pane: T } | { ok: false; reason: string } {
    if (!pane) return { ok: false, reason: notFoundReason };
    if (!token) {
      const freshActivity = this.getPaneActivitySnapshotFor(pane.id)?.activity;
      if (!isReadyForMutation(freshActivity)) {
        return { ok: false, reason: blockReasonFn(pane) ?? READINESS_UNVERIFIED_MESSAGE };
      }
      return { ok: true, pane };
    }
    const revalidation = revalidateReadiness(token, this.getPaneActivitySnapshotFor(pane.id), blockReasonFn(pane));
    if (!revalidation.ok) return { ok: false, reason: revalidation.reason };
    return { ok: true, pane };
  }
}
