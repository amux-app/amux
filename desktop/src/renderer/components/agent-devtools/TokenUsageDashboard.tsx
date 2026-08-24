import { useAgentSessionStore, useElectronSettingsStore } from '../../stores';
import { CONTEXT_WINDOW_TOKENS } from '../../lib/constants';
import { EmptyState } from '../shared/EmptyState';
import { formatTokenCount, formatCost, type CostCurrency } from '../../lib/formatters';
import { useAppThemeMode } from '../../hooks/useAppThemeMode';
import { computeSessionDisplayMetrics, getUsageSnapshot } from '../../../shared/agent-session-display-metrics';
import type { NormalizedSession, NormalizedMessage, CompactionEvent, CostSource } from '../../../shared/agent-session-types';
import type { ThemeMode } from '../../../shared/theme-mode';

type ChartSeries = 'input' | 'output' | 'cacheRead' | 'cacheCreate';

const CHART_COLOR: Record<ChartSeries | 'compaction' | 'toolResults', string> = {
  input: 'var(--accent)',
  output: 'var(--success)',
  cacheRead: 'var(--agent-analyzing)',
  cacheCreate: 'var(--warning)',
  compaction: 'var(--error)',
  toolResults: 'var(--agent-waiting)',
};

// Light backdrops wash out translucent fills, and --success/--warning stay under
// the 3:1 graphical floor there at any alpha, so light modes also shift each
// series toward --text before applying alpha.
const SERIES_TINT_PERCENT = 70;

export const SERIES_ALPHA: Record<ThemeMode, Record<ChartSeries, number>> = {
  dark: { input: 45, output: 90, cacheRead: 65, cacheCreate: 75 },
  light: { input: 88, output: 100, cacheRead: 92, cacheCreate: 100 },
};
export const COMPACTION_ALPHA: Record<ThemeMode, Record<ChartSeries, number>> = {
  dark: { input: 70, output: 95, cacheRead: 35, cacheCreate: 55 },
  light: { input: 70, output: 100, cacheRead: 55, cacheCreate: 85 },
};

