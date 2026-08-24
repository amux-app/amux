import { NO_INITIAL_PROMPT, type AumxPane } from '../types.js';
import type { AgentName } from '../utils/agentLaunch.js';
import type { PaneWindowCapture } from '../utils/paneCapture.js';
import { LogService } from './LogService.js';
import {
  PaneCaptureCoordinator,
  type CoordinatedPaneCaptureRequest,
} from './PaneCaptureCoordinator.js';
import {
  PaneStatusAnalyzer,
  type PaneStatusChange,
} from './PaneStatusAnalyzer.js';
import { PaneStatusScheduler } from './PaneStatusScheduler.js';

const IDLE_CONFIRMATION_DELAY_MS = 200;

interface AnalyzerConfig {
  agent?: AgentName;
  recognizeInitialInputReady: boolean;
  paneId: string;
  tmuxPaneId: string;
}

interface AnalyzerInfo {
  analyzer: PaneStatusAnalyzer;
  config: AnalyzerConfig;
  startTime: number;
}

type AnalyzerFactory = (
  agent?: AgentName,
  recognizeInitialInputReady?: boolean,
) => PaneStatusAnalyzer;
type StatusChangeHandler = (paneId: string, change: PaneStatusChange) => void;

export class PaneStatusManager {
  private readonly analyzers = new Map<string, AnalyzerInfo>();
  private readonly captureCoordinator: PaneCaptureCoordinator;
  private readonly captureScheduler: PaneStatusScheduler;
  private readonly idleConfirmationTimers = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  constructor(
    private readonly onStatusChange: StatusChangeHandler,
    private readonly createAnalyzer: AnalyzerFactory = (agent, recognizeInitialInputReady) => (
      new PaneStatusAnalyzer(agent, recognizeInitialInputReady)
    ),
  ) {
    this.captureCoordinator = new PaneCaptureCoordinator(
      (request, capture) => this.deliverCapture(request, capture),
    );
    this.captureScheduler = new PaneStatusScheduler((requests) => {
      for (const request of requests) this.captureCoordinator.request(request);
    });
  }

  hasAnalyzer(paneId: string): boolean {
    return this.analyzers.has(paneId);
  }

  notePaneActivity(paneId: string): void {
    this.captureScheduler.resumeFast(paneId);
  }

  updateAnalyzers(panes: AumxPane[]): void {
    if (this.stopped) return;
    const currentPaneIds = new Set(panes.map((pane) => pane.id));

    for (const pane of panes) {
      const existing = this.analyzers.get(pane.id);
      if (!existing) {
        this.addAnalyzer(pane);
      } else if (
        existing.config.tmuxPaneId !== pane.paneId
        || existing.config.agent !== pane.agent
        || existing.config.recognizeInitialInputReady !== this.shouldRecognizeInitialInputReady(pane)
      ) {
        this.destroyAnalyzer(pane.id);
        this.addAnalyzer(pane);
      }
    }

    for (const paneId of this.analyzers.keys()) {
      if (!currentPaneIds.has(paneId)) this.destroyAnalyzer(paneId);
    }
  }

  destroyAnalyzer(paneId: string): void {
    const confirmationTimer = this.idleConfirmationTimers.get(paneId);
    if (confirmationTimer) clearTimeout(confirmationTimer);
    this.idleConfirmationTimers.delete(paneId);
    this.captureScheduler.remove(paneId);
    this.analyzers.delete(paneId);
  }

  getStats(): {
    analyzerCount: number;
    analyzers: Array<{ paneId: string; uptime: number }>;
    captureStats: ReturnType<PaneCaptureCoordinator['getStats']>;
  } {
    return {
      analyzerCount: this.analyzers.size,
      analyzers: Array.from(this.analyzers.entries()).map(([paneId, info]) => ({
        paneId,
        uptime: Date.now() - info.startTime,
      })),
      captureStats: this.captureCoordinator.getStats(),
    };
  }

  shutdown(): void {
    this.stopped = true;
    this.captureScheduler.stop();
    this.captureCoordinator.stop();
    for (const timer of this.idleConfirmationTimers.values()) clearTimeout(timer);
    this.idleConfirmationTimers.clear();
    this.analyzers.clear();
  }

  private addAnalyzer(pane: AumxPane): void {
    const config: AnalyzerConfig = {
      agent: pane.agent,
      recognizeInitialInputReady: this.shouldRecognizeInitialInputReady(pane),
      paneId: pane.id,
      tmuxPaneId: pane.paneId,
    };
    this.analyzers.set(pane.id, {
      analyzer: this.createAnalyzer(config.agent, config.recognizeInitialInputReady),
      config,
      startTime: Date.now(),
    });
    this.captureScheduler.add(config);
  }

  private shouldRecognizeInitialInputReady(pane: AumxPane): boolean {
    if (pane.agent !== 'pi') return false;
    // New panes carry launch-input provenance explicitly because `prompt` can
    // be display/naming metadata while `agentPrompt` is intentionally empty.
    // Keep the sentinel fallback for configs created before this field existed.
    return pane.startedWithoutInitialPrompt ?? pane.prompt === NO_INITIAL_PROMPT;
  }

  private deliverCapture(
    request: CoordinatedPaneCaptureRequest,
    capture: PaneWindowCapture,
  ): void {
    const { generation, paneId, tmuxPaneId } = request;
    const info = this.analyzers.get(paneId);
    if (
      !info
      || info.config.tmuxPaneId !== tmuxPaneId
      || !this.captureScheduler.isCurrentRequest(request)
    ) {
      return;
    }

    let result;
    try {
      result = info.analyzer.analyzeCapture(capture.content, capture.visibleFrame);
    } catch (error) {
      LogService.getInstance().error(
        `Status analysis failed for pane ${paneId}`,
        'PaneStatusManager',
        paneId,
        error,
      );
      this.captureScheduler.complete(paneId, generation, true);
      return;
    }

    this.captureScheduler.complete(paneId, generation, result.active);
    if (result.requestIdleConfirmation) this.scheduleIdleConfirmation(paneId);
    if (!result.statusChange) return;

    try {
      this.onStatusChange(paneId, result.statusChange);
    } catch (error) {
      LogService.getInstance().error(
        `Status change handler failed for pane ${paneId}`,
        'PaneStatusManager',
        paneId,
        error,
      );
    }
  }

  private scheduleIdleConfirmation(paneId: string): void {
    const existing = this.idleConfirmationTimers.get(paneId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.idleConfirmationTimers.delete(paneId);
      this.captureScheduler.requestImmediate(paneId);
    }, IDLE_CONFIRMATION_DELAY_MS);
    timer.unref();
    this.idleConfirmationTimers.set(paneId, timer);
  }
}
