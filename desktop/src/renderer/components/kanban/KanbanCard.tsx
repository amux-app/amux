import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type CSSProperties } from 'react';
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { MuxBasePane } from 'muxbase/core';
import type { PaneActivityState } from '../../../shared/pane-activity';
import type { BacklogItem, DoneItem } from '../../../shared/kanban-types';
import { computeSessionDisplayMetrics } from '../../../shared/agent-session-display-metrics';
import { agentHasSessionParsing, type NormalizedSession } from '../../../shared/agent-session-types';
import { getPaneKanbanActivityState } from '../../../shared/kanban-pane-activity';
import { isBusyForKanban, type PaneActivity } from '../../../shared/pane-activity';
import type { KanbanColumnItem } from '../../hooks/useKanbanColumns';
import { useAgentSessionHydration } from '../../hooks/useAgentSessionHydration';
import { useAgentSessionStore } from '../../stores/agent-session.store';
import { usePaneActivityStore } from '../../stores/pane-activity.store';
import { Badge } from '../shared/Badge';
import { StatusDot } from '../shared/StatusDot';
import { cn } from '../../lib/cn';
import { CONTEXT_WINDOW_TOKENS } from '../../lib/constants';
import { formatRelativeTime, formatTokenCount } from '../../lib/formatters';
import { getEffectivePaneStatus } from '../../lib/pane-attention';
import { KanbanGitStrip } from './KanbanGitStrip';
import { KanbanHoverPopover } from './KanbanHoverPopover';

const COMPLEXITY_COLORS = {
  S: { bg: 'rgba(63,185,80,0.12)', text: 'var(--success)', border: 'rgba(63,185,80,0.3)' },
  M: { bg: 'rgba(210,153,34,0.12)', text: 'var(--warning)', border: 'rgba(210,153,34,0.3)' },
  L: { bg: 'rgba(248,81,73,0.12)', text: 'var(--error)', border: 'rgba(248,81,73,0.3)' },
} as const;

interface KanbanCardProps {
  item: KanbanColumnItem;
  columnId?: string;
  isSelected: boolean;
  onClick: () => void;
  onAction?: (action: string) => void;
  draggable?: boolean;
}

interface KanbanCardFrameProps {
  item: KanbanColumnItem;
  columnId?: string;
  isSelected: boolean;
  onClick: () => void;
  onAction?: (action: string) => void;
  draggable: boolean;
  isDragging: boolean;
  refCallback?: (node: HTMLDivElement | null) => void;
  style?: CSSProperties;
  attributes?: DraggableAttributes;
  listeners?: DraggableSyntheticListeners;
}

export function getCardId(item: KanbanColumnItem): string {
  if (item.type === 'backlog') return `backlog-${item.data.id}`;
  if (item.type === 'launching') return `launching-${item.data.id}`;
  if (item.type === 'done') return `done-${item.data.id}`;
  return `pane-${item.data.id}`;
}

export function KanbanCard({
  item,
  columnId,
  isSelected,
  onClick,
  onAction,
  draggable = false,
}: KanbanCardProps) {
  const cardId = getCardId(item);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: cardId,
    disabled: !draggable,
    data: columnId
      ? {
          kind: 'kanban-card',
          columnId,
          itemType: item.type,
          itemId: item.data.id,
        }
      : undefined,
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  return (
    <KanbanCardFrame
      item={item}
      columnId={columnId}
      isSelected={isSelected}
      onClick={onClick}
      onAction={onAction}
      draggable={draggable}
      isDragging={isDragging}
      refCallback={setNodeRef}
      style={style}
      attributes={attributes}
      listeners={draggable ? listeners : undefined}
    />
  );
}

export function KanbanCardPreview({ item }: { item: KanbanColumnItem }) {
  return (
    <KanbanCardFrame
      item={item}
      isSelected={false}
      onClick={() => {}}
      draggable={false}
      isDragging={false}
    />
  );
}

