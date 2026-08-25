import { useEffect, useState } from 'react';
import { Archive, Copy, FolderOpen } from 'lucide-react';
import type { SessionInfoResult } from '../../../shared/ipc-types';
import { getSessionInfo } from '../../api/project.api';
import { clipboardWrite, revealPath } from '../../api/system.api';
import { rendererLog } from '../../lib/rendererLog';
import { useElectronSettingsStore } from '../../stores';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { ElectronSettingRow } from './ElectronSettingRow';
import { SupportBundleDialog } from './SupportBundleDialog';

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)] mb-1">
        {title}
      </h4>
      <div className="divide-y divide-[var(--border)]">{children}</div>
    </section>
  );
}

export function AdvancedSettings() {
  return (
    <div>
      <h3 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-4">
        Advanced
      </h3>
      <div className="flex flex-col gap-7">
        <SubSection title="Diagnostics">
          <ElectronSettingRow
            settingKey="pollingInterval"
            label="Polling Interval"
            description="How often terminal content is refreshed (in milliseconds)"
            type="number"
            min={100}
            max={2000}
            step={50}
          />
          <ElectronSettingRow
            settingKey="debugLogging"
            label="Debug Logging"
            description="Enable verbose debug logging for troubleshooting"
            type="boolean"
          />
          <DebugLogFileRow />
        </SubSection>

        <SubSection title="Experimental">
          <ElectronSettingRow
            settingKey="enableLanguageIntelligence"
            label="TypeScript Intelligence"
            description="Enable completion, diagnostics, hover, definitions, and references for supported JavaScript and TypeScript workspaces"
            type="boolean"
            badge="Beta"
          />
          <ElectronSettingRow
            settingKey="enableKanbanBoard"
            label="Board"
            description="Show the alpha board experience in the dashboard view switcher"
            type="boolean"
            badge="Alpha"
          />
          <ElectronSettingRow
            settingKey="enablePaneSummary"
            label="Summary"
            description="Show the alpha pane-summary view in the dashboard view switcher"
            type="boolean"
            badge="Alpha"
          />
          <ElectronSettingRow
            settingKey="enableConversationTopics"
            label="Conversation Topics"
            description="Show the experimental Topics view in the sidebar (groups conversations by agent pane)"
            type="boolean"
            badge="Experimental"
          />
          <ElectronSettingRow
            settingKey="enableAgentLifecycleAdapters"
            label="Agent Lifecycle Adapters"
            description="Allow MuxBase to install local lifecycle hook definitions for supported agents. This writes only hook configuration and records no prompt or tool content."
            type="boolean"
            badge="Experimental"
          />
          <ElectronSettingRow
            settingKey="enableReviewAgent"
            label="Code Review Agent"
            description="Show the Review chip on finished panes. Launches a separate read-only reviewer pane that can hand findings back to the author."
            type="boolean"
            badge="Beta"
          />
        </SubSection>

        <SubSection title="Cost & Telemetry">
          <ElectronSettingRow
            settingKey="enableTelemetryCostTracking"
            label="Cost Tracking"
            description="Capture real cost from Claude Code's own telemetry (localhost only). New Claude panes report directly to MuxBase; existing panes keep their estimate until restarted."
            type="boolean"
          />
          <ElectronSettingRow
            settingKey="costCurrency"
            label="Cost Currency"
            description="USD shows Claude Code's reported cost as-is. EUR (HAI) converts at the proxy's empirical rate to match the HAI TUI. EUR (market) uses a market FX rate."
            type="select"
            options={[
              { value: 'USD', label: 'USD ($)' },
              { value: 'EUR-hai', label: 'EUR — HAI rate (€)' },
              { value: 'EUR-market', label: 'EUR — market rate (€)' },
            ]}
          />
        </SubSection>

        <SubSection title="Metrics">
          <ElectronSettingRow
            settingKey="showPerformanceMetrics"
            label="Performance Metrics"
            description="Show CPU and memory usage in the resource bar"
            type="boolean"
          />
          <ElectronSettingRow
            settingKey="showArenaScores"
            label="LMArena Scores"
            description="Show the LMArena human-vote rank alongside the aistupidlevel score in the provider health popup."
            type="boolean"
          />
          <ElectronSettingRow
            settingKey="showAgentHealthTracker"
            label="Agent CLI Health Tracker"
            description="Show Margin Lab's daily SWE-Bench-Pro pass-rate for Claude Code and Codex panes. Source data scraped from marginlab.ai."
            type="boolean"
            badge="Experimental"
          />
        </SubSection>

        <SubSection title="Privacy">
          <ElectronSettingRow
            settingKey="disableExternalNetwork"
            label="Disable external network requests"
            description="Stops model-status and health checks (aistupidlevel.info, status pages). Core tmux/agent features are unaffected."
            type="boolean"
          />
        </SubSection>

        <ResetSettingsRow />
      </div>
    </div>
  );
}

