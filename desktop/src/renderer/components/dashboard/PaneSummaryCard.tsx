import { RefreshCw, AlertTriangle, Sparkles } from 'lucide-react';
import { usePaneSummaryStore } from '../../stores';
import type { PaneSummary } from '../../../shared/pane-summary-types';
import { cn } from '../../lib/cn';

interface Props {
  summary: PaneSummary;
  refreshing: boolean;
  summarizing: boolean;
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatAbsolute(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

export function PaneSummaryCard({ summary, refreshing, summarizing }: Props) {
  const refreshOne = usePaneSummaryStore((s) => s.refreshOne);
  const generateRecapOne = usePaneSummaryStore((s) => s.generateRecapOne);
  const isStale = summary.status === 'stale';
  const isError = summary.status === 'error';
  const agentLabel = summary.agent.toUpperCase();

  return (
    <div className="rounded border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-[var(--text)] truncate">
            {summary.paneName}
          </span>
          <span className="text-[9px] uppercase tracking-wide rounded border border-[var(--border)] px-1.5 py-0.5 text-[var(--text-muted)]">
            {agentLabel}
          </span>
          {isStale && (
            <span className="text-[9px] uppercase rounded bg-[var(--surface-raised)] px-1.5 py-0.5 text-[var(--text-muted)]">
              stale
            </span>
          )}
          {isError && (
            <span title={summary.errorMessage} className="text-[var(--accent)]">
              <AlertTriangle size={12} />
            </span>
          )}
        </div>
        <button
          onClick={() => refreshOne(summary.paneId, true)}
          disabled={refreshing}
          className="text-[var(--text-muted)] hover:text-[var(--accent)] disabled:opacity-50"
          title="Refresh fast fields (branch, git activity)"
        >
          <RefreshCw size={12} className={cn(refreshing && 'animate-spin')} />
        </button>
      </div>

      <Section label="BRANCH">
        <span className="font-mono text-xs">{summary.branch || '—'}</span>
        {summary.worktreePath && (
          <span
            title={summary.worktreePath}
            className="ml-2 text-[var(--text-muted)]"
          >
            · {summary.worktreePath.split('/').pop()}
          </span>
        )}
      </Section>

      <Section label="STARTED">
        {formatRelative(summary.startedAt)} ({formatAbsolute(summary.startedAt)})
      </Section>

      <Section label="GIT ACTIVITY">
        {summary.gitActivity ? (
          <span>
            {summary.gitActivity.commitsAhead} commit
            {summary.gitActivity.commitsAhead === 1 ? '' : 's'}, +
            {summary.gitActivity.additions}/-{summary.gitActivity.deletions},{' '}
            {summary.gitActivity.dirtyFileCount} file
            {summary.gitActivity.dirtyFileCount === 1 ? '' : 's'} dirty
          </span>
        ) : (
          <span>—</span>
        )}
      </Section>

      <RecapSection
        summary={summary}
        summarizing={summarizing}
        onGenerate={() => generateRecapOne(summary.paneId, true)}
      />

      <div className="text-[10px] text-[var(--text-muted)] pt-1 border-t border-[var(--divider)]">
        Last refreshed {formatRelative(summary.generatedAt)}
        {summary.recapGeneratedAt && (
          <> · Recap {formatRelative(summary.recapGeneratedAt)}</>
        )}
      </div>
    </div>
  );
}

interface RecapSectionProps {
  summary: PaneSummary;
  summarizing: boolean;
  onGenerate: () => void;
}

function RecapSection({ summary, summarizing, onGenerate }: RecapSectionProps) {
  const status = summary.recapStatus;
  const hasRecap = !!summary.recap;
  const generating = summarizing || status === 'generating';

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[9px] uppercase tracking-wider text-[var(--text-muted)]">
          RECAP
        </span>
        <button
          onClick={onGenerate}
          disabled={generating}
          title={hasRecap ? 'Regenerate LLM recap' : 'Generate LLM recap (a few seconds)'}
          className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--accent)] disabled:opacity-50"
        >
          <Sparkles size={10} className={cn(generating && 'animate-pulse')} />
          {generating ? 'Generating…' : hasRecap ? 'Regenerate' : 'Generate'}
        </button>
      </div>
      <div className="text-xs text-[var(--text-secondary)]">
        {generating && !hasRecap ? (
          <span className="text-[var(--text-muted)] italic">Calling LLM…</span>
        ) : hasRecap ? (
          <p className="text-xs leading-relaxed text-[var(--text)] whitespace-pre-wrap">
            {summary.recap}
          </p>
        ) : status === 'error' ? (
          <span className="text-[var(--accent)]" title={summary.recapErrorMessage}>
            Recap failed — click Generate to retry.
          </span>
        ) : (
          <span className="text-[var(--text-muted)] italic">
            No recap yet — click Generate to summarize this pane's activity.
          </span>
        )}
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[9px] uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </span>
      <div className="text-xs text-[var(--text-secondary)]">{children}</div>
    </div>
  );
}