function KanbanCardFrame({
  item,
  columnId,
  isSelected,
  onClick,
  onAction,
  draggable,
  isDragging,
  refCallback,
  style,
  attributes,
  listeners,
}: KanbanCardFrameProps) {
  const paneId = item.type === 'pane' ? item.data.id : null;
  const paneSession = useAgentSessionStore((s) => (paneId ? s.sessions[paneId] : undefined));
  const runtimeActivity = usePaneActivityStore((s) => (paneId ? s.activityByPaneId[paneId] : undefined));
  const shouldHydrateSession = item.type === 'pane' && agentHasSessionParsing(item.data.agent);
  useAgentSessionHydration(paneId, shouldHydrateSession);
  const paneActivity =
    item.type === 'pane' ? getPaneKanbanActivityState(item.data, paneSession, Date.now(), runtimeActivity) : null;
  const isInReviewColumn = columnId === 'review';
  const isInDoneColumn = columnId === 'done';
  const resolvedStatus: PaneActivityState | undefined =
    item.type === 'pane' ? getEffectivePaneStatus(item.data, paneSession, runtimeActivity) : undefined;
  const isWaiting = resolvedStatus === 'waiting';
  const showBusyBorder = !isInReviewColumn && !isInDoneColumn && !!(
    (runtimeActivity ? isBusyForKanban(runtimeActivity) : paneActivity?.isBusy)
    && !isWaiting
  );

  const [hoverAnchor, setHoverAnchor] = useState<HTMLElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cardElRef = useRef<HTMLDivElement | null>(null);

  const isPaneWithWorktree = item.type === 'pane' && !!item.data.worktreePath;

  const handleMouseEnter = useCallback(() => {
    if (!isPaneWithWorktree) return;
    hoverTimerRef.current = setTimeout(() => {
      setHoverAnchor(cardElRef.current);
    }, 400);
  }, [isPaneWithWorktree]);

  const handleMouseLeave = useCallback(() => {
    clearTimeout(hoverTimerRef.current);
    setHoverAnchor(null);
  }, []);

  const handleCardClick = useCallback(() => {
    clearTimeout(hoverTimerRef.current);
    setHoverAnchor(null);
    onClick();
  }, [onClick]);

  useEffect(() => {
    return () => clearTimeout(hoverTimerRef.current);
  }, []);

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      cardElRef.current = node;
      refCallback?.(node);
    },
    [refCallback],
  );

  return (
    <div
      ref={setRefs}
      style={style}
      data-card-id={getCardId(item)}
      {...(attributes ?? {})}
      {...(listeners ?? {})}
      onClick={handleCardClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={cn(
        'group relative rounded-lg border bg-[var(--surface)] p-3 transition-shadow duration-150 overflow-hidden',
        draggable && 'cursor-grab active:cursor-grabbing',
        !draggable && 'cursor-pointer',
        'hover:bg-[var(--surface-raised)] hover:border-[color-mix(in_srgb,var(--text)_20%,var(--border))] hover:shadow-lg',
        isSelected && 'ring-1 ring-[var(--accent)] border-[var(--accent)]',
        isDragging && 'opacity-50 shadow-2xl z-50 scale-[1.02]',
        !isDragging && 'border-[var(--border)]',
        showBusyBorder && !isDragging && 'shadow-[0_0_0_1px_rgba(59,130,246,0.14)_inset,0_0_24px_rgba(56,189,248,0.07)]',
      )}
    >
      {showBusyBorder && !isDragging && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-lg opacity-90"
          style={{
            padding: 1,
            background:
              'linear-gradient(135deg, rgba(56,189,248,0.08) 0%, rgba(59,130,246,0.5) 28%, rgba(99,102,241,0.28) 55%, rgba(56,189,248,0.1) 100%)',
            WebkitMask:
              'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
            WebkitMaskComposite: 'xor',
            maskComposite: 'exclude',
            animation: 'pulse 2.2s ease-in-out infinite',
          }}
        />
      )}
      {item.type === 'backlog' && <BacklogCardContent data={item.data} onAction={onAction} />}
      {item.type === 'launching' && <LaunchingCardContent data={item.data} />}
      {item.type === 'pane' && (
        <PaneCardContent
          data={item.data}
          session={paneSession}
          activity={runtimeActivity}
          status={resolvedStatus ?? 'idle'}
          paneActivity={paneActivity ?? undefined}
          columnId={columnId}
        />
      )}
      {item.type === 'done' && <DoneCardContent data={item.data} />}
      {item.type === 'pane' && hoverAnchor && (
        <KanbanHoverPopover pane={item.data} anchorEl={hoverAnchor} />
      )}
    </div>
  );
}

