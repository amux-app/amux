import { useState } from 'react';
import type { NormalizedToolCall, NormalizedToolResult } from '../../../../shared/agent-session-types';
import { useAgentSessionStore } from '../../../stores';
import { formatTokenCount } from '../../../lib/formatters';
import { cn } from '../../../lib/cn';

interface TaskToolViewerProps {
  toolCall: NormalizedToolCall;
  toolResult?: NormalizedToolResult;
  paneId?: string;
}

export function TaskToolViewer({ toolCall, toolResult, paneId }: TaskToolViewerProps) {
  const [expanded, setExpanded] = useState(false);
  const session = useAgentSessionStore((s) => paneId ? s.sessions[paneId] : undefined);
  const subagent = session?.subagents?.find((s) => s.parentToolCallId === toolCall.id);

  const description = (toolCall.input.description as string)
    || (toolCall.input.prompt as string)
    || '';

  return (
    <div className="text-[11px]">
      <div className="px-2 py-1.5 bg-[var(--surface)] rounded-t border border-[var(--border)]">
        <div className="flex items-center justify-between">
          <span className="font-medium text-[var(--text)]">Subagent</span>
          {subagent && (
            <span className="text-[9px] text-[var(--text-muted)]">
              {subagent.messages.length} msgs · {formatTokenCount(subagent.metrics.totalTokens)}
            </span>
          )}
        </div>
        {description && (
          <p className="text-[10px] text-[var(--text-secondary)] mt-0.5 truncate">{description}</p>
        )}
      </div>

      <div className="border border-t-0 border-[var(--border)] rounded-b overflow-hidden">
        {subagent && subagent.messages.length > 0 ? (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
              className="w-full text-left px-2 py-1 text-[10px] text-[var(--accent)] hover:bg-[var(--surface)] transition-colors"
            >
              {expanded ? 'Hide' : 'Show'} {subagent.messages.length} subagent messages
            </button>
            {expanded && (
              <div className="max-h-[300px] overflow-y-auto border-t border-[var(--border)]">
                {subagent.messages.map((msg) => (
                  <SubagentMessageRow key={msg.id} message={msg} />
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="px-2 py-1 text-[10px] text-[var(--text-muted)]">
            {toolResult?.isError ? (
              <span className="text-[var(--error)]">{toolResult.content.slice(0, 300)}</span>
            ) : (
              toolResult?.content ? toolResult.content.slice(0, 300) : 'No subagent data captured'
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SubagentMessageRow({ message }: { message: import('../../../../shared/agent-session-types').NormalizedMessage }) {
  const isAssistant = message.type === 'assistant';
  return (
    <div className={cn(
      'px-2 py-1 border-b border-[var(--border)] last:border-b-0',
      isAssistant ? 'bg-[var(--surface-raised)]/50' : 'bg-transparent',
    )}>
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className="text-[8px] font-medium uppercase tracking-wider text-[var(--text-muted)]">{message.type}</span>
        {message.toolCalls.length > 0 && (
          <span className="text-[8px] text-[var(--accent)]">{message.toolCalls.length} tools</span>
        )}
      </div>
      {message.content && (
        <pre className="text-[10px] text-[var(--text-secondary)] whitespace-pre-wrap break-words line-clamp-3">
          {message.content.slice(0, 500)}
        </pre>
      )}
      {message.toolCalls.map((tc) => (
        <div key={tc.id} className="mt-0.5 text-[9px] text-[var(--text-muted)] flex items-center gap-1">
          <span className="font-mono text-[var(--accent)]">{tc.name}</span>
          <span className="truncate">{getToolSummary(tc)}</span>
        </div>
      ))}
    </div>
  );
}

function getToolSummary(tc: NormalizedToolCall): string {
  switch (tc.name) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return (tc.input.file_path as string) ?? '';
    case 'Bash':
      return (tc.input.command as string)?.slice(0, 60) ?? '';
    case 'Grep':
      return (tc.input.pattern as string) ?? '';
    default:
      return Object.keys(tc.input).slice(0, 3).join(', ');
  }
}
