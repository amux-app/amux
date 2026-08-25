import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, FolderOpen } from 'lucide-react';
import type { MuxBasePane } from 'muxbase/core';
import type { GitDiffResponse } from '../../../shared/ipc-types';
import { IPC } from '../../../shared/ipc-channels';
import { invoke } from '../../api/ipc';
import * as gitApi from '../../api/git.api';
import { useWorktreeStatusStore } from '../../stores/worktree-status.store';
import { fileStatusColor, fileStatusLabel } from '../../lib/git-display';
import { GitPill } from '../shared/GitPill';

interface KanbanHoverPopoverProps {
  pane: MuxBasePane;
  anchorEl: HTMLElement | null;
}

export function KanbanHoverPopover({ pane, anchorEl }: KanbanHoverPopoverProps) {
  const status = useWorktreeStatusStore((s) => s.statuses[pane.id]);
  const [diffData, setDiffData] = useState<GitDiffResponse | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const rightSpace = window.innerWidth - rect.right;
    const popoverWidth = 320;
    const left = rightSpace > popoverWidth + 16
      ? rect.right + 8
      : rect.left - popoverWidth - 8;
    setPosition({ top: rect.top, left: Math.max(8, left) });
  }, [anchorEl]);

  useEffect(() => {
    if (!pane.worktreePath) return;
    let stale = false;
    gitApi.getDiff({ worktreePath: pane.worktreePath }).then((data) => {
      if (!stale) setDiffData(data);
    });
    return () => { stale = true; };
  }, [pane.worktreePath]);

  if (!anchorEl || !position) return null;

  const branch = pane.branchName || pane.slug;
  const files = diffData?.files ?? [];

  return createPortal(
    <div
      ref={popoverRef}
      data-testid="kanban-hover-popover"
      className="fixed z-50 w-[320px] max-h-[400px] rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-2xl overflow-hidden"
      style={{
        top: position.top,
        left: position.left,
        animation: 'popover-in 150ms ease forwards',
      }}
    >
      <style>{`
        @keyframes popover-in {
          from { opacity: 0; transform: translateX(8px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>

      <div className="px-3 py-2 border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono font-semibold text-[var(--text)] truncate">
            &#x2387; {branch}
          </span>
          <ActionButton
            title="Copy branch name"
            onClick={() => invoke(IPC.SYSTEM_CLIPBOARD_WRITE, { text: branch })}
          >
            <Copy size={10} />
          </ActionButton>
        </div>
        {pane.worktreePath && (
          <div className="flex items-center gap-1 mt-1">
            <span className="text-[9px] font-mono text-[var(--text-muted)] truncate flex-1">
              {pane.worktreePath}
            </span>
            <ActionButton
              title="Reveal in file manager"
              onClick={() => invoke(IPC.SYSTEM_REVEAL_PATH, { path: pane.worktreePath })}
            >
              <FolderOpen size={10} />
            </ActionButton>
          </div>
        )}
      </div>

      {status && (
        <div className="flex gap-1.5 px-3 py-1.5 border-b border-[var(--border)]">
          {status.commitsAhead !== null && status.commitsAhead > 0 && (
            <GitPill>{status.commitsAhead} ahead</GitPill>
          )}
          <GitPill>{status.filesChanged} files</GitPill>
          <GitPill color={status.isDirty ? 'var(--agent-waiting)' : 'var(--agent-idle)'}>
            {status.isDirty ? 'dirty' : 'clean'}
          </GitPill>
        </div>
      )}

      {files.length > 0 && (
        <div className="max-h-[220px] overflow-y-auto">
          {files.map((file) => (
            <div key={file.path} className="flex items-center gap-2 px-3 py-1 border-b border-[var(--border)] last:border-b-0">
              <span
                className="text-[9px] font-mono w-4 text-right shrink-0"
                style={{ color: fileStatusColor(file.status) }}
              >
                {fileStatusLabel(file.status)}
              </span>
              <span className="text-[10px] font-mono text-[var(--text-secondary)] truncate flex-1">
                {file.path}
              </span>
              {(file.additions > 0 || file.deletions > 0) && (
                <span className="text-[9px] font-mono shrink-0">
                  {file.additions > 0 && <span className="text-[var(--success)]">+{file.additions}</span>}
                  {file.additions > 0 && file.deletions > 0 && ' '}
                  {file.deletions > 0 && <span className="text-[var(--error)]">-{file.deletions}</span>}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {files.length === 0 && diffData && (
        <div className="px-3 py-4 text-center text-[10px] text-[var(--text-muted)]">
          No changed files
        </div>
      )}

      {!diffData && (
        <div className="px-3 py-4 text-center text-[10px] text-[var(--text-muted)] animate-pulse">
          Loading file details...
        </div>
      )}
    </div>,
    document.body,
  );
}

function ActionButton({ children, title, onClick }: { children: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--surface-raised)] transition-colors"
      title={title}
    >
      {children}
    </button>
  );
}

