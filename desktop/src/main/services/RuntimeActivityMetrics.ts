export interface RuntimeActivityTotals {
  gitStatusPolls: number;
  terminalOutputBytes: number;
  terminalOutputEvents: number;
}

export interface CombinedActivityTotals extends RuntimeActivityTotals {
  statusCaptureRequests: number;
  statusTmuxInvocations: number;
}

export interface RuntimeActivityRates {
  gitStatusPollsPerSecond: number;
  statusCaptureRequestsPerSecond: number;
  statusTmuxInvocationsPerSecond: number;
  terminalOutputEventsPerSecond: number;
  terminalOutputKBPerSecond: number;
}

const ZERO_RATES: RuntimeActivityRates = {
  gitStatusPollsPerSecond: 0,
  statusCaptureRequestsPerSecond: 0,
  statusTmuxInvocationsPerSecond: 0,
  terminalOutputEventsPerSecond: 0,
  terminalOutputKBPerSecond: 0,
};

function nonNegativeDelta(current: number, previous: number): number {
  return Math.max(0, current - previous);
}

function roundRate(value: number): number {
  return Math.round(value * 10) / 10;
}

export function sampleActivityRates(
  previous: CombinedActivityTotals,
  current: CombinedActivityTotals,
  elapsedMs: number,
): RuntimeActivityRates {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return { ...ZERO_RATES };
  const elapsedSeconds = elapsedMs / 1000;

  return {
    gitStatusPollsPerSecond: roundRate(
      nonNegativeDelta(current.gitStatusPolls, previous.gitStatusPolls) / elapsedSeconds,
    ),
    statusCaptureRequestsPerSecond: roundRate(
      nonNegativeDelta(current.statusCaptureRequests, previous.statusCaptureRequests) / elapsedSeconds,
    ),
    statusTmuxInvocationsPerSecond: roundRate(
      nonNegativeDelta(current.statusTmuxInvocations, previous.statusTmuxInvocations) / elapsedSeconds,
    ),
    terminalOutputEventsPerSecond: roundRate(
      nonNegativeDelta(current.terminalOutputEvents, previous.terminalOutputEvents) / elapsedSeconds,
    ),
    terminalOutputKBPerSecond: roundRate(
      nonNegativeDelta(current.terminalOutputBytes, previous.terminalOutputBytes)
        / 1024
        / elapsedSeconds,
    ),
  };
}

/**
 * Process-local counters only. They intentionally retain no pane identifiers,
 * paths, commands, or terminal content.
 */
export class RuntimeActivityMetrics {
  private static instance: RuntimeActivityMetrics;
  private enabled = false;
  private gitStatusPolls = 0;
  private terminalOutputBytes = 0;
  private terminalOutputEvents = 0;

  static getInstance(): RuntimeActivityMetrics {
    if (!RuntimeActivityMetrics.instance) {
      RuntimeActivityMetrics.instance = new RuntimeActivityMetrics();
    }
    return RuntimeActivityMetrics.instance;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  recordGitStatusPoll(): void {
    if (!this.enabled) return;
    this.gitStatusPolls++;
  }

  recordTerminalOutput(data: string): void {
    if (!this.enabled) return;
    const bytes = Buffer.byteLength(data, 'utf8');
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.terminalOutputEvents++;
    this.terminalOutputBytes += Math.floor(bytes);
  }

  getTotals(): RuntimeActivityTotals {
    return {
      gitStatusPolls: this.gitStatusPolls,
      terminalOutputBytes: this.terminalOutputBytes,
      terminalOutputEvents: this.terminalOutputEvents,
    };
  }
}
