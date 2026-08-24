import { useEffect, useState } from 'react';
import { Copy, FolderOpen, Replace } from 'lucide-react';
import type { AumxPane } from 'aumx/core';
import type { GitDiffResponse } from '../../../shared/ipc-types';
import { IPC } from '../../../shared/ipc-channels';
import { invoke } from '../../api/ipc';
import * as gitApi from '../../api/git.api';
import { useWorktreeStatusStore } from '../../stores/worktree-status.store';
import { fileStatusColor, fileStatusLabel } from '../../lib/git-display';
import { GitPill } from '../shared/GitPill';
import { AttachWorktreePicker } from '../worktree/AttachWorktreePicker';

export interface WorktreeTabProps {
  pane: AumxPane;
}

export function WorktreeTab({ pane }: WorktreeTabProps) {
  const status = useWorktreeStatusStore((s) => s.statuses[pane.id]);
  const [diffData, setDiffData] = useState<GitDiffResponse | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const branch = pane.branchName || pane.slug;

  useEffect(() => {
    if (!pane.worktreePath) return;
    let stale = false;
    gitApi.getDiff({ worktreePath: pane.worktreePath }).then((data) => {
      if (!stale) setDiffData(data);
    });
    return () => { stale = true; };
  }, [pane.worktreePath]);

  if (!pane.worktreePath) {
    return (
      <div data-testid="worktree-tab-content" className="flex items-center justify-center h-full text-[11px] text-[var(--text-muted)]">
        No worktree attached
      </div>
    );
  }

  const files = diffData?.files ?? [];
  const recentCommits = diffData?.recentCommits ?? [];

  return (
    <div data-testid="worktree-tab-content" className="h-full overflow-y-auto">
      <div className="px-3 py-2 border-b border-[var(--border)]">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[12px] font-mono font-semibold text-[var(--text)]">
            &#x2387; {branch}
          </span>
          {status && (
            <div className="flex items-center gap-1 ml-auto">
              {status.commitsAhead !== null && status.commitsAhead > 0 && (
                <GitPill>{status.commitsAhead} ahead</GitPill>
              )}
              <GitPill>{status.filesChanged} files</GitPill>
              <span
                className="h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: status.isDirty ? 'var(--agent-waiting)' : 'var(--agent-idle)' }}
                title={status.isDirty ? 'Uncommitted changes' : 'Clean'}
              />
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[9px] font-mono text-[var(--text-muted)] truncate flex-1">
            {pane.worktreePath}
          </span>
          <ActionButton
            title="Copy path"
            onClick={() => invoke(IPC.SYSTEM_CLIPBOARD_WRITE, { text: pane.worktreePath! })}
          >
            <Copy size={10} />
          </ActionButton>
          <ActionButton
            title="Reveal in file manager"
            onClick={() => invoke(IPC.SYSTEM_REVEAL_PATH, { path: pane.worktreePath! })}
          >
            <FolderOpen size={10} />
          </ActionButton>
          <ActionButton
            title="Switch to a different worktree"
            onClick={() => setPickerOpen(true)}
          >
            <Replace size={10} />
          </ActionButton>
        </div>
      </div>

      {files.length > 0 && (
        <div className="border-b border-[var(--border)]">
          <div className="px-3 py-1.5">
            <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
              Changed Files
            </span>
          </div>
          {files.map((file) => (
            <div
              key={file.path}
              className="flex items-center gap-2 px-3 py-1 hover:bg-[var(--surface-raised)] transition-colors"
            >
              <span
                className="text-[9px] font-mono w-3 text-center shrink-0 font-bold"
                style={{ color: fileStatusColor(file.status) }}
              >
                {fileStatusLabel(file.status)}
              </span>
              <span className="text-[10px] font-mono text-[var(--text-secondary)] truncate flex-1">
                {file.path}
              </span>
              <ChangeBar additions={file.additions} deletions={file.deletions} />
            </div>
          ))}
        </div>
      )}

      {recentCommits.length > 0 && (
        <div>
          <div className="px-3 py-1.5">
            <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
              Recent Commits
            </span>
          </div>
          {recentCommits.map((commit) => (
            <div key={commit.sha} className="flex items-center gap-2 px-3 py-1">
              <span className="text-[9px] font-mono text-[var(--accent)] shrink-0">
                {commit.sha}
              </span>
              <span className="text-[10px] text-[var(--text-secondary)] truncate">
                {commit.message}
              </span>
            </div>
          ))}
        </div>
      )}

      {files.length === 0 && diffData && (
        <div className="px-3 py-6 text-center text-[11px] text-[var(--text-muted)]">
          No changed files
        </div>
      )}

      {!diffData && (
        <div className="px-3 py-6 text-center text-[11px] text-[var(--text-muted)] animate-pulse">
          Loading worktree data...
        </div>
      )}

      {pickerOpen && (
        <AttachWorktreePicker
          paneId={pane.id}
          paneSlug={pane.slug}
          onClose={() => setPickerOpen(false)}
          onAttached={() => setDiffData(null)}
        />
      )}
    </div>
  );
}

function ActionButton({ children, title, onClick }: { children: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--surface-raised)] transition-colors"
      title={title}
    >
      {children}
    </button>
  );
}

function ChangeBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  if (total === 0) return null;

  const addPct = (additions / total) * 100;

  return (
    <div className="flex items-center gap-1 shrink-0">
      <span className="text-[9px] font-mono">
        {additions > 0 && <span className="text-[var(--success)]">+{additions}</span>}
        {additions > 0 && deletions > 0 && ' '}
        {deletions > 0 && <span className="text-[var(--error)]">-{deletions}</span>}
      </span>
      <div className="w-8 h-1 rounded-full overflow-hidden bg-[var(--error)]">
        <div
          className="h-full bg-[var(--success)]"
          style={{ width: `${addPct}%` }}
        />
      </div>
    </div>
  );
}
