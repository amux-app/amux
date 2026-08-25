import type { MuxBasePane, DuelMetadata } from 'muxbase/core';
import { Maximize2, Minus, Pencil, SendHorizontal, X } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { agentHasSessionParsing } from '../../../shared/agent-session-types';
import { TERMINAL_BACKGROUND_COLORS } from '../../../shared/app-colors';
import type { PaneActivityState } from '../../../shared/pane-activity';
import { useAgentSessionHydration } from '../../hooks/useAgentSessionHydration';
import { useTerminalThemeMode } from '../../hooks/useAppThemeMode';
import { useFileTabHandlers } from '../../hooks/useFileTabHandlers';
import { usePaneActions } from '../../hooks/usePaneActions';
import { useReviewControls } from '../../hooks/useReviewControls';
import { cn } from '../../lib/cn';
import { HEADER_ICON_BUTTON_CLASS, paneSidebarTopLineColor } from '../../lib/constants';
import { firstSegments } from '../../lib/displayLabel';
import { getEffectivePaneStatus } from '../../lib/pane-attention';
import { resolvePaneProjectDisplay } from '../../lib/pane-project-display';
import {
  useActiveFileTabId,
  useAgentSessionStore,
  useFileTabsForScope,
  useHiddenPanesStore,
  usePaneActivityStore,
  usePaneStore,
  useUiStore,
} from '../../stores';
import { useProjectStore } from '../../stores/project.store';
import { ActivityErrorBoundary } from '../agent-devtools/ActivityErrorBoundary';
import { AgentSummaryPanel } from '../agent-devtools/AgentSummaryPanel';
import {
  LazyAgentActivityPanel,
  LazyTokenUsageDashboard,
} from '../agent-devtools/LazyAgentDevtools';
import { LazyFileViewer } from '../file-browser/LazyFileViewer';
import { InteractiveTerminal } from '../pane-detail/InteractiveTerminal';
import { LazyGitDiffView } from '../pane-detail/LazyGitDiffView';
import { WorktreeTab } from '../pane-detail/WorktreeTab';
import { Badge } from '../shared/Badge';
import { HoverTooltip } from '../shared/HoverTooltip';
import { StatusDot } from '../shared/StatusDot';
import { TabPanelSurface } from '../shared/TabPanelSurface';
import { AgentBrandIcon, hasIcon } from '../shared/agent-brand-icons';
import { CellTabBar, TerminalPeek, type PaneCellTab } from './PaneCellTabs';
import { PaneActionsMenu } from './PaneActionsMenu';
import { PANE_TAB_ICONS } from './PaneTabIcons';
import { ReviewLaunchButton } from './ReviewLaunchButton';
import { ReviewNavigationButton } from './ReviewNavigationButton';
import { SendFixesConfirmDialog } from './SendFixesConfirmDialog';

interface PaneCellProps {
  pane: MuxBasePane;
  viewportVisible?: boolean;
}

const STATUS_LABEL: Record<PaneActivityState, string> = {
  working: 'Working',
  waiting: 'Waiting for input',
  idle: 'Idle',
  starting: 'Starting',
  stopped: 'Stopped',
  unknown: 'Unknown',
};

const ZEN_HEADER_BUTTON_CLASS = cn(
  HEADER_ICON_BUTTON_CLASS,
  'text-[var(--text-secondary)] hover:bg-[var(--surface-raised)] hover:text-[var(--accent)]',
);

const ZEN_HEADER_CLOSE_BUTTON_CLASS = cn(
  HEADER_ICON_BUTTON_CLASS,
  'text-[var(--text-secondary)] hover:bg-[var(--surface-raised)] hover:text-[var(--error)]',
);

// Always mounted and out of flow: turning waiting on must never move the cell.
const ATTENTION_EDGE_CLASS = 'pointer-events-none absolute inset-y-0 left-0 z-30 w-0.5';
const ATTENTION_WORD_CLASS = 'hidden @min-[360px]/panecell:inline shrink-0 text-[11px] font-medium text-[var(--attention-waiting-text)]';

