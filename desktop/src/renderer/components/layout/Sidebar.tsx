import { CircleHelp } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { usePaneActions } from '../../hooks/usePaneActions';
import { useSidebarCollapsed } from '../../hooks/useSidebarCollapsed';
import { useSidebarSession } from '../../hooks/useSidebarSession';
import { cn } from '../../lib/cn';
import { isConversationTopicsEnabled } from '../../lib/feature-flags';
import { useElectronSettingsStore, useFileBrowserStore, useHiddenPanesStore, useNotificationStore, usePaneStore, useProjectStore, useUiStore, useWorkspacePickerStore } from '../../stores';
import { HoverTooltip } from '../shared/HoverTooltip';
import { ProjectSwitcher } from './ProjectSwitcher';
import { SidebarAgentList } from './SidebarAgentList';
import { SidebarMarketplaceSection } from './SidebarMarketplaceSection';
import { SidebarNavList } from './SidebarNavList';
import { SIDEBAR_LIVE_WIDTH_VALUE, SIDEBAR_TOOLTIP_DELAY_MS } from './sidebarLayout';
import { SIDEBAR_ICON_STROKE, SIDEBAR_TOOL_CLASS } from './SidebarRow';
import { SidebarSectionLabel } from './SidebarSectionLabel';
import {
  createSidebarActionContext,
  resolveSidebarActions,
  MARKETPLACE_ACTION_ID,
  SETTINGS_ACTION_ID,
} from './sidebarActions';

const HELP_ICON_SIZE = 17;

/** Inset by the row padding so the wordmark sits on the nav rows' icon column. */
const IDENTITY_WORDMARK_CLASS =
  'px-[8px] text-[15px] leading-[20px] tracking-[-0.01em] text-[var(--sidebar-text)] [font-weight:650]';

interface SidebarProps {
  /** Zen peek renders the sidebar over the content, so it ignores the collapse preference. */
  forceExpanded?: boolean;
}

