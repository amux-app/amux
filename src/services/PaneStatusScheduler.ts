import {
  WORKER_ACTIVE_POLL_INTERVAL,
  WORKER_IDLE_POLL_INTERVAL,
  WORKER_QUIET_TICKS_BEFORE_IDLE,
} from '../constants/timing.js';
import type { CoordinatedPaneCaptureRequest } from './PaneCaptureCoordinator.js';

type PollTier = 'active' | 'idle';

export interface PaneRegistration {
  paneId: string;
  tmuxPaneId: string;
}

interface ScheduledPane extends PaneRegistration {
  activitySinceCapture: boolean;
  issuedGeneration: number;
  nextDueTick: number;
  notBeforeTick: number;
  pendingSinceTick: number;
  quietTicks: number;
  settledGeneration: number;
  tier: PollTier;
}

function isCapturePending(pane: ScheduledPane): boolean {
  return pane.settledGeneration < pane.issuedGeneration;
}

/**
 * Ticks a capture may stay unacknowledged before its slot is force-cleared.
 * Sized well above one tmux command timeout plus the per-pane fallback fan-out
 * and the coordinator's serialized batches, so it only fires on a lost capture.
 */
export const STALE_PENDING_TICKS = 10;

type DeliverDueCaptures = (requests: CoordinatedPaneCaptureRequest[]) => void;

/**
 * Owns one process-wide status cadence. Pane workers analyze captures, but
 * never own timers: panes due on the same tick are therefore handed to the
 * capture coordinator synchronously as one deterministic batch.
 */
export class PaneStatusScheduler {
  private readonly panes = new Map<string, ScheduledPane>();
  private readonly idleTickCount = Math.max(
    1,
    Math.ceil(WORKER_IDLE_POLL_INTERVAL / WORKER_ACTIVE_POLL_INTERVAL),
  );
  private tick = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deliverDueCaptures: DeliverDueCaptures) {}

  add(registration: PaneRegistration): void {
    if (this.panes.has(registration.paneId)) return;
    this.panes.set(registration.paneId, {
      ...registration,
      activitySinceCapture: false,
      issuedGeneration: 0,
      nextDueTick: this.tick + 1,
      notBeforeTick: 0,
      pendingSinceTick: 0,
      quietTicks: 0,
      settledGeneration: 0,
      tier: 'active',
    });
    this.ensureTimer();
  }

  remove(paneId: string): void {
    this.panes.delete(paneId);
    if (this.panes.size === 0) this.stopTimer();
  }

  isCurrentRequest(request: CoordinatedPaneCaptureRequest): boolean {
    const pane = this.panes.get(request.paneId);
    return pane?.tmuxPaneId === request.tmuxPaneId
      && pane.issuedGeneration === request.generation
      && isCapturePending(pane);
  }

  /**
   * Only the result of the capture currently in flight settles it. A straggler
   * from a generation the watchdog already abandoned - or a duplicate of the
   * pending one - is dropped rather than clobbering the newer result's cadence.
   */
  complete(paneId: string, generation: number, isActive: boolean): void {
    const pane = this.panes.get(paneId);
    if (!pane || generation !== pane.issuedGeneration || !isCapturePending(pane)) return;

    pane.settledGeneration = generation;
    const active = isActive || pane.activitySinceCapture;
    pane.activitySinceCapture = false;

    if (active) {
      pane.quietTicks = 0;
      pane.tier = 'active';
    } else {
      pane.quietTicks++;
      if (pane.quietTicks >= WORKER_QUIET_TICKS_BEFORE_IDLE) {
        pane.tier = 'idle';
      }
    }

    const cadenceTick = pane.tier === 'idle'
      ? this.nextIdleCadenceTick()
      : this.tick + 1;
    pane.nextDueTick = Math.max(cadenceTick, pane.notBeforeTick);
  }

  /**
   * Re-arm the active cadence after direct input or an analysis result.
   * A delay preserves the old option-dialog pause contract: delay first, then
   * wait one active interval before capturing again.
   */
  resumeFast(paneId: string, delayMs = 0): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;

    pane.activitySinceCapture = isCapturePending(pane);
    pane.quietTicks = 0;
    pane.tier = 'active';
    const delayTicks = Math.ceil(Math.max(0, delayMs) / WORKER_ACTIVE_POLL_INTERVAL);
    pane.notBeforeTick = this.tick + delayTicks + 1;
    pane.nextDueTick = pane.notBeforeTick;
  }

  requestImmediate(paneId: string): boolean {
    const pane = this.panes.get(paneId);
    if (!pane || isCapturePending(pane)) return false;
    pane.issuedGeneration++;
    pane.pendingSinceTick = this.tick;
    this.deliverDueCaptures([{
      generation: pane.issuedGeneration,
      paneId: pane.paneId,
      tmuxPaneId: pane.tmuxPaneId,
    }]);
    return true;
  }

  stop(): void {
    this.stopTimer();
    this.panes.clear();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.onTick(), WORKER_ACTIVE_POLL_INTERVAL);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.tick = 0;
  }

  private onTick(): void {
    this.tick++;
    const due: CoordinatedPaneCaptureRequest[] = [];

    for (const pane of this.panes.values()) {
      if (!this.isDue(pane)) continue;
      // The watchdog is giving up on this capture: its generation is abandoned
      // here so the reissue can settle instead of reading as stale forever.
      if (isCapturePending(pane)) pane.settledGeneration = pane.issuedGeneration;
      pane.issuedGeneration++;
      pane.pendingSinceTick = this.tick;
      due.push({
        generation: pane.issuedGeneration,
        paneId: pane.paneId,
        tmuxPaneId: pane.tmuxPaneId,
      });
    }

    if (due.length > 0) this.deliverDueCaptures(due);
  }

  /**
   * A capture that is never acknowledged - a worker that exited between the
   * request and its reply - would otherwise pin the pane as pending and freeze
   * its status. Such a slot is re-armed once the watchdog window has passed.
   */
  private isDue(pane: ScheduledPane): boolean {
    if (isCapturePending(pane)) {
      return this.tick - pane.pendingSinceTick >= STALE_PENDING_TICKS;
    }
    return pane.nextDueTick <= this.tick;
  }

  private nextIdleCadenceTick(): number {
    return Math.ceil((this.tick + 1) / this.idleTickCount) * this.idleTickCount;
  }
}