function PaneCellInner({ pane, viewportVisible = true }: PaneCellProps) {
  const [activeTab, setActiveTab] = useState<PaneCellTab>('terminal');
  const selectedPaneId = usePaneStore((s) => s.selectedPaneId);
  const selectPane = usePaneStore((s) => s.selectPane);
  const justFinished = usePaneActivityStore((s) => s.justFinishedPaneIds.has(pane.id));
  const activity = usePaneActivityStore((state) => state.activityByPaneId[pane.id]);
  const activityState = activity?.state;
  const awaitingUserInput = useAgentSessionStore((s) => s.sessions[pane.id]?.awaitingUserInput);
  const pendingUserQuestion = useAgentSessionStore((s) => s.sessions[pane.id]?.pendingUserQuestion);
  const status = getEffectivePaneStatus(pane, { awaitingUserInput }, activity);
  const waiting = status === 'waiting';
  const zenMode = useUiStore((s) => s.zenMode);
  const isSelected = selectedPaneId === pane.id;
  const terminalThemeMode = useTerminalThemeMode();
  useAgentSessionHydration(pane.id, agentHasSessionParsing(pane.agent));

  const tabScopeId = pane.id;
  const fileTabs = useFileTabsForScope(tabScopeId);
  const activeFileTabId = useActiveFileTabId(tabScopeId);
  const hasActiveFileTab = activeFileTabId !== null;
  const terminalVisible = viewportVisible && !hasActiveFileTab && activeTab === 'terminal';
  const {
    closeActiveFileTab,
    handleFileTabClick,
    handleFileTabClose,
    handleFileTabCloseAll,
    handleFileTabCloseOthers,
    handleFileTabCloseToRight,
    setActiveFileTab,
  } = useFileTabHandlers(tabScopeId);

  const handleMetaTabChange = useCallback(async (tab: PaneCellTab): Promise<boolean> => {
    if (!hasActiveFileTab) {
      setActiveTab(tab);
      return true;
    }
    const changed = await setActiveFileTab(null);
    if (changed) setActiveTab(tab);
    return changed;
  }, [hasActiveFileTab, setActiveFileTab]);

  const handleJumpToTerminal = useCallback(() => {
    void setActiveFileTab(null).then((changed) => {
      if (changed) setActiveTab('terminal');
    });
  }, [setActiveFileTab]);

  useEffect(() => {
    if (!isSelected || !hasActiveFileTab) return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 'w') {
        e.preventDefault();
        void closeActiveFileTab();
      } else if (e.key === '`') {
        e.preventDefault();
        void setActiveFileTab(null).then((changed) => {
          if (changed) setActiveTab('terminal');
        });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [closeActiveFileTab, hasActiveFileTab, isSelected, setActiveFileTab]);

  return (
    <div
      data-pane-id={pane.id}
      data-pane-slug={pane.slug}
      data-testid="pane-cell"
      className="@container/panecell relative flex h-full min-h-0 min-w-0 w-full flex-col bg-[var(--surface)]"
      onClick={() => selectPane(pane.id)}
    >
      <span
        aria-hidden
        className={cn(ATTENTION_EDGE_CLASS, waiting ? 'bg-[var(--attention-waiting-edge)]' : 'bg-transparent')}
        data-testid="pane-attention-edge"
      />

      {zenMode
        ? <ZenCellHeader pane={pane} status={status} activityState={activityState} waiting={waiting} activeTab={activeTab} onTabChange={handleMetaTabChange} />
        : <CellHeader pane={pane} status={status} activityState={activityState} waiting={waiting} sidebarSelected={isSelected} justFinished={justFinished} />}

      {waiting && pendingUserQuestion && (
        <div className="px-3 py-2 border-b border-[var(--border)] bg-[var(--agent-waiting)]/5">
          <p className="text-[11px] text-[var(--text-secondary)]">{pendingUserQuestion}</p>
        </div>
      )}

      {!zenMode && (
        <CellTabBar
          activeTab={activeTab}
          onTabChange={handleMetaTabChange}
          paneId={pane.id}
          agent={pane.agent}
          hasWorktree={!!pane.worktreePath}
          fileTabs={{
            tabs: fileTabs,
            activeId: activeFileTabId,
            onClick: handleFileTabClick,
            onClose: handleFileTabClose,
            onCloseAll: handleFileTabCloseAll,
            onCloseOthers: handleFileTabCloseOthers,
            onCloseToRight: handleFileTabCloseToRight,
          }}
        />
      )}

      <div
        className="relative flex-1 min-h-0 overflow-hidden"
        style={{ backgroundColor: TERMINAL_BACKGROUND_COLORS[terminalThemeMode] }}
      >
        <div
          aria-hidden={!terminalVisible}
          className={cn(
            'absolute inset-0',
            terminalVisible ? 'visible z-10' : 'invisible pointer-events-none z-0',
          )}
        >
          <InteractiveTerminal pane={pane} terminalVisible={terminalVisible} />
        </div>

        {hasActiveFileTab ? (
          <div className="relative z-20 flex h-full min-h-0 flex-col">
            <div className="flex-1 min-h-0 bg-[var(--surface)]">
              <LazyFileViewer onClose={() => void closeActiveFileTab()} />
            </div>
            <TerminalPeek pane={pane} status={status} onJumpToTerminal={handleJumpToTerminal} />
          </div>
        ) : (
          <>
            {activeTab === 'diff' && (
              <TabPanelSurface>
                <LazyGitDiffView pane={pane} />
              </TabPanelSurface>
            )}
            {activeTab === 'activity' && (
              <TabPanelSurface>
                <ActivityErrorBoundary>
                  <LazyAgentActivityPanel paneId={pane.id} />
                </ActivityErrorBoundary>
              </TabPanelSurface>
            )}
            {activeTab === 'summary' && (
              <TabPanelSurface>
                <ActivityErrorBoundary>
                  <AgentSummaryPanel
                    paneId={pane.id}
                    onJumpToActivity={() => setActiveTab('activity')}
                  />
                </ActivityErrorBoundary>
              </TabPanelSurface>
            )}
            {activeTab === 'tokens' && (
              <TabPanelSurface>
                <LazyTokenUsageDashboard paneId={pane.id} />
              </TabPanelSurface>
            )}
            {activeTab === 'worktree' && (
              <TabPanelSurface>
                <WorktreeTab pane={pane} />
              </TabPanelSurface>
            )}
          </>
        )}
      </div>

    </div>
  );
}

export const PaneCell = memo(PaneCellInner);

function renderAgentBadge(agent: MuxBasePane['agent']) {
  if (!agent) return null;
  if (hasIcon(agent)) {
    return (
      <HoverTooltip label={agent} align="center" className="ml-auto inline-flex">
        <span className="shrink-0 text-[var(--text-secondary)] opacity-70">
          <AgentBrandIcon agent={agent} size="sm" />
        </span>
      </HoverTooltip>
    );
  }
  return (
    <span className="ml-auto shrink-0 uppercase tracking-wide text-[9px] opacity-60">{agent}</span>
  );
}

function ZenCellHeader({
  pane,
  status,
  activityState,
  waiting,
  activeTab,
  onTabChange,
}: Readonly<{
  pane: MuxBasePane;
  status: PaneActivityState;
  activityState?: PaneActivityState;
  waiting: boolean;
  activeTab: PaneCellTab;
  onTabChange: (tab: PaneCellTab) => void;
}>) {
  const { renamePane, closePane } = usePaneActions();
  const focusPane = useUiStore((s) => s.focusPane);
  const hidePane = useHiddenPanesStore((s) => s.hidePane);
  const { canReview } = useReviewControls(pane, status);
  const onFocus = () => focusPane(pane.id);
  const onClose = () => closePane(pane.id);
  const onMinimize = () => hidePane(pane.id);
  const sessionTitle = useAgentSessionStore((s) => s.sessions[pane.id]?.title);
  const paneLabel = pane.title || sessionTitle || pane.slug || pane.id;
  const agentKey = pane.agent?.toLowerCase() ?? '';
  const topLineColor = paneSidebarTopLineColor(agentKey, false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  const startRename = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    setRenameValue(paneLabel);
    setRenaming(true);
  };

  const commitRename = () => {
    const next = renameValue.trim();
    if (next && next !== paneLabel) renamePane(pane.id, next);
    setRenaming(false);
  };

  const zenTabs: PaneCellTab[] = ['terminal', 'diff', 'activity', 'summary', 'tokens', 'worktree'];

  return (
    <div
      className="group/zen-header flex min-h-[26px] items-center gap-1.5 border-b border-[var(--divider)] px-2 py-0 bg-[var(--chrome)]/60 text-[10px] text-[var(--text-secondary)] leading-none"
      style={topLineColor ? { borderBottomColor: `${topLineColor}55` } : undefined}
    >
      <StatusDot status={waiting ? 'waiting' : activityState ?? status} size="sm" />

      {renaming ? (
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') setRenaming(false);
          }}
          onBlur={commitRename}
          onClick={(e) => e.stopPropagation()}
          className="min-w-0 max-w-[40%] bg-[var(--surface)] border border-[var(--border)] rounded px-1 py-0 text-[10px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
        />
      ) : (
        <span className="flex min-w-0 max-w-[40%] items-center gap-1">
          <span className="truncate text-[var(--text-secondary)]">{paneLabel}</span>
          <button
            type="button"
            onClick={startRename}
            aria-label={`Rename ${paneLabel}`}
            className="opacity-0 group-hover/zen-header:opacity-100 shrink-0 text-[var(--text-secondary)] hover:text-[var(--accent)] transition-opacity"
          >
            <Pencil size={10} />
          </button>
        </span>
      )}

      <span className="w-px h-3 bg-[var(--border)] mx-0.5 shrink-0" />

      <div className="flex items-center gap-0.5 shrink-0">
        {zenTabs.map((tabId) => {
          const Icon = PANE_TAB_ICONS[tabId];
          const isActive = activeTab === tabId;
          const rawLabel = tabId.charAt(0).toUpperCase() + tabId.slice(1);
          const label = tabId === 'terminal' && pane.agent ? 'Agent' : rawLabel;
          return (
            <HoverTooltip key={tabId} label={label} align="center">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onTabChange(tabId); }}
                aria-label={label}
                className={cn(
                  HEADER_ICON_BUTTON_CLASS,
                  isActive
                    ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-[var(--surface-raised)]',
                )}
              >
                <Icon size={12} />
              </button>
            </HoverTooltip>
          );
        })}
      </div>

      {renderAgentBadge(pane.agent)}

      {canReview && (
        <span className={pane.agent ? undefined : 'ml-auto inline-flex'}>
          <ReviewLaunchButton paneId={pane.id} defaultAgent={pane.agent} />
        </span>
      )}

      <HoverTooltip label="Focus pane" align="center" className={pane.agent || canReview ? undefined : 'ml-auto inline-flex'}>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onFocus(); }}
          aria-label="Focus pane"
          className={ZEN_HEADER_BUTTON_CLASS}
        >
          <Maximize2 size={12} />
        </button>
      </HoverTooltip>

      <HoverTooltip label="Minimize pane" align="center">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onMinimize(); }}
          aria-label="Minimize pane"
          className={ZEN_HEADER_BUTTON_CLASS}
        >
          <Minus size={12} />
        </button>
      </HoverTooltip>

      <HoverTooltip label="Close pane" align="end">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          aria-label="Close pane"
          className={ZEN_HEADER_CLOSE_BUTTON_CLASS}
        >
          <X size={12} />
        </button>
      </HoverTooltip>

      <PaneActionsMenu
        pane={pane}
        status={status}
        onRename={() => { setRenameValue(paneLabel); setRenaming(true); }}
      />
    </div>
  );
}

