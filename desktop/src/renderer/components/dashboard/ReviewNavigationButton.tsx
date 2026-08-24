import { ArrowLeft, ArrowRight } from 'lucide-react';
import { usePaneStore } from '../../stores/pane.store';
import { useUiStore } from '../../stores/ui.store';

interface ReviewNavigationButtonProps {
  direction: 'back' | 'forward';
  label: string;
  targetPaneId?: string;
}

export function ReviewNavigationButton({
  direction,
  label,
  targetPaneId,
}: ReviewNavigationButtonProps) {
  const selectPane = usePaneStore((state) => state.selectPane);
  const focusPane = useUiStore((state) => state.focusPane);
  const viewMode = useUiStore((state) => state.viewMode);
  const Icon = direction === 'back' ? ArrowLeft : ArrowRight;

  return (
    <button
      type="button"
      aria-label={label}
      disabled={!targetPaneId}
      onClick={(event) => {
        event.stopPropagation();
        if (!targetPaneId) return;
        selectPane(targetPaneId);
        if (viewMode === 'focus') focusPane(targetPaneId);
      }}
      className="flex min-h-6 max-w-40 items-center gap-1 rounded px-1.5 text-[11px] font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-raised)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-[var(--text-muted)]"
    >
      <Icon size={12} className="shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}
