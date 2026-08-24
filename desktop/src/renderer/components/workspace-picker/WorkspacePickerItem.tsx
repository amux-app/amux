import { Loader2, Plus, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { truncatePath } from '../../lib/formatters';
import type { MergedProject } from '../../stores';

interface WorkspacePickerItemProps {
  project: MergedProject;
  isSelected: boolean;
  isDeleting: boolean;
  onResume: () => void;
  onNewPane: () => void;
  onHover: () => void;
  onDelete: () => void | Promise<void>;
}

function timeAgo(epoch: number): string {
  const seconds = Math.floor((Date.now() - epoch) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function WorkspacePickerItem({ project, isSelected, isDeleting, onResume, onNewPane, onHover, onDelete }: WorkspacePickerItemProps) {
  const hasPanes = project.paneCount > 0;
  const showActions = isSelected && hasPanes;

  return (
    <div
      onMouseEnter={onHover}
      className={cn(
        'group w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 cursor-pointer',
        isDeleting && 'opacity-50 pointer-events-none',
        isSelected
          ? 'bg-[var(--surface)] text-[var(--text)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--surface)]',
      )}
      onClick={onResume}
    >
      {/* Project info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {project.isActive && (
            <span
              className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ background: 'var(--agent-working, #3fb950)' }}
            />
          )}
          <span className="text-[13px] font-medium truncate">{project.name}</span>
          {hasPanes && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0"
              style={{
                background: 'rgba(88,166,255,0.12)',
                color: 'var(--accent)',
              }}
            >
              {project.paneCount} {project.paneCount === 1 ? 'pane' : 'panes'}
            </span>
          )}
        </div>
        <div className="mt-0.5">
          <span className="text-[11px] text-[var(--text-secondary)] truncate block">
            {truncatePath(project.root)}
          </span>
        </div>
      </div>

      {/* Right side: action buttons or time ago */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {showActions ? (
          <div className="flex items-center gap-1">
            <button
              onClick={(e) => { e.stopPropagation(); onResume(); }}
              className="px-2 py-1 rounded text-[10px] font-medium transition-all duration-150 hover:bg-[rgba(88,166,255,0.22)]"
              style={{
                background: 'rgba(88,166,255,0.12)',
                color: 'var(--accent)',
              }}
            >
              Resume
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onNewPane(); }}
              className="flex items-center gap-0.5 px-2 py-1 rounded text-[10px] font-medium transition-all duration-150 hover:bg-[rgba(255,255,255,0.08)] hover:text-[var(--text)]"
              style={{
                background: 'rgba(255,255,255,0.04)',
                color: 'var(--text-secondary)',
              }}
            >
              <Plus size={9} strokeWidth={2} />
              New Pane
            </button>
          </div>
        ) : (
          <span className="text-[11px] text-[var(--text-secondary)]">
            {timeAgo(project.lastOpened)}
          </span>
        )}

        {/* Delete button - appears on hover, shows spinner when deleting */}
        <button
          aria-label={`Remove ${project.name} from history`}
          onMouseDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
          }}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            if (!isDeleting) {
              void onDelete();
            }
          }}
          disabled={isDeleting}
          className={cn(
            'p-1 rounded transition-all duration-150 pointer-events-auto',
            isDeleting
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100 hover:bg-[rgba(255,255,255,0.08)] hover:text-[var(--text)]',
            'text-[var(--text-secondary)]'
          )}
          title="Remove from history"
        >
          {isDeleting ? (
            <Loader2 size={12} strokeWidth={1.5} className="animate-spin" />
          ) : (
            <X size={12} strokeWidth={1.5} />
          )}
        </button>
      </div>
    </div>
  );
}
