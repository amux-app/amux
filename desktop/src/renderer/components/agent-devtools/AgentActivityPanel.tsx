import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { computeSessionDisplayMetrics } from '../../../shared/agent-session-display-metrics';
import { useAgentSessionStore, useElectronSettingsStore, useUiStore } from '../../stores';
import { useActivitySubTabStore, type ActivitySubTab } from '../../stores/activity-subtab.store';
import { useDomFind } from '../../hooks/useDomFind';
import { cn } from '../../lib/cn';
import { CONTEXT_WINDOW_TOKENS } from '../../lib/constants';
import { formatCost, formatDuration, formatTokenCount } from '../../lib/formatters';
import { AnimatedNumber } from '../shared/AnimatedNumber';
import { Badge } from '../shared/Badge';
import { Chip } from '../shared/Chip';
import { EmptyState } from '../shared/EmptyState';
import { FindOverlay } from '../shared/FindOverlay';
import { SegmentedTabs, type SegmentedTabItem } from '../shared/SegmentedTabs';
import { ConversationView } from './ConversationView';
import { PromptsView } from './PromptsView';
import { RecapsView } from './RecapsView';
import { TimelineWaterfall } from './TimelineWaterfall';

interface AgentActivityPanelProps {
  paneId: string;
}

const SUB_TABS: readonly SegmentedTabItem<ActivitySubTab>[] = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'recaps', label: 'Recaps' },
  { id: 'timeline', label: 'Timeline' },
];