function CellHeader({
  pane,
  sidebarSelected,
  status,
  activityState,
  waiting,
  justFinished,
}: {
  pane: MuxBasePane;
  sidebarSelected: boolean;
  status: PaneActivityState;
  activityState?: PaneActivityState;
  waiting: boolean;
  justFinished: boolean;
}) {
  const { closePane, renamePane } = usePaneActions();
  const hidePane = useHiddenPanesStore((s) => s.hidePane);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [sendFixesDialogOpen, setSendFixesDialogOpen] = useState(false);
  const isReviewPane = pane.role === 'review';
  const {
    canReview,
    canSendFixes,
    isReviewSourceMissing,
    openReviewPaneId,
    reviewSourcePaneId,
    showHandedOffPill,
  } = useReviewControls(pane, status);
  const completionLabel = isReviewPane ? 'Review complete' : 'Ready for review';
  const dotStatus: PaneActivityState = waiting ? 'waiting' : activityState ?? status;
  const showReady = justFinished && !waiting;

  const handleRenameSubmit = () => {
    if (renameValue.trim() && renameValue !== (pane.title || pane.slug)) {
      renamePane(pane.id, renameValue.trim());
    }
    setRenaming(false);
  };

  const agentKey = pane.agent?.toLowerCase() ?? '';
  const topLineColor = paneSidebarTopLineColor(agentKey, sidebarSelected);
  const sessionTitle = useAgentSessionStore((s) => s.sessions[pane.id]?.title);
  const paneLabel = pane.title || sessionTitle || pane.slug || pane.id;

  return (
    <div
      className={cn(
        'group/header flex min-h-[32px] items-center gap-2 border-b border-[var(--divider)] border-t-2 px-3 py-1.5 bg-[var(--chrome)]',
        !sidebarSelected && 'border-t-transparent',
      )}
      style={topLineColor ? { borderTopColor: topLineColor } : undefined}
    >
      {pane.agent && <Badge label={pane.agent} className="shrink-0" />}
      {pane.duel && <DuelRoleChip duel={pane.duel} />}
      <HoverTooltip
        label={showReady ? completionLabel : STATUS_LABEL[dotStatus]}
        className="flex shrink-0 items-center"
      >
        <StatusDot status={dotStatus} ready={showReady} readyLabel={completionLabel} size="sm" />
      </HoverTooltip>
      {waiting && (
        <span className={ATTENTION_WORD_CLASS} data-testid="pane-attention-word">Waiting</span>
      )}
      {renaming ? (
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleRenameSubmit();
            if (e.key === 'Escape') setRenaming(false);
          }}
          onBlur={handleRenameSubmit}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 min-w-0 bg-[var(--surface)] border border-[var(--border)] rounded px-1.5 py-0.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
        />
      ) : (
        <span className="flex flex-1 min-w-0 items-center gap-1 text-xs font-medium text-[var(--text)]">
          <HoverTooltip label={paneLabel} className="truncate">
            {paneLabel}
          </HoverTooltip>
          <button
            onClick={(e) => { e.stopPropagation(); setRenameValue(pane.title || pane.slug); setRenaming(true); }}
            className="opacity-0 group-hover/header:opacity-100 transition-opacity text-[var(--text-secondary)] hover:text-[var(--accent)] shrink-0"
            aria-label="Rename pane"
          >
            <Pencil size={12} />
          </button>
        </span>
      )}
      {isReviewPane && pane.review && (
        <div className="flex shrink-0 items-center gap-0.5">
          <Badge label="Review" variant="outline" className="shrink-0 text-[var(--accent)]" />
          <ReviewNavigationButton
            direction="back"
            label={isReviewSourceMissing ? 'Source closed' : pane.review.sourceSlug}
            targetPaneId={reviewSourcePaneId}
          />
        </div>
      )}
      <div className="ml-auto flex items-center gap-1 shrink-0 min-w-0">
        {openReviewPaneId && (
          <ReviewNavigationButton direction="forward" label="Open review" targetPaneId={openReviewPaneId} />
        )}
        {canReview && <ReviewLaunchButton paneId={pane.id} defaultAgent={pane.agent} highlight={justFinished} />}
        {canSendFixes && (
          <HoverTooltip label="Review findings before sending to the author" className="flex shrink-0 items-center">
            <button
              onClick={(e) => { e.stopPropagation(); setSendFixesDialogOpen(true); }}
              className={cn(
                'flex min-h-6 items-center gap-1 rounded px-1.5 text-[11px] font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/20',
                justFinished && 'bg-[var(--accent)]/10 ring-1 ring-[var(--accent)]/40',
              )}
              aria-label="Open send fixes dialog"
              aria-haspopup="dialog"
            >
              <SendHorizontal size={13} />
              Send fixes
            </button>
          </HoverTooltip>
        )}
        {sendFixesDialogOpen && (
          <SendFixesConfirmDialog reviewPane={pane} onClose={() => setSendFixesDialogOpen(false)} />
        )}
        {showHandedOffPill && (
          <span className="text-[10px] text-[var(--text-secondary)] shrink-0">Fixes sent</span>
        )}
        <ProjectChip pane={pane} />
        <span className="hidden @min-[480px]/panecell:block w-px h-3.5 bg-[var(--border)] mx-0.5 shrink-0" />
        <ExpandButton paneId={pane.id} />
        <button
          onClick={(e) => { e.stopPropagation(); hidePane(pane.id); }}
          className="min-w-6 min-h-6 flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--accent)] rounded transition-colors hover:bg-[var(--surface-raised)]"
          aria-label="Minimize pane"
          title="Hide from fleet (click in sidebar to restore)"
        >
          <Minus size={14} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); closePane(pane.id); }}
          className="min-w-6 min-h-6 flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--error)] rounded transition-colors hover:bg-[var(--surface-raised)]"
          aria-label="Close pane"
        >
          <X size={14} />
        </button>
        <PaneActionsMenu
          pane={pane}
          status={status}
          onRename={() => { setRenameValue(pane.title || pane.slug); setRenaming(true); }}
        />
      </div>
    </div>
  );
}

