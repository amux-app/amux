import { Shrink } from 'lucide-react';
import { cn } from '../../lib/cn';
import { HEADER_ICON_BUTTON_CLASS } from '../../lib/constants';
import { isKanbanBoardEnabled, isPaneSummaryEnabled } from '../../lib/feature-flags';
import {
  useCommandPaletteStore,
  useElectronSettingsStore,
  useFirstPaneId,
  usePaneStats,
  usePaneStore,
  useUiStore,
} from '../../stores';
import { HoverTooltip } from '../shared/HoverTooltip';
import { AttentionStat } from './AttentionStat';
import { NewPaneSplitButton } from './NewPaneSplitButton';

const COMMAND_PALETTE_LABEL = 'Open command palette (⌘K)';
const NO_DRAG_CLASS = '[-webkit-app-region:no-drag]';
const QUIET_FOCUS_RING_CLASS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/50';
// Keep each stat readable. At constrained widths the action cluster moves to a
// second row instead of clipping content or splitting an action group.
const STATS_GROUP_CLASS = 'flex min-h-6 shrink-0 items-center gap-4 whitespace-nowrap';

export function ResourceBar() {
  const stats = usePaneStats();
  const firstPaneId = useFirstPaneId();
  const openCommandPalette = useCommandPaletteStore((s) => s.open);
  const viewMode = useUiStore((s) => s.viewMode);
  const setViewMode = useUiStore((s) => s.setViewMode);
  const focusPane = useUiStore((s) => s.focusPane);
  const returnToFleet = useUiStore((s) => s.returnToFleet);
  const toggleZenMode = useUiStore((s) => s.toggleZenMode);
  const zenMode = useUiStore((s) => s.zenMode);
  const selectedPaneId = usePaneStore((s) => s.selectedPaneId);
  const electronSettings = useElectronSettingsStore((s) => s.settings);
  const kanbanBoardEnabled = isKanbanBoardEnabled(electronSettings);
  const paneSummaryEnabled = isPaneSummaryEnabled(electronSettings);

  const handleFocus = () => {
    const target = selectedPaneId ?? firstPaneId;
    if (target) focusPane(target);
  };

  return (
    <div
      data-testid="resource-bar"
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-6 py-2 text-xs text-[var(--text-secondary)] bg-[var(--chrome)] border-b border-[var(--divider)] [-webkit-app-region:drag] max-[680px]:px-2.5"
    >
      <div className={STATS_GROUP_CLASS} data-testid="resource-bar-stats">
        <span className={NO_DRAG_CLASS}>{stats.total} pane{stats.total !== 1 ? 's' : ''}</span>
        <span className={cn('text-[var(--border)]', NO_DRAG_CLASS)}>|</span>
        <span className={NO_DRAG_CLASS}>{stats.worktrees} worktree{stats.worktrees !== 1 ? 's' : ''}</span>
        <span className={cn('text-[var(--border)]', NO_DRAG_CLASS)}>|</span>
        <span className={NO_DRAG_CLASS}>{stats.active} active</span>
      </div>
      <AttentionStat variant="stat" />

      <div className={cn('ml-auto flex shrink-0 items-center gap-2.5', NO_DRAG_CLASS)}>
        <div className="flex rounded border border-[var(--border)] overflow-hidden">
          <button
            onClick={returnToFleet}
            className={cn(
              'px-2.5 py-1 text-[10px] font-medium transition-colors',
              viewMode === 'fleet'
                ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-[var(--surface-raised)]',
            )}
          >
            Fleet
          </button>
          {kanbanBoardEnabled && (
            <button
              onClick={() => setViewMode('kanban')}
              className={cn(
                'px-2.5 py-1 text-[10px] font-medium transition-colors border-l border-[var(--border)] flex items-center gap-1.5',
                viewMode === 'kanban'
                  ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-[var(--surface-raised)]',
              )}
            >
              <span>Board</span>
              <span className="rounded border border-current px-1 py-0 text-[8px] uppercase tracking-wide opacity-80">
                Alpha
              </span>
            </button>
          )}
          {paneSummaryEnabled && (
            <button
              onClick={() => setViewMode('summary')}
              className={cn(
                'px-2.5 py-1 text-[10px] font-medium transition-colors border-l border-[var(--border)] flex items-center gap-1.5',
                viewMode === 'summary'
                  ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-[var(--surface-raised)]',
              )}
            >
              <span>Summary</span>
              <span className="rounded border border-current px-1 py-0 text-[8px] uppercase tracking-wide opacity-80">
                Alpha
              </span>
            </button>
          )}
          <button
            onClick={handleFocus}
            disabled={stats.total === 0}
            className={cn(
              'px-2.5 py-1 text-[10px] font-medium transition-colors border-l border-[var(--border)]',
              viewMode === 'focus'
                ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-[var(--surface-raised)]',
              stats.total === 0 && 'opacity-50 cursor-not-allowed',
            )}
          >
            Focus
          </button>
        </div>

        <span aria-hidden="true" className="h-4 w-px shrink-0 bg-[var(--divider)]" />

        <HoverTooltip label={COMMAND_PALETTE_LABEL} align="center">
          <button
            type="button"
            onClick={openCommandPalette}
            data-testid="resource-command-palette"
            aria-label={COMMAND_PALETTE_LABEL}
            className={cn(
              HEADER_ICON_BUTTON_CLASS,
              'w-auto min-w-[22px] px-1.5 text-[10px] font-medium',
              'text-[var(--text-secondary)] hover:bg-[var(--surface-raised)] hover:text-[var(--accent)]',
              QUIET_FOCUS_RING_CLASS,
            )}
          >
            ⌘K
          </button>
        </HoverTooltip>

        <HoverTooltip label="Zen mode (⌘⌥Z)" align="center">
          <button
            type="button"
            onClick={toggleZenMode}
            data-testid="resource-zen-toggle"
            aria-label="Toggle Zen mode"
            aria-pressed={zenMode}
            className={cn(
              HEADER_ICON_BUTTON_CLASS,
              QUIET_FOCUS_RING_CLASS,
              zenMode
                ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--surface-raised)] hover:text-[var(--accent)]',
            )}
          >
            <Shrink size={14} />
          </button>
        </HoverTooltip>

        <span aria-hidden="true" className="h-4 w-px shrink-0 bg-[var(--divider)]" />

        <NewPaneSplitButton />
      </div>
    </div>
  );
}