function ResetSettingsRow() {
  const reset = useElectronSettingsStore((s) => s.reset);
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <section className="border-t border-[var(--border)] pt-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-[var(--text)]">Reset to Defaults</div>
          <div className="text-xs text-[var(--text-muted)] mt-0.5">
            Restore every appearance, terminal, window, and advanced setting to its default value.
          </div>
        </div>
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          className="shrink-0 rounded-md border border-[var(--error)] px-3 py-1.5 text-xs font-medium text-[var(--error)] transition-colors hover:bg-[var(--error)] hover:text-white"
        >
          Reset
        </button>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        danger
        title="Reset all settings?"
        message="This restores every setting to its default. Your projects, panes, and worktrees are not affected."
        confirmLabel="Reset settings"
        onConfirm={() => {
          setConfirmOpen(false);
          void reset();
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </section>
  );
}

function DebugLogFileRow() {
  const [sessionInfo, setSessionInfo] = useState<SessionInfoResult | null>(null);
  const [bundleDialogOpen, setBundleDialogOpen] = useState(false);
  const logPath = sessionInfo?.logFile ?? sessionInfo?.logDir ?? '';

  useEffect(() => {
    let mounted = true;
    getSessionInfo()
      .then((info) => {
        if (mounted) setSessionInfo(info);
      })
      .catch((error) => {
        rendererLog.warn('settings', 'Failed to load session log path', { error });
      });
    return () => {
      mounted = false;
    };
  }, []);

  const copyLogPath = () => {
    if (!logPath) return;
    void clipboardWrite(logPath).catch((error) => {
      rendererLog.warn('settings', 'Failed to copy log path', { error, logPath });
    });
  };

  const revealLogPath = () => {
    if (!logPath) return;
    void revealPath(logPath).catch((error) => {
      rendererLog.warn('settings', 'Failed to reveal log path', { error, logPath });
    });
  };

  return (
    <div className="flex items-center justify-between py-3 gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-[var(--text)]">Debug Log File</div>
        <div className="text-xs text-[var(--text-muted)] mt-0.5 truncate" title={logPath || undefined}>
          {logPath || 'Log file path unavailable'}
        </div>
      </div>
      <div className="shrink-0 flex items-center gap-1">
        <button
          type="button"
          onClick={copyLogPath}
          disabled={!logPath}
          title="Copy log file path"
          aria-label="Copy log file path"
          className="inline-flex h-7 w-7 items-center justify-center rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-40"
        >
          <Copy size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={revealLogPath}
          disabled={!logPath}
          title="Reveal log file"
          aria-label="Reveal log file"
          className="inline-flex h-7 w-7 items-center justify-center rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-40"
        >
          <FolderOpen size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => setBundleDialogOpen(true)}
          disabled={!sessionInfo}
          title="Export support bundle"
          aria-label="Export support bundle"
          className="inline-flex h-7 w-7 items-center justify-center rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-40"
        >
          <Archive size={13} aria-hidden="true" />
        </button>
      </div>
      {bundleDialogOpen && <SupportBundleDialog onClose={() => setBundleDialogOpen(false)} />}
    </div>
  );
}
