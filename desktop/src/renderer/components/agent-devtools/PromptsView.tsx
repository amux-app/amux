import { ChevronDown, ChevronRight, CornerUpLeft } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { NormalizedSession } from '../../../shared/agent-session-types';
import { activateOnEnterOrSpace } from '../../lib/aria-button';
import { cn } from '../../lib/cn';
import { groupIntoTurns } from '../../lib/conversation-turns';
import { formatSessionOffset, truncateOneLine } from '../../lib/formatters';
import { EmptyState } from '../shared/EmptyState';

interface PromptsViewProps {
  session: NormalizedSession;
  onNavigateToMessage?: (messageId: string) => void;
}

export function PromptsView({ session, onNavigateToMessage }: PromptsViewProps) {
  const turns = useMemo(() => groupIntoTurns(session.messages), [session.messages]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggle = (idx: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  if (turns.length === 0) {
    return (
      <EmptyState
        title="No Prompts Yet"
        description="Your prompts to the agent will appear here once the session starts."
        className="h-full"
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-4 space-y-1">
        {turns.map((turn) => {
          const isExpanded = expanded.has(turn.index);
          const timeLabel = formatSessionOffset(turn.prompt.timestamp, session.startTime);

          return (
            <div key={turn.prompt.id} className="group/row rounded-md border border-transparent hover:border-[var(--border)] transition-colors">
              <div
                role="button"
                tabIndex={0}
                onClick={() => toggle(turn.index)}
                onKeyDown={activateOnEnterOrSpace(() => toggle(turn.index))}
                className="w-full flex items-start gap-2 px-3 py-2 text-left cursor-pointer"
              >
                <span className="shrink-0 mt-0.5 text-[var(--text-muted)]">
                  {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </span>
                <span className="shrink-0 text-[10px] font-mono text-[var(--text-muted)] mt-px w-8">
                  #{turn.index + 1}
                </span>
                <span className={cn(
                  'flex-1 min-w-0 text-[12px] text-[var(--text)]',
                  !isExpanded && 'truncate',
                )}>
                  {isExpanded ? turn.prompt.content.trim() : truncateOneLine(turn.prompt.content, 120)}
                </span>
                {timeLabel && (
                  <span className="shrink-0 text-[9px] font-mono text-[var(--text-muted)] mt-px">
                    {timeLabel}
                  </span>
                )}
                {onNavigateToMessage && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onNavigateToMessage(turn.prompt.id); }}
                    className="shrink-0 ml-1 mt-px text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors opacity-0 group-hover/row:opacity-100"
                    title="Jump to in conversation"
                    aria-label="Jump to in conversation"
                  >
                    <CornerUpLeft size={11} />
                  </button>
                )}
              </div>

              {isExpanded && turn.responses.length > 0 && (
                <div className="px-3 pb-3 pl-[52px]">
                  <div className="rounded-md bg-[var(--surface-raised)] border border-[var(--border)] px-3 py-2 max-h-[300px] overflow-y-auto">
                    <span className="text-[9px] font-medium text-[var(--text-muted)] uppercase tracking-wider">
                      Response
                    </span>
                    <p className="mt-1 text-[12px] text-[var(--text-secondary)] whitespace-pre-wrap break-words">
                      {turn.responses.map((r) => r.content).join('\n\n')}
                    </p>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