function alphaColor(color: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

function seriesTone(color: string, mode: ThemeMode): string {
  return mode === 'dark' ? color : `color-mix(in srgb, ${color} ${SERIES_TINT_PERCENT}%, var(--text))`;
}

export function seriesFill(series: ChartSeries, isCompaction: boolean, mode: ThemeMode): string {
  const color = isCompaction ? CHART_COLOR.compaction : CHART_COLOR[series];
  const alpha = (isCompaction ? COMPACTION_ALPHA : SERIES_ALPHA)[mode][series];
  return alphaColor(seriesTone(color, mode), alpha);
}

function costLabel(source: CostSource): string {
  if (source === 'otlp') return 'Cost';
  if (source === 'mixed') return '~Cost';
  return 'Est. Cost';
}

interface TokenUsageDashboardProps {
  paneId: string;
}

export function TokenUsageDashboard({ paneId }: TokenUsageDashboardProps) {
  const session = useAgentSessionStore((s) => s.sessions[paneId]);

  if (!session || session.messages.length === 0) {
    return (
      <EmptyState
        title="No Token Data"
        description="Token usage will appear here once the agent session starts."
        className="h-full"
      />
    );
  }

  return <DashboardContent session={session} />;
}

function DashboardContent({ session }: { session: NormalizedSession }) {
  const { metrics } = session;
  const displayMetrics = computeSessionDisplayMetrics(session);
  const costCurrency = useElectronSettingsStore((s) => s.settings?.costCurrency ?? 'USD');
  const currentContextTokens = displayMetrics.latestAssistantUsage?.contextTokens ?? 0;
  const contextFillPercent = Math.min(100, (currentContextTokens / CONTEXT_WINDOW_TOKENS) * 100);

  const turnData = session.messages
    .map((m, messageIndex) => ({ message: m, messageIndex }))
    .filter((entry): entry is { message: NormalizedMessage & { tokens: NonNullable<NormalizedMessage['tokens']> }; messageIndex: number } => !!entry.message.tokens)
    .map(({ message: m, messageIndex }, idx) => {
      const usage = getUsageSnapshot(m.tokens)!;
      return {
        id: m.id,
        turnIndex: idx,
        messageIndex,
        input: usage.inputTokens,
        output: usage.outputTokens,
        cacheRead: usage.cacheReadTokens,
        cacheCreate: usage.cacheCreationTokens,
        context: usage.contextTokens,
        total: usage.totalUsageTokens,
        costUSD: m.tokens.costUSD ?? 0,
        costSource: m.tokens.costSource,
      };
    });

  const compactionTurnIndices = new Set(
    (session.compactionEvents ?? []).map((e) => e.turnIndex),
  );

  const maxTurnTokens = Math.max(1, ...turnData.map((t) => t.total));
  const avgTurnTokens =
    turnData.length > 0
      ? Math.round(turnData.reduce((sum, turn) => sum + turn.total, 0) / turnData.length)
      : 0;

  return (
    <div className="h-full overflow-y-auto px-3 py-3 space-y-4">
      <div className="rounded-xl border border-[var(--border)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--accent)_6%,transparent),color-mix(in_srgb,var(--accent)_2%,transparent))] p-3">
        <div className="flex items-start gap-3">
          <ContextRing value={contextFillPercent} contextTokens={currentContextTokens} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-semibold text-[var(--text)]">Context Usage</span>
              <span className="text-[10px] text-[var(--text-muted)]">
                {contextFillPercent.toFixed(1)}% of 200k
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
              <MetricCard label="Total Used" value={formatTokenCount(metrics.totalTokens)} />
              <MetricCard
                label="Prompts"
                value={String(displayMetrics.promptCount)}
                sub={`${displayMetrics.eventCount} events`}
              />
              <MetricCard label="Tool Calls" value={String(metrics.toolCallCount)} />
              <MetricCard label="Avg / Turn" value={avgTurnTokens > 0 ? formatTokenCount(avgTurnTokens) : '—'} />
              <MetricCard
                label={costLabel(metrics.costSource)}
                value={metrics.costUSD > 0 ? formatCost(metrics.costUSD, costCurrency) : '—'}
                sub={metrics.costSource === 'otlp' ? undefined : '~list price'}
              />
            </div>
          </div>
        </div>
        <div className="mt-3">
          <StackedMetricBar
            segments={[
              { label: 'Input', value: metrics.inputTokens, color: CHART_COLOR.input },
              { label: 'Output', value: metrics.outputTokens, color: CHART_COLOR.output },
              { label: 'Cache Read', value: metrics.cacheReadTokens, color: CHART_COLOR.cacheRead },
              { label: 'Cache Create', value: metrics.cacheCreationTokens ?? 0, color: CHART_COLOR.cacheCreate },
            ]}
          />
        </div>
      </div>

      {turnData.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold text-[var(--text)]">Turn-by-Turn Usage</span>
            <span className="text-[10px] text-[var(--text-muted)]">
              peak {formatTokenCount(maxTurnTokens)} / avg {formatTokenCount(avgTurnTokens)}
            </span>
          </div>
          <TurnUsageChart
            turnData={turnData}
            maxTurnTokens={maxTurnTokens}
            compactionTurnIndices={compactionTurnIndices}
            costCurrency={costCurrency}
          />
        </div>
      )}
      {(session.compactionEvents ?? []).length > 0 && (
        <CompactionSummary events={session.compactionEvents} />
      )}

      <TokenAttributionSection messages={session.messages} />
    </div>
  );
}

function ContextRing({ value, contextTokens }: { value: number; contextTokens: number }) {
  const size = 88;
  const stroke = 8;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (Math.max(0, Math.min(100, value)) / 100) * c;
  const color =
    value > 80 ? 'var(--warning)' : value > 55 ? 'var(--accent)' : 'var(--agent-working)';

  return (
    <div className="relative shrink-0">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--divider-strong)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-[14px] font-semibold text-[var(--text)]">{value.toFixed(0)}%</div>
        <div className="text-[9px] text-[var(--text-muted)]">{formatTokenCount(contextTokens)}</div>
      </div>
    </div>
  );
}

