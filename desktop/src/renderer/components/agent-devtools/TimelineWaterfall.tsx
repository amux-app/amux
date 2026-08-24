import { useMemo } from 'react';
import type { NormalizedSession, NormalizedToolCall } from '../../../shared/agent-session-types';
import { formatCompactDuration, formatMillis } from '../../lib/formatters';
import { getToolColor } from '../../lib/tool-visuals';
import { Chip } from '../shared/Chip';
import { EmptyState } from '../shared/EmptyState';
import { HoverTooltip } from '../shared/HoverTooltip';

interface TimelineWaterfallProps {
  session: NormalizedSession;
}

interface TimelineEntry {
  toolCall: NormalizedToolCall;
  startOffset: number; // seconds from session start
  durationMs: number;
  isError: boolean;
}

const MIN_BAR_PERCENT = 1.5;
const DEFAULT_DURATION_MS = 500;

export function TimelineWaterfall({ session }: TimelineWaterfallProps) {
  const { entries, maxSeconds, toolCounts } = useMemo(() => {
    const built = buildTimelineEntries(session);
    return {
      entries: built,
      maxSeconds: computeMaxSeconds(built),
      toolCounts: countByTool(built),
    };
  }, [session]);

  if (entries.length === 0) {
    return (
      <EmptyState
        title="No Timeline Data"
        description="Tool execution timeline will appear here as the agent makes tool calls."
        className="h-full"
      />
    );
  }

  return (
    <div className="h-full overflow-auto px-3 py-3">
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <Chip label="Duration" mono>{formatCompactDuration(maxSeconds)}</Chip>
        <Chip label="Calls" mono>{entries.length}</Chip>
        {[...toolCounts.entries()].map(([tool, count]) => (
          <Chip key={tool} label={tool} mono dotColor={getToolColor(tool)}>{count}</Chip>
        ))}
      </div>

      <div className="space-y-0.5">
        {entries.map((entry, i) => (
          <TimelineRow key={`${entry.toolCall.id}-${i}`} entry={entry} maxSeconds={maxSeconds} />
        ))}
      </div>
    </div>
  );
}

function TimelineRow({ entry, maxSeconds }: { entry: TimelineEntry; maxSeconds: number }) {
  const durationSec = entry.durationMs / 1000;
  const offsetPct = (entry.startOffset / maxSeconds) * 100;
  const widthPct = Math.max(MIN_BAR_PERCENT, (durationSec / maxSeconds) * 100);
  const color = getToolColor(entry.toolCall.name, entry.isError);
  const tooltip = `${entry.toolCall.name} · ${durationSec.toFixed(2)}s @ ${entry.startOffset.toFixed(1)}s${entry.isError ? ' · error' : ''}`;

  return (
    <HoverTooltip label={tooltip} className="block">
      <span className="flex items-center gap-2 rounded px-1 py-0.5 transition-colors hover:bg-[var(--tool-item-hover-bg)]">
        <span className="w-16 shrink-0 truncate text-right text-[10px] font-mono text-[var(--text-muted)]">
          {entry.toolCall.name}
        </span>
        <span className="relative h-3 flex-1 rounded-sm bg-[var(--surface-raised)]">
          <span
            className="absolute inset-y-0 rounded-sm"
            style={{
              left: `${Math.min(100 - MIN_BAR_PERCENT, offsetPct)}%`,
              width: `${widthPct}%`,
              backgroundColor: color,
              opacity: 0.85,
            }}
          />
        </span>
        <span className="w-12 shrink-0 text-right text-[9px] font-mono text-[var(--text-muted)]">
          {formatMillis(entry.durationMs)}
        </span>
      </span>
    </HoverTooltip>
  );
}

function computeMaxSeconds(entries: TimelineEntry[]): number {
  let max = 1;
  for (const entry of entries) {
    max = Math.max(max, entry.startOffset + entry.durationMs / 1000);
  }
  return max;
}

function countByTool(entries: TimelineEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.toolCall.name, (counts.get(entry.toolCall.name) ?? 0) + 1);
  }
  return counts;
}

function buildTimelineEntries(session: NormalizedSession): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const sessionStart = session.startTime ?? 0;

  const resultMetaMap = new Map<string, { durationMs?: number; isError: boolean }>();
  for (const msg of session.messages) {
    for (const tr of msg.toolResults) {
      resultMetaMap.set(tr.toolCallId, { durationMs: tr.durationMs, isError: tr.isError });
    }
  }

  for (const msg of session.messages) {
    for (const tc of msg.toolCalls) {
      const startOffset = resolveStartOffset(tc, msg.timestamp, sessionStart, entries.length);
      const meta = resultMetaMap.get(tc.id);
      entries.push({
        toolCall: tc,
        startOffset: Math.max(0, startOffset),
        durationMs: meta?.durationMs ?? DEFAULT_DURATION_MS,
        isError: meta?.isError ?? false,
      });
    }
  }

  return entries;
}

function resolveStartOffset(
  tc: NormalizedToolCall,
  msgTimestamp: number | undefined,
  sessionStart: number,
  fallbackIndex: number,
): number {
  if (tc.timestamp) return (tc.timestamp - sessionStart) / 1000;
  if (msgTimestamp) return (msgTimestamp - sessionStart) / 1000;
  return fallbackIndex * 0.5;
}
