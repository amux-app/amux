// @vitest-environment happy-dom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PerformanceMetricsEvent } from '../src/shared/ipc-types.js';

let metricsListener: ((...args: unknown[]) => void) | null = null;

vi.mock('../src/renderer/stores', () => ({
  useElectronSettingsStore: (
    selector: (state: { settings: { showPerformanceMetrics: boolean } }) => unknown,
  ) => selector({ settings: { showPerformanceMetrics: true } }),
  useSelectedPane: () => null,
}));

vi.mock('../src/renderer/hooks/useIpcListener', () => ({
  useIpcListener: (_channel: string, listener: (...args: unknown[]) => void) => {
    metricsListener = listener;
  },
}));

import { StatusBar } from '../src/renderer/components/dashboard/StatusBar.js';

describe('StatusBar runtime activity metrics', () => {
  afterEach(() => {
    cleanup();
    metricsListener = null;
  });

  it('shows status request-to-tmux reduction and supporting activity rates', () => {
    render(<StatusBar />);

    act(() => metricsListener?.({
      activity: {
        rates: {
          gitStatusPollsPerSecond: 0.5,
          statusCaptureRequestsPerSecond: 6,
          statusTmuxInvocationsPerSecond: 1,
          terminalOutputEventsPerSecond: 12,
          terminalOutputKBPerSecond: 24.5,
        },
        totals: {
          gitStatusPolls: 10,
          statusCaptureRequests: 120,
          statusTmuxInvocations: 20,
          terminalOutputBytes: 50_176,
          terminalOutputEvents: 240,
        },
      },
      cpuPercent: 12,
      details: [],
      memoryMB: 300,
    } satisfies PerformanceMetricsEvent));

    expect(screen.getByText('6→1/s status')).toBeTruthy();
    expect(screen.getByText('0.5/s git')).toBeTruthy();
    expect(screen.getByText('24.5 KB/s tty')).toBeTruthy();
  });
});
