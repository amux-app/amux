import { FileText } from 'lucide-react';
import type { NormalizedToolCall, NormalizedToolResult } from '../../../../shared/agent-session-types';
import { truncateContent } from '../../../lib/truncate';
import { CodeBlock, ErrorBanner, FileHeader } from './CodeView';

interface ReadToolViewerProps {
  toolCall: NormalizedToolCall;
  toolResult?: NormalizedToolResult;
}

function buildRange(offset?: number, limit?: number): string {
  if (!offset && !limit) return '';
  return `${offset ? `L${offset}` : ''}${limit ? `:${limit}` : ''}`;
}

export function ReadToolViewer({ toolCall, toolResult }: ReadToolViewerProps) {
  const filePath = (toolCall.input.file_path as string) ?? '';
  const range = buildRange(toolCall.input.offset as number | undefined, toolCall.input.limit as number | undefined);

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)]">
      <FileHeader icon={<FileText className="shrink-0 text-[var(--accent)]" size={11} />} path={filePath}>
        {range && <span className="shrink-0 text-[10px] text-[var(--text-muted)]">{range}</span>}
      </FileHeader>
      {toolResult && (toolResult.isError
        ? <ErrorBanner content={toolResult.content} />
        : <CodeBlock code={truncateContent(toolResult.content, 3000)} fileName={filePath} />)}
    </div>
  );
}
