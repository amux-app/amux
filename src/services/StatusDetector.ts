import { EventEmitter } from 'events';
import type { MuxBasePane, AgentStatus } from '../types.js';
import { WORKER_ACTIVITY_NOTIFY_THROTTLE } from '../constants/timing.js';
import { PaneStatusManager } from './PaneStatusManager.js';
import type { PaneStatusChange } from './PaneStatusAnalyzer.js';

export interface StatusUpdateEvent {
  paneId: string;
  status: AgentStatus;
  previousStatus?: AgentStatus;
  /** True when the status was restated for freshness rather than changed. */
  reasserted?: true;
}

export function selectStatusMonitoredPanes(panes: MuxBasePane[]): MuxBasePane[] {
  return panes.filter((pane) => pane.agent !== undefined && pane.type !== 'shell');
}

/**
 * High-level service coordinating local status detection.
 */
export class StatusDetector extends EventEmitter {
  private statusManager: PaneStatusManager;
  private paneStatuses = new Map<string, AgentStatus>();
  private lastActivityNotify = new Map<string, number>();
  private isShuttingDown = false;

  constructor() {
    super();
    this.statusManager = new PaneStatusManager((paneId, update) => {
      this.handleStatusChange(paneId, update);
    });
  }

  /**
   * Start monitoring a set of panes
   */
  async monitorPanes(panes: MuxBasePane[]): Promise<void> {
    if (this.isShuttingDown) return;

    const monitoredPanes = selectStatusMonitoredPanes(panes);

    this.statusManager.updateAnalyzers(monitoredPanes);
  }

  /**
   * Report input that reached a pane outside the worker (terminal transports
   * write straight to the PTY). The worker re-arms its fast poll interval so a
   * backed-off pane still reports the resulting agent transitions promptly.
   * Throttled because this is called per keystroke.
   */
  notePaneActivity(paneId: string): void {
    if (this.isShuttingDown) return;

    if (!this.statusManager.hasAnalyzer(paneId)) return;

    const now = Date.now();
    const last = this.lastActivityNotify.get(paneId) ?? 0;
    if (now - last < WORKER_ACTIVITY_NOTIFY_THROTTLE) return;
    this.lastActivityNotify.set(paneId, now);

    this.statusManager.notePaneActivity(paneId);
  }

  removePane(paneId: string): void {
    this.paneStatuses.delete(paneId);
    this.lastActivityNotify.delete(paneId);
    this.statusManager.destroyAnalyzer(paneId);
  }

  /** Publish content-derived status updates from the pane analyzer. */
  private handleStatusChange(
    paneId: string,
    change: PaneStatusChange,
  ): void {
    this.paneStatuses.set(paneId, change.status);
    this.emit('status-updated', {
      paneId,
      status: change.status,
      previousStatus: change.previousStatus,
      ...(change.reasserted ? { reasserted: true as const } : {}),
    } as StatusUpdateEvent);
  }

  /**
   * Get current status for a pane
   */
  getStatus(paneId: string): AgentStatus | undefined {
    return this.paneStatuses.get(paneId);
  }

  /**
   * Get all statuses
   */
  getAllStatuses(): Map<string, AgentStatus> {
    return new Map(this.paneStatuses);
  }

  /**
   * Get statistics
   */
  getStats(): {
    workerStats: ReturnType<PaneStatusManager['getStats']>;
    statusCounts: Record<AgentStatus, number>;
  } {
    const statusCounts: Record<AgentStatus, number> = {
      idle: 0,
      analyzing: 0,
      waiting: 0,
      working: 0
    };

    this.paneStatuses.forEach(status => {
      statusCounts[status]++;
    });

    return {
      workerStats: this.statusManager.getStats(),
      statusCounts
    };
  }

  /**
   * Shutdown the service
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    this.statusManager.shutdown();

    // Clear state
    this.paneStatuses.clear();
    this.lastActivityNotify.clear();

    // Remove all listeners
    this.removeAllListeners();
  }
}

// Export singleton instance
let instance: StatusDetector | null = null;

export function getStatusDetector(): StatusDetector {
  if (!instance) {
    instance = new StatusDetector();
  }
  return instance;
}

/**
 * Read the live detector without creating one. Diagnostics must never be the
 * caller that spins up the whole status subsystem.
 */
export function peekStatusDetector(): StatusDetector | null {
  return instance;
}

export function resetStatusDetector(): void {
  if (instance) {
    instance.shutdown();
    instance = null;
  }
}