function StackedMetricBar({
  segments,
}: {
  segments: Array<{ label: string; value: number; color: string }>;
}) {
  const total = Math.max(1, segments.reduce((sum, seg) => sum + seg.value, 0));
  return (
    <div>
      <div className="flex h-3 rounded-full overflow-hidden border border-[var(--border)] bg-[var(--surface-raised)]">
        {segments.map((seg) => {
          const pct = (seg.value / total) * 100;
          if (pct <= 0) return null;
          return (
            <div
              key={seg.label}
              style={{ width: `${Math.max(1.5, pct)}%`, backgroundColor: seg.color }}
              title={`${seg.label}: ${formatTokenCount(seg.value)} (${pct.toFixed(1)}%)`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
        {segments.map((seg) => (
          <div key={seg.label} className="inline-flex items-center gap-1.5 text-[10px]">
            <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: seg.color }} />
            <span className="text-[var(--text-muted)]">{seg.label}</span>
            <span className="text-[var(--text-secondary)] font-medium">{formatTokenCount(seg.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TurnUsageChart({
  turnData,
  maxTurnTokens,
  compactionTurnIndices,
  costCurrency,
}: {
  turnData: Array<{
    id: string;
    turnIndex: number;
    messageIndex: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheCreate: number;
    context: number;
    total: number;
    costUSD: number;
    costSource?: 'otlp' | 'estimate';
  }>;
  maxTurnTokens: number;
  compactionTurnIndices: Set<number>;
  costCurrency: CostCurrency;
}) {
  const mode = useAppThemeMode();
  const height = 170;
  const width = 720;
  const padX = 12;
  const padY = 16;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const pointX = (index: number) =>
    padX + (turnData.length <= 1 ? innerW / 2 : (index / (turnData.length - 1)) * innerW);
  const pointY = (tokens: number) =>
    padY + innerH - (Math.max(0, tokens) / Math.max(1, maxTurnTokens)) * innerH;

  const totalLine = turnData
    .map((turn, index) => `${index === 0 ? 'M' : 'L'} ${pointX(index)} ${pointY(turn.total)}`)
    .join(' ');
  const areaPath = `${totalLine} L ${pointX(turnData.length - 1)} ${padY + innerH} L ${pointX(0)} ${padY + innerH} Z`;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)]/60 p-2">
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="token-total-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={alphaColor(CHART_COLOR.input, 35)} />
            <stop offset="100%" stopColor={alphaColor(CHART_COLOR.input, 3)} />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const y = padY + innerH * f;
          return (
            <line
              key={f}
              x1={padX}
              x2={padX + innerW}
              y1={y}
              y2={y}
              stroke="var(--divider)"
              strokeWidth="1"
            />
          );
        })}

        {turnData.length > 1 && <path d={areaPath} fill="url(#token-total-fill)" />}
        {turnData.length > 1 && (
          <path
            d={totalLine}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {turnData.map((turn, index) => {
          const x = pointX(index);
          const totalY = pointY(turn.total);
          const cacheReadHeight = (turn.cacheRead / Math.max(1, maxTurnTokens)) * innerH;
          const cacheCreateHeight = (turn.cacheCreate / Math.max(1, maxTurnTokens)) * innerH;
          const inputHeight = (turn.input / Math.max(1, maxTurnTokens)) * innerH;
          const outputHeight = (turn.output / Math.max(1, maxTurnTokens)) * innerH;
          const baseY = padY + innerH;
          const isCompaction = compactionTurnIndices.has(turn.messageIndex);
          const cacheReadColor = seriesFill('cacheRead', isCompaction, mode);
          const cacheCreateColor = seriesFill('cacheCreate', isCompaction, mode);
          const inputColor = seriesFill('input', isCompaction, mode);
          const outputColor = seriesFill('output', isCompaction, mode);
          const cacheReadTopY = baseY - cacheReadHeight;
          const cacheCreateTopY = cacheReadTopY - cacheCreateHeight;
          const inputTopY = cacheCreateTopY - inputHeight;
          const outputTopY = inputTopY - outputHeight;

          return (
            <g key={turn.id}>
              {isCompaction && (
                <line x1={x} x2={x} y1={padY} y2={baseY} stroke={alphaColor(CHART_COLOR.compaction, 25)} strokeDasharray="2 3" />
              )}
              {turn.cacheRead > 0 && (
                <rect
                  x={x - 4}
                  y={cacheReadTopY}
                  width={8}
                  height={Math.max(2, cacheReadHeight)}
                  rx={2}
                  fill={cacheReadColor}
                />
              )}
              {turn.cacheCreate > 0 && (
                <rect
                  x={x - 4}
                  y={cacheCreateTopY}
                  width={8}
                  height={Math.max(2, cacheCreateHeight)}
                  rx={2}
                  fill={cacheCreateColor}
                />
              )}
              {turn.input > 0 && (
                <rect
                  x={x - 4}
                  y={inputTopY}
                  width={8}
                  height={Math.max(2, inputHeight)}
                  rx={2}
                  fill={inputColor}
                />
              )}
              {turn.output > 0 && (
                <rect
                  x={x - 4}
                  y={outputTopY}
                  width={8}
                  height={Math.max(2, outputHeight)}
                  rx={2}
                  fill={outputColor}
                />
              )}
              <circle cx={x} cy={totalY} r={2.3} fill={isCompaction ? CHART_COLOR.compaction : CHART_COLOR.input} />
              <title>
                {`Turn ${turn.turnIndex + 1}: ${formatTokenCount(turn.total)} total (${formatTokenCount(turn.context)} ctx / ${formatTokenCount(turn.output)} out, ${formatTokenCount(turn.cacheRead)} cache read, ${formatTokenCount(turn.cacheCreate)} cache create)${
                  turn.costUSD > 0 ? ` • ${formatCost(turn.costUSD, costCurrency)}${turn.costSource === 'otlp' ? '' : ' est'}` : ''
                }${isCompaction ? ' • compaction' : ''}`}
              </title>
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex items-center justify-between text-[9px] text-[var(--text-muted)]">
        <span>Turn 1</span>
        <div className="flex items-center gap-3">
          <LegendDot color={seriesFill('cacheRead', false, mode)} label="Cache Read" />
          <LegendDot color={seriesFill('cacheCreate', false, mode)} label="Cache Create" />
          <LegendDot color={seriesFill('input', false, mode)} label="Input" />
          <LegendDot color={seriesFill('output', false, mode)} label="Output" />
          <LegendDot color={CHART_COLOR.compaction} label="Compaction" />
        </div>
        <span>Turn {turnData.length}</span>
      </div>
    </div>
  );
}

function TokenAttributionSection({ messages }: { messages: NormalizedMessage[] }) {
  const attributed = messages.filter((m) => m.attribution);
  if (attributed.length === 0) return null;

  const last = attributed[attributed.length - 1].attribution!;
  const total = last.systemPrompt + last.toolResults + last.conversationHistory + last.cacheRead;
  if (total === 0) return null;

  const segments: { label: string; value: number; color: string }[] = [
    { label: 'System Prompt', value: last.systemPrompt, color: CHART_COLOR.input },
    { label: 'Tool Results', value: last.toolResults, color: CHART_COLOR.toolResults },
    { label: 'Conversation', value: last.conversationHistory, color: CHART_COLOR.output },
    { label: 'Cache Read', value: last.cacheRead, color: CHART_COLOR.cacheRead },
  ];

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
      <span className="text-[11px] font-semibold text-[var(--text)] block mb-0.5">
        Input Token Attribution (Latest Turn)
      </span>
      <span className="text-[9px] text-[var(--text-muted)] block mb-1.5">
        Estimated — based on message sizes, not exact token counts
      </span>
      <div className="h-3 rounded-full overflow-hidden flex border border-[var(--border)] bg-[var(--surface-raised)]">
        {segments.map((seg) => {
          const pct = (seg.value / total) * 100;
          if (pct < 1) return null;
          return (
            <div
              key={seg.label}
              className="h-full"
              style={{ width: `${pct}%`, backgroundColor: seg.color }}
              title={`${seg.label}: ${formatTokenCount(seg.value)} (${pct.toFixed(0)}%)`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
        {segments.map((seg) => (
          <div key={seg.label} className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: seg.color }} />
            <span className="text-[9px] text-[var(--text-muted)]">
              {seg.label}: {formatTokenCount(seg.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CompactionSummary({ events }: { events: CompactionEvent[] }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
      <span className="text-[11px] font-semibold text-[var(--text)] block mb-2">
        Context Compactions ({events.length})
      </span>
      <div className="space-y-1.5">
        {events.map((e, i) => (
          <div key={i} className="flex items-center gap-2 text-[10px] rounded-md border border-[var(--border)] bg-[var(--bg)]/50 px-2 py-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--error)] shrink-0 animate-pulse" />
            <span className="text-[var(--text-muted)] min-w-[52px]">Turn {e.turnIndex + 1}</span>
            <span className="text-[var(--text-secondary)] font-medium">
              {formatTokenCount(e.tokensBefore)} → {formatTokenCount(e.tokensAfter)}
            </span>
            <span className="text-[var(--error)]">
              (-{Math.round((1 - e.tokensAfter / e.tokensBefore) * 100)}%)
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]/70 px-2.5 py-2">
      <div className="text-[9px] text-[var(--text-muted)] uppercase tracking-wider">{label}</div>
      <div className="text-sm font-semibold text-[var(--text)] mt-0.5">
        {value}
        {sub && <span className="text-[9px] font-normal text-[var(--text-muted)] ml-1">{sub}</span>}
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
      <span>{label}</span>
    </span>
  );
}
