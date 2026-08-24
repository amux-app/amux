import { FolderOpen, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { OrphanedWorktreeInfo } from '../../../shared/ipc-types';
import * as paneApi from '../../api/pane.api';
import * as worktreeApi from '../../api/worktree.api';
import { formatRelativeTime } from '../../lib/formatters';
import { useNotificationStore } from '../../stores';
import { Spinner } from '../shared/Spinner';

interface AttachWorktreePickerProps {
  paneId: string;
  paneSlug: string;
  onClose: () => void;
  onAttached: () => void;
}

export function AttachWorktreePicker({ paneId, paneSlug, onClose, onAttached }: AttachWorktreePickerProps) {
  const addToast = useNotificationStore((s) => s.addToast);
  const [worktrees, setWorktrees] = useState<OrphanedWorktreeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [attachingPath, setAttachingPath] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    worktreeApi.listOrphanedWorktrees()
      .then((result) => {
        if (!active) return;
        if (result.success) {
          setWorktrees(result.worktrees);
        } else if (result.error) {
          addToast(result.error, 'error');
        }
      })
      .catch((err: unknown) => {
        if (active) addToast(`Failed to list worktrees: ${err instanceof Error ? err.message : String(err)}`, 'error');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [addToast]);

  const handleAttach = async (worktree: OrphanedWorktreeInfo) => {
    setAttachingPath(worktree.path);
    try {
      const result = await paneApi.attachWorktree({ paneId, worktreePath: worktree.path });
      if (!result.success) {
        addToast(result.error ?? 'Failed to attach worktree', 'error');
        return;
      }
      onAttached();
      onClose();
    } catch (err) {
      addToast(`Failed to attach worktree: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setAttachingPath(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/50 backdrop-blur-sm"
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div
        className="w-full max-w-2xl rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)]">
          <span className="text-[13px] font-semibold text-[var(--text)] flex-1">
            Attach worktree to <span className="font-mono text-[var(--accent)]">{paneSlug}</span>
          </span>
          <button
            onClick={onClose}
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-raised)] transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        <div className="max-h-[50vh] overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Spinner />
            </div>
          )}
          {!loading && worktrees.length === 0 && (
            <div className="px-4 py-8 text-center text-[11px] text-[var(--text-muted)]">
              No available worktrees to attach.
            </div>
          )}
          {!loading && worktrees.map((worktree) => (
            <button
              key={worktree.path}
              type="button"
              disabled={attachingPath !== null}
              onClick={() => void handleAttach(worktree)}
              className="w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-[var(--surface-raised)] transition-colors disabled:opacity-60 disabled:cursor-wait"
            >
              <FolderOpen size={14} className="text-[var(--text-muted)] shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-mono font-semibold text-[var(--text)] truncate">
                    {worktree.slug}
                  </span>
                  {worktree.branch && (
                    <span className="text-[9px] font-mono text-[var(--text-muted)] truncate">
                      &#x2387; {worktree.branch}
                    </span>
                  )}
                  {worktree.gitStatus === 'dirty' && (
                    <span className="rounded border border-[var(--warning)]/30 px-1 py-0 text-[8px] uppercase tracking-wide text-[var(--warning)]">
                      Dirty
                    </span>
                  )}
                </div>
                <div className="text-[9px] text-[var(--text-muted)] truncate mt-0.5">
                  {worktree.path}
                </div>
              </div>
              <span className="text-[9px] text-[var(--text-muted)] shrink-0">
                {formatRelativeTime(worktree.lastModifiedMs)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