function IconButton({
  icon,
  tooltip,
  onClick,
  variant = 'default',
}: {
  icon: ReactNode;
  tooltip: string;
  onClick: (e: MouseEvent) => void;
  variant?: 'default' | 'accent' | 'danger';
}) {
  return (
    <button
      onClick={onClick}
      title={tooltip}
      className={cn(
        'w-[26px] h-[26px] flex items-center justify-center rounded-md transition-all duration-150',
        'active:scale-90',
        variant === 'accent' && 'text-[var(--accent)] bg-[var(--accent)]/10 hover:bg-[var(--accent)]/20',
        variant === 'danger' && 'text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--error)]/10',
        variant === 'default' && 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--tool-item-hover-bg)]',
      )}
    >
      {icon}
    </button>
  );
}

const PlayIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
    <path d="M5 3L12 8L5 13V3Z" />
  </svg>
);

const PencilIcon = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11.5 2.5L13.5 4.5L5 13H3V11L11.5 2.5Z" />
  </svg>
);

const TrashIcon = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.5 5H12.5M6 7.5V11.5M10 7.5V11.5M4.5 5L5 13H11L11.5 5M6.5 5V3H9.5V5" />
  </svg>
);

function BacklogCardContent({ data, onAction }: { data: BacklogItem; onAction?: (action: string) => void }) {
  const complexity = COMPLEXITY_COLORS[data.complexity];
  const timeAgo = formatRelativeTime(data.createdAt);

  const handleAction = (action: string) => (e: MouseEvent) => {
    e.stopPropagation();
    onAction?.(action);
  };

  return (
    <div
      className="relative pl-2.5"
      style={{ borderLeft: `3px solid ${complexity.border}` }}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className="h-2 w-2 rounded-full shrink-0"
          style={{ backgroundColor: complexity.text }}
        />
        <span className="text-[12px] font-semibold text-[var(--text)] truncate font-mono flex-1">
          {data.title}
        </span>
        {data.agent && <Badge label={data.agent} className="shrink-0" />}
      </div>

      <p className="text-[11px] leading-[1.45] text-[var(--text-secondary)] line-clamp-3 mb-2">
        {data.prompt}
      </p>

      {data.sourceSlug && (
        <p className="text-[9px] text-[var(--text-muted)] mb-2">
          from <span className="font-mono text-[var(--accent)]">{data.sourceSlug}</span>
        </p>
      )}

      <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
        <span
          className="font-bold px-1.5 py-px rounded-sm text-[9px] leading-none"
          style={{ background: complexity.bg, color: complexity.text, border: `1px solid ${complexity.border}` }}
        >
          {data.complexity === 'S' ? 'Small' : data.complexity === 'M' ? 'Medium' : 'Large'}
        </span>
        {data.useWorktree === false && (
          <span className="text-[var(--text-muted)] font-normal">no worktree</span>
        )}
        {data.projectRoot && (
          <span className="text-[var(--text-muted)] font-mono truncate max-w-[100px]" title={data.projectRoot}>
            {data.projectRoot.split('/').pop()}
          </span>
        )}
        <span className="ml-auto">{timeAgo}</span>
      </div>

      {onAction && (
        <div className="flex items-center gap-1 mt-2.5 pt-2 border-t border-[var(--border)]">
          <IconButton icon={<PlayIcon />} tooltip="Launch agent" onClick={handleAction('launch')} variant="accent" />
          <IconButton icon={<PencilIcon />} tooltip="Edit task" onClick={handleAction('edit')} />
          <div className="ml-auto">
            <IconButton icon={<TrashIcon />} tooltip="Remove" onClick={handleAction('remove')} variant="danger" />
          </div>
        </div>
      )}
    </div>
  );
}

function LaunchingCardContent({ data }: { data: BacklogItem }) {
  const complexity = COMPLEXITY_COLORS[data.complexity];
  return (
    <div
      className="relative pl-2.5"
      style={{ borderLeft: `3px solid ${complexity.border}` }}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="h-2 w-2 rounded-full shrink-0 bg-[var(--agent-working)] animate-pulse" />
        <span className="text-[12px] font-semibold text-[var(--text)] truncate font-mono flex-1">
          {data.title}
        </span>
        {data.agent && <Badge label={data.agent} className="shrink-0" />}
      </div>

      <div className="flex items-center gap-1.5 mb-2">
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-medium border text-[var(--agent-working)] border-[var(--agent-working)]/20 bg-[var(--agent-working)]/10">
          <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
          Launching...
        </span>
      </div>

      <p className="text-[11px] leading-[1.4] text-[var(--text-secondary)] line-clamp-2">
        {data.prompt}
      </p>
    </div>
  );
}

