import { lazy, Suspense, useCallback, useEffect } from 'react';
import { useProviderStatus } from '../../hooks/useProviderStatus';
import { useAgentHealth } from '../../hooks/useAgentHealth';
import { useWorktreeStatus } from '../../hooks/useWorktreeStatus';
import { getDashboardViewMode, isKanbanBoardEnabled, isPaneSummaryEnabled } from '../../lib/feature-flags';
import { useElectronSettingsStore, usePaneStore, useProjectStore, useUiStore } from '../../stores';
import { useWorktreeOverviewStore } from '../../stores/worktree-overview.store';
import { ConflictResolutionView } from '../conflict-resolution/ConflictResolutionView';
import { Spinner } from '../shared/Spinner';
import { WorktreeOverviewModal } from '../worktree/WorktreeOverviewModal';
import { DuelView } from './DuelView';
import { FocusView } from './FocusView';
import { PaneSummaryView } from './PaneSummaryView';
import { PaneTerminalGrid } from './PaneTerminalGrid';
import { ResourceBar } from './ResourceBar';
import { StatusBar } from './StatusBar';

const KanbanBoard = lazy(async () => {
  const module = await import('../kanban/KanbanBoard');
  return { default: module.KanbanBoard };
});

export function DashboardView() {
  const loaded = usePaneStore((s) => s.loaded);
  const panes = usePaneStore((s) => s.panes);
  const selectPane = usePaneStore((s) => s.selectPane);
  const viewMode = useUiStore((s) => s.viewMode);
  const focusPane = useUiStore((s) => s.focusPane);
  const returnToFleet = useUiStore((s) => s.returnToFleet);
  const zenMode = useUiStore((s) => s.zenMode);
  const projectSwitching = useProjectStore((s) => s.projectSwitching);
  const electronSettings = useElectronSettingsStore((s) => s.settings);
  const showWorktreeModal = useWorktreeOverviewStore((s) => s.isOpen);
  const closeWorktreeModal = useWorktreeOverviewStore((s) => s.close);
  const boardEnabled = isKanbanBoardEnabled(electronSettings);
  const summaryEnabled = isPaneSummaryEnabled(electronSettings);
  const effectiveViewMode = getDashboardViewMode(viewMode, electronSettings);

  useWorktreeStatus(panes);
  useProviderStatus();
  useAgentHealth();

  useEffect(() => {
    if (viewMode === 'kanban' && !boardEnabled) {
      returnToFleet();
    }
    if (viewMode === 'summary' && !summaryEnabled) {
      returnToFleet();
    }
  }, [boardEnabled, summaryEnabled, returnToFleet, viewMode]);

  const handleWorktreeJumpToPane = useCallback((paneId: string) => {
    selectPane(paneId);
    if (effectiveViewMode === 'focus') {
      focusPane(paneId);
    }
  }, [effectiveViewMode, focusPane, selectPane]);

  if (!loaded || projectSwitching) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <Spinner size="lg" />
        {projectSwitching && (
          <span className="text-xs text-[var(--text-muted)]">Opening project...</span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {!zenMode && <ResourceBar />}
      <div className="flex-1 overflow-hidden min-h-0">
        {effectiveViewMode === 'fleet' && <PaneTerminalGrid />}
        {effectiveViewMode === 'focus' && <FocusView />}
        {effectiveViewMode === 'duel' && <DuelView />}
        {effectiveViewMode === 'kanban' && (
          <Suspense fallback={<DashboardLoading label="Loading board" />}>
            <KanbanBoard />
          </Suspense>
        )}
        {effectiveViewMode === 'summary' && <PaneSummaryView />}
        {effectiveViewMode === 'conflict-resolution' && <ConflictResolutionView />}
      </div>
      <StatusBar />
      {effectiveViewMode !== 'kanban' && showWorktreeModal && (
        <WorktreeOverviewModal
          onClose={closeWorktreeModal}
          onJumpToPane={handleWorktreeJumpToPane}
        />
      )}
    </div>
  );
}

function DashboardLoading({ label }: { label: string }) {
  return (
    <div
      aria-label={label}
      className="flex h-full items-center justify-center"
      role="status"
    >
      <Spinner size="lg" />
    </div>
  );
}
