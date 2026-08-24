import type { NormalizedToolCall, NormalizedToolResult } from '../../../../shared/agent-session-types';
import { truncateContent } from '../../../lib/truncate';
import { ErrorBanner } from './CodeView';

interface BashToolViewerProps {
  toolCall: NormalizedToolCall;
  toolResult?: NormalizedToolResult;
}

export function BashToolViewer({ toolCall, toolResult }: BashToolViewerProps) {
  const command = (toolCall.input.command as string) ?? '';
  const description = (toolCall.input.description as string) ?? '';

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)]">
      <div className="bg-[var(--surface)] px-2.5 py-1.5 border-b border-[var(--border)]">
        {description && <div className="mb-1 text-[10px] text-[var(--text-muted)]">{description}</div>}
        <div className="flex items-start gap-1.5 font-mono text-[11px] leading-[1.55]">
          <span className="shrink-0 select-none text-[var(--success)]">$</span>
          <code className="whitespace-pre-wrap break-all text-[var(--text)]">{command}</code>
        </div>
      </div>
      {toolResult && (toolResult.isError
        ? <ErrorBanner content={toolResult.content} />
        : (
          <div className="overflow-auto bg-[var(--bg)]" style={{ maxHeight: 300 }}>
            <pre className="px-3 py-2 font-mono text-[11px] leading-[1.55] whitespace-pre-wrap break-all text-[var(--text-secondary)]">
              {truncateContent(toolResult.content, 3000)}
            </pre>
          </div>
        ))}
    </div>
  );
}
