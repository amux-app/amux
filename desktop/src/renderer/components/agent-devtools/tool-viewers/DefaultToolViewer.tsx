import type { NormalizedToolCall, NormalizedToolResult } from '../../../../shared/agent-session-types';
import { truncateContent } from '../../../lib/truncate';
import { CodeBlock, ErrorBanner } from './CodeView';

interface DefaultToolViewerProps {
  toolCall: NormalizedToolCall;
  toolResult?: NormalizedToolResult;
}

export function DefaultToolViewer({ toolCall, toolResult }: DefaultToolViewerProps) {
  const hasInput = Object.keys(toolCall.input).length > 0;

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)]">
      <div className="bg-[var(--surface)] px-2.5 py-1.5 border-b border-[var(--border)]">
        <span className="font-medium text-[11px] text-[var(--text)]">{toolCall.name}</span>
      </div>
      {hasInput && (
        <CodeBlock code={JSON.stringify(toolCall.input, null, 2)} language="json" maxHeight={160} />
      )}
      {toolResult && (toolResult.isError
        ? <ErrorBanner content={toolResult.content} />
        : (
          <div className="border-t border-[var(--border)]">
            <CodeBlock code={truncateContent(toolResult.content, 2000)} maxHeight={200} />
          </div>
        ))}
    </div>
  );
}
