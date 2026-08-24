import { describe, expect, it } from 'vitest';
import {
  RuntimeActivityMetrics,
  sampleActivityRates,
} from '../../src/main/services/RuntimeActivityMetrics.js';

describe('RuntimeActivityMetrics', () => {
  it('records only counts and byte totals', () => {
    const metrics = new RuntimeActivityMetrics();
    metrics.setEnabled(true);

    metrics.recordGitStatusPoll();
    metrics.recordTerminalOutput('a'.repeat(1024));
    metrics.recordTerminalOutput('b'.repeat(2048));

    expect(metrics.getTotals()).toEqual({
      gitStatusPolls: 1,
      terminalOutputBytes: 3072,
      terminalOutputEvents: 2,
    });
  });

  it('does no terminal accounting while diagnostics are disabled', () => {
    const metrics = new RuntimeActivityMetrics();

    metrics.recordGitStatusPoll();
    metrics.recordTerminalOutput('output that should not be scanned');

    expect(metrics.getTotals()).toEqual({
      gitStatusPolls: 0,
      terminalOutputBytes: 0,
      terminalOutputEvents: 0,
    });
  });

  it('computes non-negative per-second rates across counter resets', () => {
    expect(sampleActivityRates(
      {
        gitStatusPolls: 4,
        statusCaptureRequests: 20,
        statusTmuxInvocations: 8,
        terminalOutputBytes: 2048,
        terminalOutputEvents: 10,
      },
      {
        gitStatusPolls: 6,
        statusCaptureRequests: 26,
        statusTmuxInvocations: 10,
        terminalOutputBytes: 6144,
        terminalOutputEvents: 14,
      },
      2000,
    )).toEqual({
      gitStatusPollsPerSecond: 1,
      statusCaptureRequestsPerSecond: 3,
      statusTmuxInvocationsPerSecond: 1,
      terminalOutputEventsPerSecond: 2,
      terminalOutputKBPerSecond: 2,
    });

    expect(sampleActivityRates(
      {
        gitStatusPolls: 6,
        statusCaptureRequests: 26,
        statusTmuxInvocations: 10,
        terminalOutputBytes: 6144,
        terminalOutputEvents: 14,
      },
      {
        gitStatusPolls: 0,
        statusCaptureRequests: 0,
        statusTmuxInvocations: 0,
        terminalOutputBytes: 0,
        terminalOutputEvents: 0,
      },
      2000,
    )).toEqual({
      gitStatusPollsPerSecond: 0,
      statusCaptureRequestsPerSecond: 0,
      statusTmuxInvocationsPerSecond: 0,
      terminalOutputEventsPerSecond: 0,
      terminalOutputKBPerSecond: 0,
    });
  });
});