function ProjectChip({ pane }: { pane: MuxBasePane }) {
  const activeProject = useProjectStore((s) => s.activeProject);
  const project = resolvePaneProjectDisplay(pane, activeProject);
  const [peeking, setPeeking] = useState(false);
  const peekTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(peekTimer.current), []);

  if (!project) return null;

  const { text: shortName, truncated } = firstSegments(project.name, 2);
  const showFull = peeking || !truncated;

  return (
    <button
      type="button"
      aria-label={project.name}
      onClick={(e) => {
        if (!truncated) return;
        e.stopPropagation();
        setPeeking(true);
        window.clearTimeout(peekTimer.current);
        peekTimer.current = window.setTimeout(() => setPeeking(false), 1600);
      }}
      className="hidden @min-[480px]/panecell:flex items-center gap-1.5 min-w-0 max-w-[220px] px-1.5 py-0.5 rounded-md border border-transparent hover:bg-[var(--surface-raised)] hover:border-[var(--border)] transition-colors"
    >
      <HoverTooltip label={project.name} enabled={truncated} className="min-w-0 truncate text-[11px] font-medium text-[var(--text)]">
        {showFull ? project.name : `${shortName}…`}
      </HoverTooltip>
    </button>
  );
}

function ExpandButton({ paneId }: { paneId: string }) {
  const viewMode = useUiStore((s) => s.viewMode);
  const focusPane = useUiStore((s) => s.focusPane);

  if (viewMode !== 'fleet') return null;

  return (
    <button
      onClick={(e) => { e.stopPropagation(); focusPane(paneId); }}
      className="min-w-6 min-h-6 flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--accent)] rounded transition-colors hover:bg-[var(--surface-raised)]"
      aria-label="Focus pane"
    >
      <Maximize2 size={13} />
    </button>
  );
}

const DUEL_ROLE_CHIP_CLASS: Record<'a' | 'b', string> = {
  a: 'bg-indigo-500/15 text-indigo-400 ring-1 ring-indigo-500/40',
  b: 'bg-teal-500/15 text-teal-400 ring-1 ring-teal-500/40',
};

function DuelRoleChip({ duel }: { duel: DuelMetadata }) {
  const siblingSlug = usePaneStore((s) => (
    duel.siblingPaneId ? s.panes.find((p) => p.id === duel.siblingPaneId)?.slug ?? null : null
  ));
  const tooltip = siblingSlug ? `Duel · vs ${siblingSlug}` : 'Duel';

  return (
    <HoverTooltip label={tooltip} className="flex shrink-0 items-center">
      <span
        className={cn(
          'inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold uppercase leading-none',
          DUEL_ROLE_CHIP_CLASS[duel.role],
        )}
      >
        {duel.role}
      </span>
    </HoverTooltip>
  );
}