function PaneCardContent({
  data,
  session,
  activity: runtimeActivity,
  status: rawStatus,
  paneActivity,
  columnId,
}: {
  data: MuxBasePane;
  session?: NormalizedSession;
  activity?: PaneActivity;
  status: PaneActivityState;
  paneActivity?: ReturnType<typeof getPaneKanbanActivityState>;
  columnId?: string;
}) {
  const activity = paneActivity ?? getPaneKanbanActivityState(data, session, Date.now(), runtimeActivity);
  const isInReviewColumn = columnId === 'review';
  const isInNeedsAttentionColumn = columnId === 'needs-attention';
  const isInDoneColumn = columnId === 'done';
  const isWaitingForInput = isInNeedsAttentionColumn || (!isInReviewColumn && !isInDoneColumn && (rawStatus === 'waiting' || session?.awaitingUserInput === true));
  const isWorking = !isInReviewColumn && !isInDoneColumn && !isWaitingForInput && activity.isBusy;
  const visualStatus: PaneActivityState = isWaitingForInput ? 'waiting' : isWorking ? 'working' : rawStatus;
  const waitingQuestion = session?.pendingUserQuestion;

  const { lastToolName, errorCount } = useMemo(() => {
    if (!session) return { lastToolName: null, errorCount: 0 };
    let tool: string | null = null;
    let errors = 0;
    for (const msg of session.messages) {
      for (const tr of msg.toolResults) {
        if (tr.isError) errors++;
      }
      if (msg.toolCalls.length > 0) {
        tool = msg.toolCalls[msg.toolCalls.length - 1].name;
      }
    }
    return { lastToolName: tool, errorCount: errors };
  }, [session]);

  const displayMetrics = useMemo(
    () => (session ? computeSessionDisplayMetrics(session) : null),
    [session],
  );

  const subagentToolCallCount = session?.subagents.reduce(
    (count, subagent) => count + subagent.metrics.toolCallCount,
    0,
  ) ?? 0;
  const subagentTotalTokens = session?.subagents.reduce(
    (count, subagent) => count + subagent.metrics.totalTokens,
    0,
  ) ?? 0;

  const totalTokens = (session?.metrics.totalTokens ?? 0) + subagentTotalTokens;
  const promptCount = displayMetrics?.promptCount ?? 0;
  const toolCallCount = (session?.metrics.toolCallCount ?? 0) + subagentToolCallCount;
  const lastUpdatedAt = session?.lastUpdateTime;
  const contextTokens = displayMetrics?.latestAssistantUsage?.contextTokens ?? 0;
  const contextPercent = contextTokens > 0 ? Math.min(100, (contextTokens / CONTEXT_WINDOW_TOKENS) * 100) : 0;
  const statusLabel = isWorking
    ? 'Working'
    : isInReviewColumn
      ? 'In Review'
      : isInNeedsAttentionColumn
        ? 'Needs Attention'
      : isWaitingForInput
        ? 'Needs Input'
        : 'Completed';

  return (
    <>
      <div className="flex items-center gap-2 mb-1.5">
        <StatusDot status={visualStatus} size="sm" />
        <span className="text-[12px] font-semibold text-[var(--text)] truncate font-mono flex-1">
          {data.slug || data.id}
        </span>
        {data.agent && <Badge label={data.agent} className="shrink-0" />}
      </div>

      <div className="flex items-center gap-1.5 mb-2">
        <span
          className={cn(
            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-medium border',
            isInDoneColumn && 'text-[var(--success)] border-[var(--success)]/20 bg-[var(--success)]/10',
            isInReviewColumn && 'text-[var(--accent)] border-[var(--accent)]/20 bg-[var(--accent)]/10',
            isWaitingForInput && 'text-[var(--warning)] border-[var(--warning)]/20 bg-[var(--warning)]/10',
            isWorking && !isWaitingForInput && 'text-[var(--agent-working)] border-[var(--agent-working)]/20 bg-[var(--agent-working)]/10',
            !isInDoneColumn && !isInReviewColumn && !isWorking && !isWaitingForInput && rawStatus === 'idle' && 'text-[var(--accent)] border-[var(--accent)]/20 bg-[var(--accent)]/10',
          )}
        >
          {isWorking && !isWaitingForInput && (
            <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
          )}
          {statusLabel}
        </span>
        {lastUpdatedAt && (
          <span className="text-[9px] text-[var(--text-muted)] ml-auto">
            {formatRelativeTime(lastUpdatedAt)}
          </span>
        )}
      </div>

      <p className="text-[11px] leading-[1.4] text-[var(--text-secondary)] line-clamp-2">
        {data.prompt || 'No prompt provided'}
      </p>

      <KanbanGitStrip pane={data} />

      {isWaitingForInput && waitingQuestion && (
        <div className="mt-2 rounded border border-[rgba(210,153,34,0.3)] bg-[rgba(210,153,34,0.08)] px-2 py-1.5">
          <p className="text-[10px] text-[var(--warning)] leading-tight">{waitingQuestion}</p>
        </div>
      )}

      <div className="grid grid-cols-3 gap-1.5 mt-2">
        <MetricChip label="Prompts" value={String(promptCount)} />
        <MetricChip label="Tools" value={String(toolCallCount)} />
        <MetricChip
          label="Total"
          value={totalTokens > 0 ? formatTokenCount(totalTokens) : '—'}
          emphasize={totalTokens > 0}
        />
      </div>

      <div className="flex items-center gap-2 mt-2 text-[10px] text-[var(--text-muted)]">
        {isWorking && lastToolName && (
          <span className="truncate" style={{ color: 'var(--agent-working)' }}>
            {lastToolName}
          </span>
        )}
        {errorCount > 0 && (
          <span className="ml-auto text-[9px] font-medium text-[var(--error)] bg-[var(--error)]/10 px-1.5 py-0.5 rounded-full shrink-0">
            {errorCount} {errorCount === 1 ? 'error' : 'errors'}
          </span>
        )}
        {contextTokens > 0 && errorCount === 0 && (
          <span className="ml-auto shrink-0">context {formatTokenCount(contextTokens)}</span>
        )}
        {contextTokens === 0 && !session && (isWorking || isWaitingForInput) && (
          <span className="ml-auto shrink-0 text-[var(--text-muted)]">Session starting…</span>
        )}
      </div>

      {(contextPercent > 0 || (isWorking && !session)) && (
        <div className="mt-1.5 h-[2px] rounded-full bg-[var(--border)] overflow-hidden">
          <div
            className={cn('h-full rounded-full transition-all duration-500', isWorking && !session && 'animate-pulse')}
            style={{
              width: `${contextPercent > 0 ? contextPercent : 18}%`,
              backgroundColor:
                contextPercent > 80
                  ? 'var(--warning)'
                  : contextPercent > 50
                    ? 'var(--accent)'
                    : 'var(--agent-working)',
            }}
          />
        </div>
      )}
    </>
  );
}

