import type { RunningAgentPaneResult } from 'aumx/core';
import type { Liveness } from '../../shared/pane-activity.js';

/**
 * Turns a best-effort process query into a safe liveness signal. A single
 * absence is never enough to call an agent stopped; process-table failures
 * are explicitly unknown rather than false negatives.
 */
export class AgentLivenessProbe {
  private readonly stoppedStreaks = new Map<string, number>();

  resolve(paneIds: readonly string[], result: RunningAgentPaneResult): Map<string, Liveness> {
    const liveness = new Map<string, Liveness>();
    for (const paneId of paneIds) {
      if (result.running.has(paneId)) {
        this.stoppedStreaks.delete(paneId);
        liveness.set(paneId, 'running');
        continue;
      }
      if (result.indeterminate.has(paneId)) {
        this.stoppedStreaks.delete(paneId);
        liveness.set(paneId, 'unknown');
        continue;
      }
      const stoppedStreak = (this.stoppedStreaks.get(paneId) ?? 0) + 1;
      this.stoppedStreaks.set(paneId, stoppedStreak);
      liveness.set(paneId, stoppedStreak >= 2 ? 'stopped' : 'unknown');
    }
    return liveness;
  }

  removePane(paneId: string): void {
    this.stoppedStreaks.delete(paneId);
  }

  reset(): void {
    this.stoppedStreaks.clear();
  }
}
