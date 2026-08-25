import { peekStatusDetector } from 'muxbase/core';
import { app, BrowserWindow } from 'electron';
import { IPC_EVENT } from '../../shared/ipc-channels.js';
import type { PerformanceMetricsEvent } from '../../shared/ipc-types.js';
import { log } from './Logger.js';
import { AppMemorySampler } from './process-memory.js';
import {
  RuntimeActivityMetrics,
  sampleActivityRates,
  type CombinedActivityTotals,
} from './RuntimeActivityMetrics.js';

const INTERVAL_MS = 2000;

export class PerformanceMonitorService {
  private static instance: PerformanceMonitorService;
  private timer: ReturnType<typeof setInterval> | null = null;
  private collecting = false;
  private previousActivityAt = 0;
  private previousActivityTotals: CombinedActivityTotals | null = null;
  private readonly memorySampler = new AppMemorySampler();

  static getInstance(): PerformanceMonitorService {
    if (!PerformanceMonitorService.instance) {
      PerformanceMonitorService.instance = new PerformanceMonitorService();
    }
    return PerformanceMonitorService.instance;
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    log.info('perf-monitor', 'Starting performance monitor');
    RuntimeActivityMetrics.getInstance().setEnabled(true);
    this.previousActivityAt = Date.now();
    this.previousActivityTotals = this.readActivityTotals();
    this.timer = setInterval(() => {
      void this.collect();
    }, INTERVAL_MS);
  }

  stop(): void {
    RuntimeActivityMetrics.getInstance().setEnabled(false);
    if (!this.timer) return;
    log.info('perf-monitor', 'Stopping performance monitor');
    clearInterval(this.timer);
    this.timer = null;
    this.previousActivityAt = 0;
    this.previousActivityTotals = null;
  }

  private async collect(): Promise<void> {
    if (this.collecting) return;
    this.collecting = true;
    try {
      const metrics = app.getAppMetrics();
      const mainMemInfo = await process.getProcessMemoryInfo();
      const mainPid = process.pid;

      let totalCpu = 0;
      const details: PerformanceMetricsEvent['details'] = [];

      for (const proc of metrics) {
        totalCpu += proc.cpu.percentCPUUsage;
        const memKB = proc.pid === mainPid ? mainMemInfo.private : proc.memory.workingSetSize;
        details.push({
          type: proc.type,
          cpu: Math.round(proc.cpu.percentCPUUsage * 10) / 10,
          memory: Math.round(memKB / 1024),
        });
      }

      const totalMemoryKB = this.memorySampler.sampleKB({
        mainPid,
        mainPrivateKB: mainMemInfo.private,
        processes: metrics,
      });

      const event: PerformanceMetricsEvent = {
        activity: this.sampleActivity(),
        cpuPercent: Math.round(totalCpu * 10) / 10,
        memoryMB: Math.round(totalMemoryKB / 1024),
        details,
      };

      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC_EVENT.PERFORMANCE_METRICS, event);
      }
    } catch (error) {
      log.debug('perf-monitor', 'Failed to collect performance metrics', { error: String(error) });
    } finally {
      this.collecting = false;
    }
  }

  private readActivityTotals(): CombinedActivityTotals {
    const runtimeTotals = RuntimeActivityMetrics.getInstance().getTotals();
    const captureStats = peekStatusDetector()?.getStats().workerStats.captureStats;
    return {
      ...runtimeTotals,
      statusCaptureRequests: captureStats?.captureRequests ?? 0,
      statusTmuxInvocations: captureStats?.tmuxInvocations ?? 0,
    };
  }

  private sampleActivity(): PerformanceMetricsEvent['activity'] {
    const now = Date.now();
    const totals = this.readActivityTotals();
    const rates = this.previousActivityTotals
      ? sampleActivityRates(this.previousActivityTotals, totals, now - this.previousActivityAt)
      : sampleActivityRates(totals, totals, 0);
    this.previousActivityAt = now;
    this.previousActivityTotals = totals;
    return { rates, totals };
  }
}