export function AgentActivityPanel({ paneId }: AgentActivityPanelProps) {
  const subTab = useActivitySubTabStore((s) => s.byPane[paneId] ?? 'conversation');
  const setSubTab = useActivitySubTabStore((s) => s.setSubTab);
  const session = useAgentSessionStore((s) => s.sessions[paneId]);
  const costCurrency = useElectronSettingsStore((s) => s.settings?.costCurrency ?? 'USD');
  const displayMetrics = useMemo(
    () => (session ? computeSessionDisplayMetrics(session) : null),
    [session],
  );
  const navigateToMessage = useCallback((messageId: string) => {
    setSubTab(paneId, 'conversation');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        useUiStore.setState({ scrollToMessageId: messageId });
      });
    });
  }, [paneId, setSubTab]);

  // Cmd+F find state
  const panelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);

  // Reset find when sub-tab changes — the previous sub-tab unmounts so any
  // Range objects pointing into it become invalid.
  useEffect(() => {
    setFindOpen(false);
    setFindQuery('');
  }, [subTab]);

  const findResult = useDomFind({
    containerRef: contentRef,
    query: findQuery,
    caseSensitive: findCaseSensitive,
    enabled: findOpen,
    resetKey: `${paneId}:${subTab}`,
  });

  // Window-level Cmd+F handler. Capture-phase so we run BEFORE the global
  // useKeyboardShortcuts handler (which would otherwise no-op the keystroke
  // when no file is open in the file viewer). Only fires when the user is
  // interacting with this panel.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta || e.shiftKey || e.key !== 'f') return;
      const panel = panelRef.current;
      if (!panel) return;
      const active = document.activeElement;
      const focusInsidePanel = active instanceof Node && panel.contains(active);
      // Allow opening find when focus is inside the panel, OR when focus is on
      // body (no element focused — common when user just switched tabs).
      if (!focusInsidePanel && active !== document.body) return;
      e.preventDefault();
      e.stopPropagation();
      if (findOpen) {
        // Re-open to refocus + select.
        setFindOpen(false);
        requestAnimationFrame(() => setFindOpen(true));
      } else {
        setFindOpen(true);
      }
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [findOpen]);

  const handleFindClose = useCallback(() => {
    setFindOpen(false);
    setFindQuery('');
  }, []);

  if (!session || session.messages.length === 0 || !displayMetrics) {
    return (
      <EmptyState
        title="No Activity Yet"
        description="Agent conversation will appear here once the session starts."
        className="h-full"
      />
    );
  }

  const contextTokens = displayMetrics.latestAssistantUsage?.contextTokens ?? 0;
  const contextPct = contextTokens > 0 ? Math.min(100, (contextTokens / CONTEXT_WINDOW_TOKENS) * 100) : 0;

  const durationSec =
    session.startTime != null && session.lastUpdateTime != null
      ? Math.floor((session.lastUpdateTime - session.startTime) / 1000)
      : null;
  const durationLabel = durationSec != null ? formatDuration(durationSec) : null;
  const costLabel = session.metrics.costUSD > 0 ? formatCost(session.metrics.costUSD, costCurrency) : null;

  return (
    <div ref={panelRef} className="relative flex flex-col h-full">

      {/* Header */}
      <div className="px-3 pt-3 pb-2.5 border-b border-[var(--border)] bg-[var(--surface)] shrink-0" data-find-skip="true">

        {/* Identity row */}
        <div className="flex items-center gap-2 mb-2.5">
          {session.agent && <Badge label={session.agent} className="shrink-0" />}
          {session.title && (
            <span className="min-w-0 truncate text-[11px] font-medium text-[var(--text-secondary)]">
              {session.title}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {durationLabel && (
              <span className="text-[9px] font-mono text-[var(--text-muted)]">{durationLabel}</span>
            )}
            <LiveStatusPill isOngoing={session.isOngoing} />
          </div>
        </div>

        {/* Metric chips */}
        <div className="flex flex-wrap items-center gap-1.5 mb-2.5">
          <Chip label="Prompts"><AnimatedNumber value={displayMetrics.promptCount} /></Chip>
          <Chip label="Tools"><AnimatedNumber value={session.metrics.toolCallCount} /></Chip>
          <Chip label="Tokens" mono>{formatTokenCount(session.metrics.totalTokens)}</Chip>
          {costLabel && <Chip label="Cost" mono>{costLabel}</Chip>}
        </div>

        {/* Context meter */}
        {contextPct > 0 && <ContextMeter pct={contextPct} />}

        {/* Sub-tab switcher */}
        <SegmentedTabs
          items={SUB_TABS}
          value={subTab}
          onChange={(id) => setSubTab(paneId, id)}
          layoutId="activity-subtab"
          className="mt-2.5"
        />
      </div>

      {/* Content */}
      <div ref={contentRef} className="flex-1 min-h-0 overflow-hidden">
        {subTab === 'conversation' && <ConversationView session={session} paneId={paneId} />}
        {subTab === 'prompts' && <PromptsView session={session} onNavigateToMessage={navigateToMessage} />}
        {subTab === 'recaps' && <RecapsView session={session} paneId={paneId} />}
        {subTab === 'timeline' && <TimelineWaterfall session={session} />}
      </div>

      {findOpen && (
        <FindOverlay
          query={findQuery}
          onQueryChange={setFindQuery}
          matchCount={findResult.matchCount}
          matchIndex={findResult.matchIndex}
          onNext={findResult.next}
          onPrev={findResult.prev}
          onClose={handleFindClose}
          caseSensitive={findCaseSensitive}
          onToggleCase={() => setFindCaseSensitive((v) => !v)}
          placeholder="Find in activity"
        />
      )}
    </div>
  );
}

function LiveStatusPill({ isOngoing }: { isOngoing: boolean }) {
  return (
    <div className={cn(
      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-medium',
      isOngoing
        ? 'text-emerald-500 bg-emerald-500/10'
        : 'text-[var(--text-muted)] bg-[var(--surface-raised)]',
    )}>
      <span className={cn('h-1.5 w-1.5 rounded-full bg-current', isOngoing && 'animate-pulse')} />
      {isOngoing ? 'Live' : 'Done'}
    </div>
  );
}

function ContextMeter({ pct }: { pct: number }) {
  const barColor =
    pct >= 80 ? 'bg-[var(--warning)]' : pct >= 50 ? 'bg-[var(--accent)]' : 'bg-[var(--success)]';

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[8.5px] uppercase tracking-wider text-[var(--text-muted)]">Context</span>
        <span className="text-[8.5px] font-mono text-[var(--text-muted)]">{Math.round(pct)}%</span>
      </div>
      <div className="h-[3px] rounded-full bg-[var(--surface-raised)] overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all duration-500', barColor)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
