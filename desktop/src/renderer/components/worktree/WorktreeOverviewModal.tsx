import type { MuxBasePane } from 'muxbase/core';
import type { PaneActivityState } from '../../../shared/pane-activity';
import { FolderOpen, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NormalizedSession } from '../../../shared/agent-session-types';
import type { OrphanedWorktreeInfo } from '../../../shared/ipc-types';
import type { PaneActivity } from '../../../shared/pane-activity';
import * as worktreeApi from '../../api/worktree.api';
import { cn } from '../../lib/cn';
import { formatRelativeTime } from '../../lib/formatters';
import { getEffectivePaneStatus } from '../../lib/pane-attention';
import { useNotificationStore } from '../../stores';
import { useAgentSessionStore } from '../../stores/agent-session.store';
import { usePaneActivityStore } from '../../stores/pane-activity.store';
import { usePaneStore } from '../../stores/pane.store';
import { useWorktreeStatusStore } from '../../stores/worktree-status.store';
import { Badge } from '../shared/Badge';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { StatusDot } from '../shared/StatusDot';

interface WorktreeOverviewModalProps {
  onClose: () => void;
  onJumpToPane: (paneId: string) => void;
}

type WorktreeEntry =
  | {
    branch: string;
    id: string;
    kind: 'active';
    pane: MuxBasePane;
    path: string;
    prompt: string;
    slug: string;
  }
  | {
    branch: string;
    id: string;
    kind: 'preserved';
    path: string;
    prompt: string;
    slug: string;
    worktree: OrphanedWorktreeInfo;
  };