function MetricChip({
  label,
  value,
  emphasize = false,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)]/50 px-1.5 py-1">
      <div className="text-[8px] uppercase tracking-wider text-[var(--text-muted)]">{label}</div>
      <div className={cn('text-[10px] font-medium mt-0.5', emphasize ? 'text-[var(--text)]' : 'text-[var(--text-secondary)]')}>
        {value}
      </div>
    </div>
  );
}

function DoneCardContent({ data }: { data: DoneItem }) {
  const timeAgo = formatRelativeTime(data.mergedAt);
  return (
    <div className="opacity-70">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[var(--success)] text-[11px]">&#10003;</span>
        <span className="text-[12px] font-semibold text-[var(--text-secondary)] truncate font-mono">
          {data.slug}
        </span>
        {data.agent && <Badge label={data.agent} className="ml-auto shrink-0 opacity-60" />}
      </div>
      <p className="text-[11px] leading-[1.4] text-[var(--text-muted)] line-clamp-2">
        {data.prompt}
      </p>
      <div className="flex items-center gap-2 mt-1.5 text-[10px]">
        <span className="text-[var(--success)]">merged {timeAgo}</span>
        {data.cleanupFailed && (
          <span className="text-[var(--warning)]">cleanup pending</span>
        )}
      </div>
    </div>
  );
}
