import { useState, useCallback } from 'react';
import { useElectronSettingsStore, useSelectedPane } from '../../stores';
import { useIpcListener } from '../../hooks/useIpcListener';
import { IPC_EVENT } from '../../../shared/ipc-channels';
import type { PerformanceMetricsEvent } from '../../../shared/ipc-types';

function cpuColor(percent: number): string {
  if (percent < 30) return 'color-mix(in srgb, var(--success) 70%, transparent)';
  if (percent < 70) return 'color-mix(in srgb, var(--warning) 70%, transparent)';
  return 'color-mix(in srgb, var(--error) 70%, transparent)';
}

function formatMemory(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

function MetricsRow({ metrics }: { metrics: PerformanceMetricsEvent }) {
  return (
    <div className="flex items-center gap-3 ml-auto shrink-0 text-[var(--text-secondary)]">
      <span
        className="tabular-nums"
        title={`${metrics.activity.totals.statusCaptureRequests} status snapshots requested; ${metrics.activity.totals.statusTmuxInvocations} tmux capture processes`}
      >
        {metrics.activity.rates.statusCaptureRequestsPerSecond}→{metrics.activity.rates.statusTmuxInvocationsPerSecond}/s status
      </span>
      <span
        className="tabular-nums"
        title={`${metrics.activity.totals.gitStatusPolls} Git status polls`}
      >
        {metrics.activity.rates.gitStatusPollsPerSecond}/s git
      </span>
      <span
        className="tabular-nums"
        title={`${metrics.activity.totals.terminalOutputEvents} live terminal events`}
      >
        {metrics.activity.rates.terminalOutputKBPerSecond} KB/s tty
      </span>
      <span
        className="transition-colors duration-500 tabular-nums"
        style={{ color: cpuColor(metrics.cpuPercent) }}
      >
        {metrics.cpuPercent}% cpu
      </span>
      <span className="tabular-nums">
        {formatMemory(metrics.memoryMB)} mem
      </span>
    </div>
  );
}

export function StatusBar() {
  const show = useElectronSettingsStore((s) => s.settings?.showPerformanceMetrics ?? false);
  const [metrics, setMetrics] = useState<PerformanceMetricsEvent | null>(null);

  const selectedPane = useSelectedPane();

  const handleMetrics = useCallback((...args: unknown[]) => {
    setMetrics(args[0] as PerformanceMetricsEvent);
  }, []);

  useIpcListener(IPC_EVENT.PERFORMANCE_METRICS, handleMetrics);

  const hasWorktreeInfo = !!selectedPane?.worktreePath;
  const hasMetrics = show && !!metrics;

  if (!hasWorktreeInfo && !hasMetrics) return null;

  const branchName = selectedPane?.branchName || selectedPane?.slug;

  return (
    <div className="shrink-0 flex items-center gap-3 px-4 py-0.5 text-[10px] border-t border-[var(--border)]/30">
      {hasWorktreeInfo && (
        <div className="flex items-center gap-1.5 min-w-0 flex-1 text-[var(--text-secondary)]">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" className="shrink-0 opacity-70">
            <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
          </svg>
          <span className="shrink-0 font-medium text-[var(--text-secondary)]">{branchName}</span>
          {selectedPane?.worktreePath && (
            <span
              className="truncate"
              title={selectedPane.worktreePath}
            >
              {selectedPane.worktreePath}
            </span>
          )}
        </div>
      )}

      {hasMetrics && metrics && <MetricsRow metrics={metrics} />}
    </div>
  );
}
