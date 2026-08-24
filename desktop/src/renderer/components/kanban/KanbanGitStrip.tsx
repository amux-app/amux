import type { AumxPane } from 'aumx/core';
import { useWorktreeStatusStore } from '../../stores/worktree-status.store';
import { GitPill } from '../shared/GitPill';

interface KanbanGitStripProps {
  pane: AumxPane;
}

export function KanbanGitStrip({ pane }: KanbanGitStripProps) {
  const status = useWorktreeStatusStore((s) => s.statuses[pane.id]);
  const branch = pane.branchName || pane.slug;

  if (!pane.worktreePath) return null;

  if (!status) {
    return (
      <div data-testid="kanban-git-strip" className="flex items-center gap-1.5 mt-2 pt-2 border-t border-[var(--border)]">
        <SkeletonPill width={72} />
        <SkeletonPill width={40} />
        <SkeletonPill width={32} />
      </div>
    );
  }

  return (
    <div data-testid="kanban-git-strip" className="flex items-center gap-1.5 mt-2 pt-2 border-t border-[var(--border)] flex-wrap">
      <GitPill>
        <span className="opacity-60">&#x2387;</span>
        <span className="truncate max-w-[100px]">{branch}</span>
      </GitPill>
      {status.filesChanged > 0 && (
        <GitPill>
          <span>{status.filesChanged} file{status.filesChanged !== 1 ? 's' : ''}</span>
        </GitPill>
      )}
      {status.commitsAhead !== null && status.commitsAhead > 0 && (
        <GitPill>
          <span>{status.commitsAhead} ahead</span>
        </GitPill>
      )}
      <span
        className="h-1.5 w-1.5 rounded-full ml-auto shrink-0"
        style={{ backgroundColor: status.isDirty ? 'var(--agent-waiting)' : 'var(--agent-idle)' }}
        title={status.isDirty ? 'Uncommitted changes' : 'Clean'}
      />
    </div>
  );
}

function SkeletonPill({ width }: { width: number }) {
  return (
    <span
      className="inline-block h-4 rounded bg-[var(--surface-raised)] animate-pulse"
      style={{ width }}
    />
  );
}
