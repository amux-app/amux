import { FilePlus2 } from 'lucide-react';
import type { NormalizedToolCall, NormalizedToolResult } from '../../../../shared/agent-session-types';
import { truncateContent } from '../../../lib/truncate';
import { CodeBlock, ErrorBanner, FileHeader } from './CodeView';

interface WriteToolViewerProps {
  toolCall: NormalizedToolCall;
  toolResult?: NormalizedToolResult;
}

export function WriteToolViewer({ toolCall, toolResult }: WriteToolViewerProps) {
  const filePath = (toolCall.input.file_path as string) ?? '';
  const content = (toolCall.input.content as string) ?? '';

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)]">
      <FileHeader icon={<FilePlus2 className="shrink-0 text-[var(--success)]" size={11} />} path={filePath}>
        <span className="shrink-0 text-[10px] text-[var(--text-muted)]">new file</span>
      </FileHeader>
      {toolResult?.isError
        ? <ErrorBanner content={toolResult.content} />
        : <CodeBlock code={truncateContent(content, 3000)} fileName={filePath} />}
    </div>
  );
}
