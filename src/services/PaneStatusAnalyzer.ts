import type { AgentStatus } from '../types.js';
import { FIRST_IDLE_STABLE_CAPTURES, STATUS_REASSERT_CAPTURES } from '../constants/timing.js';
import type { AgentName } from '../utils/agentLaunch.js';
import {
  classifyTailStatus,
  isAgentReadyForInput,
} from './paneStatusHeuristics.js';

type PaneStatus = Extract<AgentStatus, 'idle' | 'working'>;

export interface PaneStatusChange {
  previousStatus: PaneStatus;
  status: PaneStatus;
  /** A periodic restatement of an unchanged status, not a transition. */
  reasserted?: true;
}

export interface PaneStatusAnalysis {
  active: boolean;
  /** A visible working marker vanished; capture once more after redraw separation. */
  requestIdleConfirmation?: boolean;
  statusChange?: PaneStatusChange;
}

const CAPTURES_BEFORE_IDLE = 3;

export class PaneStatusAnalyzer {
  private currentStatus: PaneStatus | null = null;
  private lastCapture = '';
  private initialInputReadyConsumed = false;
  private previousStableCapture: string | null = null;
  private stableStreak = 0;
  private lastTailStatus: PaneStatus | null = null;
  private pendingMarkerDisappearance = false;
  private capturesSinceEmit = 0;

  constructor(
    private readonly agent?: AgentName,
    private readonly recognizeInitialInputReady = false,
  ) {}

  analyzeCapture(output: string, visibleFrame: string): PaneStatusAnalysis {
    if (!output && !visibleFrame) return { active: false };

    // Scrollback grows for normal agent output and may repaint independently of
    // the visible terminal. It is not a stability signal for the current UI.
    this.trackStability(visibleFrame);
    const classifiedStatus = classifyTailStatus(visibleFrame, this.agent);
    const initialReady = classifiedStatus === null
      && this.recognizeInitialInputReady
      && !this.initialInputReadyConsumed
      && this.agent !== undefined
      && isAgentReadyForInput(visibleFrame, this.agent);
    if (initialReady) this.initialInputReadyConsumed = true;
    const tailStatus = initialReady ? 'idle' : classifiedStatus;
    const markerDisappeared = this.lastTailStatus === 'working' && tailStatus === null;
    this.lastTailStatus = tailStatus;
    if (markerDisappeared) this.pendingMarkerDisappearance = true;
    const active = this.isPollActive(tailStatus === 'working', output);

    // What this frame proves on its own, independent of what we remember.
    const provenStatus: PaneStatus | null = tailStatus
      ?? (this.stableStreak >= FIRST_IDLE_STABLE_CAPTURES ? 'idle' : null);

    if (tailStatus) {
      return {
        active,
        requestIdleConfirmation: markerDisappeared || undefined,
        statusChange: this.emit(this.enterStatus(tailStatus), provenStatus),
      };
    }

    const statusChange = this.trackContent();
    if (statusChange?.status === 'idle') this.pendingMarkerDisappearance = false;
    return {
      active,
      requestIdleConfirmation: markerDisappeared || undefined,
      statusChange: this.emit(statusChange, provenStatus),
    };
  }

  /**
   * Transitions alone leave a settled pane silent, which starves downstream
   * freshness checks: a long turn loses its evidence lease, and a quiet pane
   * has no way back once its state has degraded. A restatement is only ever
   * made for what the current frame still proves — a remembered status must
   * never be replayed over fresher evidence from another source.
   */
  private emit(
    statusChange: PaneStatusChange | undefined,
    provenStatus: PaneStatus | null,
  ): PaneStatusChange | undefined {
    if (statusChange) {
      this.capturesSinceEmit = 0;
      return statusChange;
    }
    this.capturesSinceEmit += 1;
    if (provenStatus === null
      || provenStatus !== this.currentStatus
      || this.capturesSinceEmit < STATUS_REASSERT_CAPTURES) return undefined;
    this.capturesSinceEmit = 0;
    return { previousStatus: provenStatus, status: provenStatus, reasserted: true };
  }

  private isPollActive(working: boolean, output: string): boolean {
    const contentChanged = output !== this.lastCapture;
    this.lastCapture = output;
    return working || contentChanged || this.currentStatus === 'working';
  }

  private enterStatus(status: PaneStatus): PaneStatusChange | undefined {
    const previousStatus = this.currentStatus;
    if (status === previousStatus) return undefined;
    this.currentStatus = status;
    return { previousStatus: previousStatus ?? status, status };
  }

  private trackStability(output: string): void {
    this.stableStreak = output === this.previousStableCapture ? this.stableStreak + 1 : 1;
    this.previousStableCapture = output;
  }

  private trackContent(): PaneStatusChange | undefined {
    if (this.currentStatus === null) return this.trackFromUnknown();

    return this.trackFromKnownBaseline();
  }

  /**
   * Before any content status has ever been recorded, only an explicit agent
   * marker may establish working (handled before this method). Arbitrary
   * capture motion is not evidence: startup repainting and pane reflow both
   * change terminal content. Stable captures can still establish idle after
   * FIRST_IDLE_STABLE_CAPTURES. Typing restarts that stability window.
   */
  private trackFromUnknown(): PaneStatusChange | undefined {
    if (this.stableStreak < FIRST_IDLE_STABLE_CAPTURES) return undefined;
    return this.enterStatus('idle');
  }

  private trackFromKnownBaseline(): PaneStatusChange | undefined {
    if (this.currentStatus === 'idle') return undefined;
    const requiredCaptures = this.pendingMarkerDisappearance ? 2 : CAPTURES_BEFORE_IDLE;
    if (this.stableStreak < requiredCaptures) return undefined;
    return this.enterStatus('idle');
  }

}
