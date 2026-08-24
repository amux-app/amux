import { FilePenLine } from 'lucide-react';
import type { NormalizedToolCall, NormalizedToolResult } from '../../../../shared/agent-session-types';
import { DiffBlock, DiffStat, ErrorBanner, FileHeader } from './CodeView';

interface EditToolViewerProps {
  toolCall: NormalizedToolCall;
  toolResult?: NormalizedToolResult;
}

export function EditToolViewer({ toolCall, toolResult }: EditToolViewerProps) {
  const filePath = (toolCall.input.file_path as string) ?? '';
  const oldString = (toolCall.input.old_string as string) ?? '';
  const newString = (toolCall.input.new_string as string) ?? '';
  const removed = oldString ? oldString.split('\n').length : 0;
  const added = newString ? newString.split('\n').length : 0;

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)]">
      <FileHeader icon={<FilePenLine className="shrink-0 text-[var(--warning)]" size={11} />} path={filePath}>
        {removed > 0 && <DiffStat kind="del" value={removed} />}
        {added > 0 && <DiffStat kind="ins" value={added} />}
      </FileHeader>
      <DiffBlock fileName={filePath} newString={newString} oldString={oldString} />
      {toolResult?.isError && <ErrorBanner content={toolResult.content} />}
    </div>
  );
}