export function Sidebar({ forceExpanded = false }: Readonly<SidebarProps>) {
  const { closePane, createPane, renamePane } = usePaneActions();
  const panes = usePaneStore((s) => s.panes);
  const panesLoaded = usePaneStore((s) => s.loaded);
  const selectedPaneId = usePaneStore((s) => s.selectedPaneId);
  const selectPane = usePaneStore((s) => s.selectPane);
  const setCreating = usePaneStore((s) => s.setCreating);
  const projects = useProjectStore((s) => s.projects);
  const activeProject = useProjectStore((s) => s.activeProject);
  const projectSwitching = useProjectStore((s) => s.projectSwitching);
  const switchProject = useProjectStore((s) => s.switchProject);
  const addToast = useNotificationStore((s) => s.addToast);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const openSettings = useUiStore((s) => s.openSettings);
  const settingsCategory = useUiStore((s) => s.settingsCategory);
  const activeView = useUiStore((s) => s.activeView);
  const sidebarCollapsed = useSidebarCollapsed();
  const collapsed = !forceExpanded && sidebarCollapsed;
  const focusPane = useUiStore((s) => s.focusPane);
  const viewMode = useUiStore((s) => s.viewMode);
  const hiddenPaneIds = useHiddenPanesStore((s) => s.hiddenPaneIds);
  const electronSettings = useElectronSettingsStore((s) => s.settings);
  const conversationTopicsEnabled = isConversationTopicsEnabled(electronSettings);
  const unhidePane = useHiddenPanesStore((s) => s.unhidePane);
  const fileBrowserOpen = useFileBrowserStore((s) => s.isOpen);
  const toggleFileBrowser = useFileBrowserStore((s) => s.toggle);
  const toggleHelpOverlay = useUiStore((s) => s.toggleHelpOverlay);
  const openWorkspacePicker = useWorkspacePickerStore((s) => s.open);

  const { statusOf, titleOf, waitingCount } = useSidebarSession(panes);

  const { agentCount, terminalCount } = useMemo(() => {
    const shells = panes.filter((p) => p.type === 'shell').length;
    return { agentCount: panes.length - shells, terminalCount: shells };
  }, [panes]);

  const agentsHydrating = !panesLoaded || projectSwitching;

  const handleCreateFirst = useCallback(() => {
    setCreating(true);
  }, [setCreating]);
  const handleCreateShell = useCallback(() => {
    void createPane({ prompt: '', type: 'shell' });
  }, [createPane]);
  const handlePaneSelect = useCallback(
    (paneId: string) => {
      if (hiddenPaneIds.has(paneId)) {
        unhidePane(paneId);
      }
      selectPane(paneId);
      if (activeView !== 'dashboard') {
        setActiveView('dashboard');
      }
      if (viewMode === 'focus') {
        focusPane(paneId);
      }
    },
    [activeView, focusPane, hiddenPaneIds, selectPane, setActiveView, unhidePane, viewMode],
  );
  const handleProjectSelect = useCallback(async (projectRoot: string) => {
    try {
      await switchProject(projectRoot);
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Failed to switch projects', 'error');
    }
  }, [addToast, switchProject]);
  const sidebarActions = resolveSidebarActions(createSidebarActionContext({
    activeView,
    conversationTopicsEnabled,
    createShellPane: handleCreateShell,
    fileBrowserOpen,
    openSettings,
    openWorkspacePicker,
    settingsCategory,
    setActiveView,
    toggleFileBrowser,
  }));
  const navActions = sidebarActions.filter(
    (action) => action.id !== SETTINGS_ACTION_ID && action.id !== MARKETPLACE_ACTION_ID,
  );
  const settingsAction = sidebarActions.find((action) => action.id === SETTINGS_ACTION_ID);

  return (
    <aside
      aria-hidden={collapsed}
      data-sidebar-mode={collapsed ? 'collapsed' : 'expanded'}
      data-testid="app-shell-sidebar"
      inert={collapsed}
      className="flex h-full w-full flex-col overflow-hidden bg-[var(--sidebar-bg)]"
    >
      {/* Inner surface pinned to the live column width: the collapse clips it
          instead of reflowing every row, and a drag reflows it live. */}
      <div className="flex min-h-0 flex-1 flex-col" style={{ width: SIDEBAR_LIVE_WIDTH_VALUE }}>
        <div className="flex shrink-0 flex-col px-[8px] pt-[6px] pb-[8px]">
          <h1 className={IDENTITY_WORDMARK_CLASS}>MuxBase</h1>
          <div className="flex min-w-0">
            <ProjectSwitcher
              activeProject={activeProject}
              onSelect={handleProjectSelect}
              projects={projects}
            />
          </div>
        </div>

        <SidebarNavList actions={navActions} />

        <div className="shrink-0 px-[8px] pb-[6px]">
          <SidebarMarketplaceSection />
        </div>

        <div className="sidebar-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-[8px] pb-[10px]">
          <SidebarSectionLabel
            agentCount={agentCount}
            hydrating={agentsHydrating}
            onCreate={handleCreateFirst}
            terminalCount={terminalCount}
            waitingCount={waitingCount}
          />

          <SidebarAgentList
            activeProject={activeProject}
            hiddenPaneIds={hiddenPaneIds}
            hydrating={agentsHydrating}
            onCreateFirst={handleCreateFirst}
            onDelete={closePane}
            onRename={renamePane}
            onSelect={handlePaneSelect}
            panes={panes}
            selectedPaneId={selectedPaneId}
            statusOf={statusOf}
            titleOf={titleOf}
          />
        </div>

        <div className="flex shrink-0 items-center gap-[6px] border-t border-[var(--sidebar-hairline)] px-[8px] pt-[6px] pb-[8px]">
          {settingsAction && (
            <HoverTooltip label={settingsAction.title} openDelayMs={SIDEBAR_TOOLTIP_DELAY_MS}>
              <button
                type="button"
                onClick={settingsAction.onSelect}
                aria-label={settingsAction.title}
                aria-current={settingsAction.active ? 'page' : undefined}
                data-testid={settingsAction.testId}
                className={cn(SIDEBAR_TOOL_CLASS, 'h-[28px] w-[28px] rounded-[8px]')}
              >
                <settingsAction.Icon size={HELP_ICON_SIZE} strokeWidth={SIDEBAR_ICON_STROKE} />
              </button>
            </HoverTooltip>
          )}
          <HoverTooltip label="Help" openDelayMs={SIDEBAR_TOOLTIP_DELAY_MS}>
            <button
              type="button"
              onClick={toggleHelpOverlay}
              aria-label="Help"
              className={cn(SIDEBAR_TOOL_CLASS, 'h-[28px] w-[28px] rounded-[8px]')}
            >
              <CircleHelp size={HELP_ICON_SIZE} strokeWidth={SIDEBAR_ICON_STROKE} />
            </button>
          </HoverTooltip>
        </div>
      </div>
    </aside>
  );
}
