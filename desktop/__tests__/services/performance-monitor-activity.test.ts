import { afterEach, describe, expect, it, vi } from 'vitest';

const send = vi.hoisted(() => vi.fn());
const getAppMetrics = vi.hoisted(() => vi.fn(() => []));

vi.mock('electron', () => ({
  app: { getAppMetrics },
  BrowserWindow: {
    getAllWindows: () => [{
      isDestroyed: () => false,
      webContents: { send },
    }],
  },
}));

const detector = vi.hoisted(() => ({
  current: null as { getStats: () => unknown } | null,
}));

vi.mock('aumx/core', () => ({
  execFileAsync: () => Promise.resolve(''),
  peekStatusDetector: () => detector.current,
}));

vi.mock('../../src/main/services/Logger.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
  },
}));

import { PerformanceMonitorService } from '../../src/main/services/PerformanceMonitorService.js';
import { RuntimeActivityMetrics } from '../../src/main/services/RuntimeActivityMetrics.js';

function mockDetector(captureRequests: number, tmuxInvocations: number): void {
  detector.current = {
    getStats: () => ({
      workerStats: { captureStats: { batches: 1, captureRequests, tmuxInvocations } },
    }),
  };
}

function mockMemoryInfo(): void {
  Object.defineProperty(process, 'getProcessMemoryInfo', {
    configurable: true,
    value: vi.fn().mockResolvedValue({ private: 1024 }),
  });
}

function sentActivity(): unknown {
  const event = send.mock.calls.at(-1)?.[1] as { activity: unknown };
  return event.activity;
}

describe('PerformanceMonitorService activity diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.set(RuntimeActivityMetrics, 'instance', undefined);
    Reflect.deleteProperty(process, 'getProcessMemoryInfo');
    detector.current = null;
    send.mockReset();
  });

  it('publishes rates and cumulative activity totals with app metrics', async () => {
    mockDetector(6, 1);
    mockMemoryInfo();
    vi.spyOn(Date, 'now').mockReturnValue(3000);
    const runtime = RuntimeActivityMetrics.getInstance();
    runtime.setEnabled(true);
    runtime.recordGitStatusPoll();
    runtime.recordGitStatusPoll();
    runtime.recordTerminalOutput('x'.repeat(4096));
    const monitor = new PerformanceMonitorService();
    Reflect.set(monitor, 'previousActivityAt', 1000);
    Reflect.set(monitor, 'previousActivityTotals', {
      gitStatusPolls: 0,
      statusCaptureRequests: 0,
      statusTmuxInvocations: 0,
      terminalOutputBytes: 0,
      terminalOutputEvents: 0,
    });

    await Reflect.get(monitor, 'collect').call(monitor);

    expect(send).toHaveBeenCalledWith(
      'event:performance-metrics',
      expect.objectContaining({
        activity: {
          rates: {
            gitStatusPollsPerSecond: 1,
            statusCaptureRequestsPerSecond: 3,
            statusTmuxInvocationsPerSecond: 0.5,
            terminalOutputEventsPerSecond: 0.5,
            terminalOutputKBPerSecond: 2,
          },
          totals: {
            gitStatusPolls: 2,
            statusCaptureRequests: 6,
            statusTmuxInvocations: 1,
            terminalOutputBytes: 4096,
            terminalOutputEvents: 1,
          },
        },
      }),
    );
  });

  it('reports zero status rates without constructing a status detector', async () => {
    // Arrange: diagnostics run before the status subsystem exists.
    mockMemoryInfo();
    vi.spyOn(Date, 'now').mockReturnValue(3000);
    RuntimeActivityMetrics.getInstance().setEnabled(true);
    const monitor = new PerformanceMonitorService();
    Reflect.set(monitor, 'previousActivityAt', 1000);

    // Act
    await Reflect.get(monitor, 'collect').call(monitor);

    // Assert
    expect(sentActivity()).toEqual({
      rates: {
        gitStatusPollsPerSecond: 0,
        statusCaptureRequestsPerSecond: 0,
        statusTmuxInvocationsPerSecond: 0,
        terminalOutputEventsPerSecond: 0,
        terminalOutputKBPerSecond: 0,
      },
      totals: {
        gitStatusPolls: 0,
        statusCaptureRequests: 0,
        statusTmuxInvocations: 0,
        terminalOutputBytes: 0,
        terminalOutputEvents: 0,
      },
    });
  });
});
