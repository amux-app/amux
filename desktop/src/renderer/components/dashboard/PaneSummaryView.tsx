import { useEffect, useMemo, useRef } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { usePaneStore, useProjectStore } from '../../stores';
import { usePaneSummaryStore } from '../../stores/pane-summary.store';
import { PaneSummaryCard } from './PaneSummaryCard';
import { EmptyState } from '../shared/EmptyState';
import { cn } from '../../lib/cn';

const TTL_MS = 10 * 60 * 1000;

export function PaneSummaryView() {
  const panes = usePaneStore((s) => s.panes);
  const projectRoot = useProjectStore((s) => s.sessionProjectRoot);
  const summaries = usePaneSummaryStore((s) => s.summaries);
  const refreshingIds = usePaneSummaryStore((s) => s.refreshingIds);
  const recapInFlightIds = usePaneSummaryStore((s) => s.recapInFlightIds);
  const hydrated = usePaneSummaryStore((s) => s.hydrated);
  const hydrate = usePaneSummaryStore((s) => s.hydrate);
  const reset = usePaneSummaryStore((s) => s.reset);
  const refreshAll = usePaneSummaryStore((s) => s.refreshAll);
  const generateRecapAll = usePaneSummaryStore((s) => s.generateRecapAll);
  const lastRefreshAllAt = usePaneSummaryStore((s) => s.lastRefreshAllAt);

  // Reset cached summaries when the active project changes. The main process
  // already tears down its PaneSummaryService on switch; this keeps the
  // renderer state in lock-step so old project's summaries can't leak across.
  const lastProjectRoot = useRef<string | null>(null);
  useEffect(() => {
    if (lastProjectRoot.current !== null && lastProjectRoot.current !== projectRoot) {
      reset();
    }
    lastProjectRoot.current = projectRoot;
  }, [projectRoot, reset]);

  // Hydrate (or re-hydrate after a project switch reset).
  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  // Refresh anything that is missing or past the TTL — fast path, no LLM. A refresh updates the
  // summaries dependency once more, then the idempotent stale check becomes empty.
  useEffect(() => {
    if (!hydrated) return;
    const now = Date.now();
    const stale = panes
      .map((p) => p.id)
      .filter((id) => {
        const cached = summaries[id];
        return !cached || now - cached.generatedAt > TTL_MS;
      });
    if (stale.length > 0) {
      void refreshAll(stale, false);
    }
  }, [hydrated, panes, refreshAll, summaries]);

  const anyRefreshing = refreshingIds.size > 0;
  const anySummarizing = recapInFlightIds.size > 0;

  const handleRefreshAll = () => {
    void refreshAll(panes.map((p) => p.id), true);
  };

  const handleSummarizeAll = () => {
    void generateRecapAll(panes.map((p) => p.id), true);
  };

  const cards = useMemo(
    () => panes.map((p) => ({ pane: p, summary: summaries[p.id] })),
    [panes, summaries],
  );

  if (panes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <EmptyState title="No panes yet" description="Create a pane to see a summary." />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-[var(--text)]">Pane Summary</h2>
          <p className="text-xs text-[var(--text-muted)]">
            {lastRefreshAllAt
              ? `Last refresh-all ${Math.floor((Date.now() - lastRefreshAllAt) / 1000)}s ago`
              : 'Branch + git activity load instantly · LLM recap on demand'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleSummarizeAll}
            disabled={anySummarizing}
            title="Generate LLM recap for every pane (takes a few seconds each)"
            className="flex items-center gap-1.5 rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-raised)] disabled:opacity-50"
          >
            <Sparkles size={12} className={cn(anySummarizing && 'animate-pulse')} />
            {anySummarizing ? 'Summarizing…' : 'Summarize all'}
          </button>
          <button
            onClick={handleRefreshAll}
            disabled={anyRefreshing}
            className="flex items-center gap-1.5 rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-raised)] disabled:opacity-50"
          >
            <RefreshCw size={12} className={cn(anyRefreshing && 'animate-spin')} />
            Refresh all
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {cards.map(({ pane, summary }) => (
          <div key={pane.id}>
            {summary ? (
              <PaneSummaryCard
                summary={summary}
                refreshing={refreshingIds.has(pane.id)}
                summarizing={recapInFlightIds.has(pane.id)}
              />
            ) : (
              <PendingCard paneName={pane.title ?? pane.slug} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PendingCard({ paneName }: { paneName: string }) {
  return (
    <div className="rounded border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-2">
      <span className="text-sm font-medium text-[var(--text)] truncate">{paneName}</span>
      <span className="text-xs text-[var(--text-muted)]">Loading…</span>
    </div>
  );
}