export function WorktreeOverviewModal({ onClose, onJumpToPane }: WorktreeOverviewModalProps) {
  const panes = usePaneStore((s) => s.panes);
  const statuses = useWorktreeStatusStore((s) => s.statuses);
  const sessions = useAgentSessionStore((s) => s.sessions);
  const activityByPaneId = usePaneActivityStore((s) => s.activityByPaneId);
  const addToast = useNotificationStore((s) => s.addToast);
  const [orphanedWorktrees, setOrphanedWorktrees] = useState<OrphanedWorktreeInfo[]>([]);
  const [inspectingPath, setInspectingPath] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<OrphanedWorktreeInfo | null>(null);
  const [removingPath, setRemovingPath] = useState<string | null>(null);
  const [reopeningPath, setReopeningPath] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const worktreeActionInProgress = inspectingPath !== null
    || removingPath !== null
    || reopeningPath !== null;

  const panesWithWorktree = useMemo(
    () => panes.filter((p) => p.worktreePath),
    [panes],
  );

  useEffect(() => {
    let active = true;
    worktreeApi.listOrphanedWorktrees()
      .then((result) => {
        if (!active) return;
        if (result.success) {
          setOrphanedWorktrees(result.worktrees);
          return;
        }
        if (result.error) {
          addToast(result.error, 'error');
        }
      })
      .catch((error: unknown) => {
        if (active) addToast(`Failed to load preserved worktrees: ${getErrorMessage(error)}`, 'error');
      });
    return () => { active = false; };
  }, [addToast]);

  const entries = useMemo<WorktreeEntry[]>(() => [
    ...panesWithWorktree.map((pane) => ({
      branch: pane.branchName || pane.slug,
      id: pane.id,
      kind: 'active' as const,
      pane,
      path: pane.worktreePath ?? '',
      prompt: pane.prompt || '',
      slug: pane.slug || pane.id,
    })),
    ...orphanedWorktrees.map((worktree) => ({
      branch: worktree.branch ?? worktree.slug,
      id: `preserved:${worktree.path}`,
      kind: 'preserved' as const,
      path: worktree.path,
      prompt: worktree.path,
      slug: worktree.slug,
      worktree,
    })),
  ], [orphanedWorktrees, panesWithWorktree]);

  const filtered = useMemo(() => {
    if (!search) return entries;
    const query = search.toLowerCase();
    return entries.filter((entry) =>
      entry.slug.toLowerCase().includes(query)
      || entry.branch.toLowerCase().includes(query)
      || entry.prompt.toLowerCase().includes(query)
      || entry.path.toLowerCase().includes(query),
    );
  }, [entries, search]);

  const maxTotal = useMemo(
    () => Math.max(1, ...filtered.map((entry) => {
      if (entry.kind === 'preserved') return entry.worktree.gitStatus === 'dirty' ? 1 : 0;
      const status = statuses[entry.pane.id];
      return status ? status.filesChanged : 0;
    })),
    [filtered, statuses],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [search]);

  const handleReopenWorktree = useCallback(async (worktree: OrphanedWorktreeInfo) => {
    setReopeningPath(worktree.path);
    try {
      const result = await worktreeApi.reopenWorktree({ worktreePath: worktree.path });
      if (!result.success || !result.pane) {
        addToast(result.error ?? 'Failed to reopen worktree', 'error');
        return;
      }
      onJumpToPane(result.pane.id);
      onClose();
    } catch (error) {
      addToast(`Failed to reopen worktree: ${getErrorMessage(error)}`, 'error');
    } finally {
      setReopeningPath(null);
    }
  }, [addToast, onClose, onJumpToPane]);

  const handleRequestRemoval = useCallback(async (worktree: OrphanedWorktreeInfo) => {
    setInspectingPath(worktree.path);
    try {
      const result = await worktreeApi.inspectPreservedWorktree({
        worktreePath: worktree.path,
      });
      if (!result.success || !result.worktree) {
        addToast(result.error ?? 'Failed to inspect preserved worktree', 'error');
        return;
      }
      setOrphanedWorktrees((current) => current.map((candidate) =>
        candidate.path === result.worktree?.path ? result.worktree : candidate));
      setPendingRemoval(result.worktree);
    } catch (error) {
      addToast(`Failed to inspect preserved worktree: ${getErrorMessage(error)}`, 'error');
    } finally {
      setInspectingPath(null);
    }
  }, [addToast]);

  const handleConfirmRemoval = useCallback(async () => {
    if (!pendingRemoval) return;
    const worktree = pendingRemoval;
    setPendingRemoval(null);
    setRemovingPath(worktree.path);
    try {
      const result = await worktreeApi.removePreservedWorktree({
        allowDataLoss: hasRemovalRisk(worktree),
        expectedState: {
          branch: worktree.branch,
          gitStatus: worktree.gitStatus,
          registration: worktree.registration,
        },
        worktreePath: worktree.path,
      });
      if (!result.success) {
        addToast(result.error ?? 'Failed to remove preserved worktree', 'error');
        return;
      }
      setOrphanedWorktrees((current) =>
        current.filter((candidate) => candidate.path !== worktree.path));
    } catch (error) {
      addToast(`Failed to remove preserved worktree: ${getErrorMessage(error)}`, 'error');
    } finally {
      setRemovingPath(null);
    }
  }, [addToast, pendingRemoval]);

  const handleEntrySelect = useCallback((entry: WorktreeEntry) => {
    if (entry.kind === 'active') {
      onJumpToPane(entry.pane.id);
      onClose();
      return;
    }
    void handleReopenWorktree(entry.worktree);
  }, [handleReopenWorktree, onClose, onJumpToPane]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (pendingRemoval) return;
    if (e.key === 'Escape') { onClose(); return; }
    if (worktreeActionInProgress) return;
    if (e.key === 'ArrowDown') {
      if (filtered.length === 0) return;
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      if (filtered.length === 0) return;
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter' && filtered[selectedIndex]) {
      handleEntrySelect(filtered[selectedIndex]);
    }
  }, [
    filtered,
    handleEntrySelect,
    onClose,
    pendingRemoval,
    selectedIndex,
    worktreeActionInProgress,
  ]);

  return (
    <div
      data-testid="worktree-overview-modal"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/50 backdrop-blur-sm"
      onClick={() => {
        if (!pendingRemoval) onClose();
      }}
      onKeyDown={handleKeyDown}
    >
      <div
        className="w-full max-w-2xl rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)]">
          <span className="text-[13px] font-semibold text-[var(--text)] flex-1">
            Worktree Overview
            <span className="ml-2 text-[11px] font-normal text-[var(--text-muted)]">
              {panesWithWorktree.length} active
              {orphanedWorktrees.length > 0 && ` | ${orphanedWorktrees.length} preserved`}
            </span>
          </span>
          <button
            onClick={onClose}
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-raised)] transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-4 py-2 border-b border-[var(--border)]">
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by slug, branch, path, or prompt..."
            className="w-full bg-transparent text-[12px] text-[var(--text)] placeholder:text-[var(--text-muted)] outline-none"
          />
        </div>

        <div className="max-h-[50vh] overflow-y-auto">
          {filtered.map((entry, index) => {
            const status = entry.kind === 'active' ? statuses[entry.pane.id] : null;

            return (
              <div
                key={entry.id}
                className={cn(
                  'flex items-center gap-3 px-4 py-2 cursor-pointer transition-colors',
                  worktreeActionInProgress && 'cursor-wait',
                  index === selectedIndex
                    ? 'bg-[var(--accent)]/10'
                    : 'hover:bg-[var(--surface-raised)]',
                )}
                onClick={() => {
                  if (!worktreeActionInProgress) handleEntrySelect(entry);
                }}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                {entry.kind === 'preserved' && entry.worktree.gitStatus === 'unchecked' ? (
                  <span
                    aria-label="Git status not inspected"
                    title="Git status not inspected"
                    className="h-2 w-2 shrink-0 rounded-full bg-[var(--text-muted)] opacity-50"
                  />
                ) : (
                  <StatusDot
                    status={getEntryStatus(entry, sessions, activityByPaneId)}
                    size="sm"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-mono font-semibold text-[var(--text)] truncate">
                      {entry.slug}
                    </span>
                    {(entry.kind === 'active' || entry.worktree.branch) && (
                      <span className="text-[9px] font-mono text-[var(--text-muted)] truncate">
                        &#x2387; {entry.branch}
                      </span>
                    )}
                    {entry.kind === 'preserved' && (
                      <span className="rounded border border-[var(--border)] px-1 py-0 text-[8px] uppercase tracking-wide text-[var(--text-muted)]">
                        Preserved
                      </span>
                    )}
                    {entry.kind === 'preserved' && (
                      <span className="text-[9px] text-[var(--text-muted)] truncate">
                        {formatRelativeTime(entry.worktree.lastModifiedMs)}
                      </span>
                    )}
                  </div>
                  {entry.prompt && (
                    <p className="text-[9px] text-[var(--text-muted)] truncate mt-0.5">
                      {entry.prompt}
                    </p>
                  )}
                </div>
                {entry.kind === 'active' && entry.pane.agent && <Badge label={entry.pane.agent} className="shrink-0" />}
                {status && (
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[9px] font-mono text-[var(--text-muted)]">
                      {status.filesChanged} files
                    </span>
                    {status.commitsAhead !== null && status.commitsAhead > 0 && (
                      <span className="text-[9px] font-mono text-[var(--text-muted)]">
                        {status.commitsAhead}&#x2191;
                      </span>
                    )}
                    <div className="w-12 h-1.5 rounded-full bg-[var(--surface-raised)] overflow-hidden">
                      <div
                        className="h-full rounded-full bg-[var(--accent)]"
                        style={{ width: `${(status.filesChanged / maxTotal) * 100}%` }}
                      />
                    </div>
                    <span
                      className="h-2 w-2 rounded-full shrink-0"
                      style={{ backgroundColor: status.isDirty ? 'var(--agent-waiting)' : 'var(--agent-idle)' }}
                    />
                  </div>
                )}
                {entry.kind === 'preserved' && (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      aria-label={`Open pane for ${entry.slug}`}
                      title="Open pane"
                      disabled={worktreeActionInProgress}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleEntrySelect(entry);
                      }}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--accent)] disabled:cursor-wait disabled:opacity-60"
                    >
                      <FolderOpen size={13} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove preserved worktree ${entry.slug}`}
                      title="Remove preserved worktree"
                      disabled={worktreeActionInProgress}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleRequestRemoval(entry.worktree);
                      }}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--error)]/10 hover:text-[var(--error)] disabled:cursor-wait disabled:opacity-60"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-[11px] text-[var(--text-muted)]">
              {search ? 'No matching worktrees' : 'No worktrees'}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 px-4 py-2 border-t border-[var(--border)]">
          <KbdHint keys={['↑', '↓']}>Navigate</KbdHint>
          <KbdHint keys={['Enter']}>Jump</KbdHint>
          <KbdHint keys={['Esc']}>Close</KbdHint>
        </div>
      </div>
      <ConfirmDialog
        open={pendingRemoval !== null}
        title="Remove preserved worktree?"
        message={pendingRemoval ? getRemovalConfirmationMessage(pendingRemoval) : ''}
        confirmLabel="Delete worktree"
        onConfirm={() => { void handleConfirmRemoval(); }}
        onCancel={() => setPendingRemoval(null)}
        danger
      />
    </div>
  );
}

function KbdHint({ keys, children }: { keys: string[]; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1 text-[9px] text-[var(--text-muted)]">
      {keys.map((key) => (
        <kbd
          key={key}
          className="px-1 py-0.5 rounded border border-[var(--border)] bg-[var(--surface-raised)] font-mono text-[8px]"
        >
          {key}
        </kbd>
      ))}
      <span>{children}</span>
    </span>
  );
}

function getEntryStatus(
  entry: WorktreeEntry,
  sessions: Record<string, NormalizedSession>,
  activityByPaneId: Record<string, PaneActivity>,
): PaneActivityState {
  if (entry.kind === 'active') {
    return getEffectivePaneStatus(entry.pane, sessions[entry.pane.id], activityByPaneId[entry.pane.id]);
  }
  return entry.worktree.gitStatus === 'dirty' ? 'waiting' : 'idle';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getRemovalConfirmationMessage(worktree: OrphanedWorktreeInfo): string {
  if (worktree.registration !== 'registered') {
    return `"${worktree.slug}" is not registered with the active Git repository, or its registration could not be verified. Deleting it permanently removes the directory, and branch preservation cannot be guaranteed.`;
  }
  if (worktree.gitStatus === 'dirty') {
    if (worktree.branch === null) {
      return `"${worktree.slug}" has uncommitted changes and a detached HEAD. Deleting it permanently removes those changes and may make detached commits unreachable.`;
    }
    return `"${worktree.slug}" has uncommitted changes. Deleting it permanently removes those changes. Its Git branch will be kept.`;
  }
  if (worktree.branch === null && worktree.gitStatus !== 'unavailable') {
    return `"${worktree.slug}" has a detached HEAD. Deleting it may make detached commits unreachable.`;
  }
  if (worktree.gitStatus === 'unavailable') {
    return `Git status for "${worktree.slug}" could not be verified. Deleting it may permanently remove uncommitted work. Its Git branch will be kept.`;
  }
  return `Remove the preserved worktree "${worktree.slug}"? Its Git branch will be kept.`;
}

function hasRemovalRisk(worktree: OrphanedWorktreeInfo): boolean {
  return worktree.gitStatus !== 'clean'
    || worktree.registration !== 'registered'
    || worktree.branch === null;
}
