import type { DecomposeTask } from '../../../shared/kanban-types';
import { cn } from '../../lib/cn';

const COMPLEXITY_COLORS = {
  S: { bg: 'rgba(63,185,80,0.12)', text: 'var(--success)', border: 'rgba(63,185,80,0.3)' },
  M: { bg: 'rgba(210,153,34,0.12)', text: 'var(--warning)', border: 'rgba(210,153,34,0.3)' },
  L: { bg: 'rgba(248,81,73,0.12)', text: 'var(--error)', border: 'rgba(248,81,73,0.3)' },
} as const;

interface DecomposeTaskItemProps {
  task: DecomposeTask;
  index: number;
  selected: boolean;
  onToggle: () => void;
}

export function DecomposeTaskItem({ task, index, selected, onToggle }: DecomposeTaskItemProps) {
  const complexity = COMPLEXITY_COLORS[task.complexity];

  return (
    <div
      onClick={onToggle}
      className={cn(
        'group rounded-lg border p-3 cursor-pointer transition-all duration-150',
        selected
          ? 'bg-[var(--accent)]/5 border-[var(--accent)]/30'
          : 'bg-[var(--surface)] border-[var(--border)] hover:border-[rgba(255,255,255,0.16)]',
      )}
    >
      <div className="flex items-start gap-2.5">
        <div className={cn(
          'mt-0.5 h-4 w-4 rounded border-2 shrink-0 flex items-center justify-center transition-colors',
          selected
            ? 'bg-[var(--accent)] border-[var(--accent)]'
            : 'border-[var(--border)] group-hover:border-[var(--text-muted)]',
        )}>
          {selected && (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2 5L4 7L8 3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] text-[var(--text-muted)] font-mono">{index + 1}.</span>
            <span
              className="text-[9px] font-bold px-1.5 py-px rounded leading-none"
              style={{ background: complexity.bg, color: complexity.text, border: `1px solid ${complexity.border}` }}
            >
              {task.complexity}
            </span>
            <span className="text-[12px] font-semibold text-[var(--text)] truncate font-mono">
              {task.title}
            </span>
          </div>

          <p className="text-[11px] leading-[1.4] text-[var(--text-secondary)] line-clamp-3 mb-1.5">
            {task.prompt}
          </p>

          <p className="text-[10px] text-[var(--text-muted)] italic">
            Done when: {task.definitionOfDone}
          </p>

          {task.dependencies.length > 0 && (
            <div className="flex items-center gap-1 mt-1.5">
              <span className="text-[9px] text-[var(--text-muted)]">depends on:</span>
              {task.dependencies.map((dep) => (
                <span key={dep} className="text-[9px] text-[var(--accent)] font-mono">
                  #{dep + 1}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
