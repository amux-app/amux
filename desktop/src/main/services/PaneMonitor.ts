import {
  getStatusDetector,
  resetStatusDetector,
  type MuxBasePane,
  type StatusUpdateEvent,
} from 'muxbase/core';
import { log } from './Logger.js';

export class PaneMonitor {
  private running = false;

  constructor(
    private readonly onStatusDetected?: (event: StatusUpdateEvent) => void,
  ) {}

  async start(panes: MuxBasePane[]): Promise<void> {
    log.info('pane-monitor', 'Starting pane monitoring', { paneCount: panes.length, ids: panes.map((p) => p.id) });

    const detector = getStatusDetector();
    if (!this.running) {
      detector.on('status-updated', this.handleStatusDetected);
      this.running = true;
    }

    await detector.monitorPanes(panes);
    log.info('pane-monitor', 'Pane monitoring active');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    log.info('pane-monitor', 'Stopping pane monitoring');
    this.running = false;
    const detector = getStatusDetector();
    detector.off('status-updated', this.handleStatusDetected);
    resetStatusDetector();
  }

  private handleStatusDetected = (event: StatusUpdateEvent): void => {
    this.onStatusDetected?.(event);
  };
}
