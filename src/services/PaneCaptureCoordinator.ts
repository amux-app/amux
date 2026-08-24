import { WORKER_CAPTURE_HISTORY_LINES } from '../constants/timing.js';
import {
  capturePaneWindows,
  type PaneWindowCapture,
  type PaneWindowCaptureBatch,
  type PaneWindowCaptureRequest,
} from '../utils/paneCapture.js';

export interface CoordinatedPaneCaptureRequest {
  generation: number;
  paneId: string;
  tmuxPaneId: string;
}

export interface PaneCaptureCoordinatorStats {
  batches: number;
  captureRequests: number;
  tmuxInvocations: number;
}

type CaptureBatch = (
  requests: PaneWindowCaptureRequest[],
) => Promise<PaneWindowCaptureBatch>;

type DeliverCapture = (
  request: CoordinatedPaneCaptureRequest,
  capture: PaneWindowCapture,
) => void;

const EMPTY_CAPTURE: PaneWindowCapture = { content: '', visibleFrame: '' };

/**
 * Coalesces status snapshots that become due in the same event-loop turn.
 * The manager-owned scheduler submits a cadence together; this final same-turn
 * coalescing also covers activity-triggered requests without giving workers
 * process ownership.
 */
export class PaneCaptureCoordinator {
  private readonly pending = new Map<string, CoordinatedPaneCaptureRequest>();
  private immediate: NodeJS.Immediate | null = null;
  private inFlight = false;
  private stopped = false;
  private readonly stats: PaneCaptureCoordinatorStats = {
    batches: 0,
    captureRequests: 0,
    tmuxInvocations: 0,
  };

  constructor(
    private readonly deliver: DeliverCapture,
    private readonly captureBatch: CaptureBatch = capturePaneWindows,
  ) {}

  request(request: CoordinatedPaneCaptureRequest): void {
    if (this.stopped) return;
    this.stats.captureRequests++;
    this.pending.set(request.paneId, request);
    this.schedule();
  }

  getStats(): PaneCaptureCoordinatorStats {
    return { ...this.stats };
  }

  stop(): void {
    this.stopped = true;
    this.pending.clear();
    if (this.immediate) clearImmediate(this.immediate);
    this.immediate = null;
  }

  private schedule(): void {
    if (this.stopped || this.immediate || this.inFlight) return;
    this.immediate = setImmediate(() => {
      this.immediate = null;
      void this.flush();
    });
    this.immediate.unref();
  }

  private async flush(): Promise<void> {
    if (this.stopped || this.inFlight || this.pending.size === 0) return;
    const requests = [...this.pending.values()];
    this.pending.clear();
    this.inFlight = true;
    this.stats.batches++;

    let captures = new Map<string, PaneWindowCapture>();
    try {
      const result = await this.captureBatch(requests.map(({ tmuxPaneId }) => ({
        lines: WORKER_CAPTURE_HISTORY_LINES,
        paneId: tmuxPaneId,
      })));
      captures = result.captures;
      this.stats.tmuxInvocations += result.tmuxInvocations;
    } catch {
      // Every requester still receives an empty result and can schedule again.
    } finally {
      this.inFlight = false;
    }

    if (!this.stopped) {
      for (const request of requests) {
        this.deliver(request, captures.get(request.tmuxPaneId) ?? EMPTY_CAPTURE);
      }
      this.schedule();
    }
  }
}
