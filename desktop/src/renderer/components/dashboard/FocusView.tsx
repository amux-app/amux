import type { AgentName, AumxPane } from 'aumx/core';
import type { PaneActivityState } from '../../../shared/pane-activity';
import { ArrowLeft, Pencil, SendHorizontal, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { agentHasSessionParsing } from '../../../shared/agent-session-types';
import { useAgentSessionHydration } from '../../hooks/useAgentSessionHydration';
import { useFileTabHandlers } from '../../hooks/useFileTabHandlers';
import { usePaneActions } from '../../hooks/usePaneActions';
import { usePaneEffectiveStatus } from '../../hooks/usePaneEffectiveStatus';
import { useReviewControls } from '../../hooks/useReviewControls';
import { cn } from '../../lib/cn';
import { paneSidebarTopLineColor } from '../../lib/constants';
import { formatTokenCount } from '../../lib/formatters';
import {
  useActiveFileTabId,
  useAgentSessionStore,
  useFileTabsForScope,
  usePaneById,
  usePaneActivityStore,
  usePaneStore,
  useUiStore,
  type FileTab,
} from '../../stores';
import { useWorktreeStatusStore } from '../../stores/worktree-status.store';
import { ActivityErrorBoundary } from '../agent-devtools/ActivityErrorBoundary';
import {
  LazyAgentActivityPanel,
  LazyTokenUsageDashboard,
} from '../agent-devtools/LazyAgentDevtools';
import { LazyFileViewer } from '../file-browser/LazyFileViewer';
import { InteractiveTerminal } from '../pane-detail/InteractiveTerminal';
import { LazyGitDiffView } from '../pane-detail/LazyGitDiffView';
import { WorktreeTab } from '../pane-detail/WorktreeTab';
import { Badge } from '../shared/Badge';
import { EmptyState } from '../shared/EmptyState';
import { HoverTooltip } from '../shared/HoverTooltip';
import { StatusDot } from '../shared/StatusDot';
import {
  activateTab,
  FileTabsStrip,
  handleTablistNavigation,
  InlineDiffStats,
  type TabActionResult,
} from './PaneCellTabs';
import { PANE_TAB_ICONS } from './PaneTabIcons';
import { ReviewLaunchButton } from './ReviewLaunchButton';
import { ReviewNavigationButton } from './ReviewNavigationButton';
import { SendFixesConfirmDialog } from './SendFixesConfirmDialog';

type FocusTab = 'diff' | 'activity' | 'tokens' | 'worktree';

const FOCUS_TABS: { id: FocusTab; label: string }[] = [
  { id: 'diff', label: 'Diff' },
  { id: 'activity', label: 'Activity' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'worktree', label: 'Worktree' },
];

export function FocusView() {
  const focusPaneId = useUiStore((s) => s.focusPaneId);
  const returnToFleet = useUiStore((s) => s.returnToFleet);
  const pane = usePaneById(focusPaneId);
  const [activeTab, setActiveTab] = useState<FocusTab>('activity');

  const selectedPaneId = usePaneStore((s) => s.selectedPaneId);
  const tabScopeId = pane?.id;
  const fileTabs = useFileTabsForScope(tabScopeId);
  const activeFileTabId = useActiveFileTabId(tabScopeId);
  const hasActiveFileTab = activeFileTabId !== null;
  const {
    closeActiveFileTab,
    handleFileTabClick,
    handleFileTabClose,
    handleFileTabCloseAll,
    handleFileTabCloseOthers,
    handleFileTabCloseToRight,
    setActiveFileTab,
  } = useFileTabHandlers(tabScopeId);

  const handleMetaTabChange = useCallback(async (tab: FocusTab): Promise<boolean> => {
    if (!tabScopeId || !hasActiveFileTab) {
      setActiveTab(tab);
      return true;
    }
    const changed = await setActiveFileTab(null);
    if (changed) setActiveTab(tab);
    return changed;
  }, [hasActiveFileTab, setActiveFileTab, tabScopeId]);

  useAgentSessionHydration(pane?.id, agentHasSessionParsing(pane?.agent));
  const justFinished = usePaneActivityStore((s) => (pane ? s.justFinishedPaneIds.has(pane.id) : false));
  const status = usePaneEffectiveStatus(pane);

  if (!pane) {
    return (
      <div className="flex items-center justify-center h-full">
        <EmptyState
          title="Pane not found"
          description="The focused pane no longer exists."
          action="Back to Fleet"
          onAction={returnToFleet}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <FocusHeader
        pane={pane}
        sidebarSelected={selectedPaneId === pane.id}
        status={status}
        justFinished={justFinished}
        onBack={returnToFleet}
      />
      <div className="flex-1 min-h-0">
        <Group orientation="horizontal">
          <Panel defaultSize={55} minSize={30}>
            <InteractiveTerminal pane={pane} />
          </Panel>
          <Separator className="aumx-resize-handle" data-testid="focus-terminal-activity-separator" />
          <Panel defaultSize={45} minSize={20}>
            <div className="flex flex-col h-full">
              <FocusTabBar
                activeFileTabId={activeFileTabId}
                activeTab={activeTab}
                fileTabs={fileTabs}
                onFileTabClick={handleFileTabClick}
                onFileTabClose={handleFileTabClose}
                onFileTabCloseAll={handleFileTabCloseAll}
                onFileTabCloseOthers={handleFileTabCloseOthers}
                onFileTabCloseToRight={handleFileTabCloseToRight}
                onTabChange={handleMetaTabChange}
                paneId={pane.id}
              />
              <div className="flex-1 min-h-0 overflow-hidden bg-[var(--bg)]">
                {hasActiveFileTab ? (
                  <div className="h-full bg-[var(--surface)]">
                    <LazyFileViewer onClose={() => void closeActiveFileTab()} />
                  </div>
                ) : (
                  <>
                    {activeTab === 'diff' && <LazyGitDiffView pane={pane} />}
                    {activeTab === 'activity' && <ActivityErrorBoundary><LazyAgentActivityPanel paneId={pane.id} /></ActivityErrorBoundary>}
                    {activeTab === 'tokens' && <LazyTokenUsageDashboard paneId={pane.id} />}
                    {activeTab === 'worktree' && <WorktreeTab pane={pane} />}
                  </>
                )}
              </div>
            </div>
          </Panel>
        </Group>
      </div>
    </div>
  );
}

function FocusHeader({
  pane,
  sidebarSelected,
  status,
  justFinished,
  onBack,
}: {
  pane: AumxPane;
  sidebarSelected: boolean;
  status: PaneActivityState;
  justFinished: boolean;
  onBack: () => void;
}) {
  const session = useAgentSessionStore((s) => s.sessions[pane.id]);
  const { renamePane } = usePaneActions();
  const totalTokens = session?.metrics.totalTokens ?? 0;
  const paneLabel = pane.title || session?.title || pane.slug || pane.id;
  const isReviewPane = pane.role === 'review';
  const agentKey = pane.agent?.toLowerCase() ?? '';
  const topLineColor = paneSidebarTopLineColor(agentKey, sidebarSelected);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [sendFixesDialogOpen, setSendFixesDialogOpen] = useState(false);
  const {
    canReview,
    canSendFixes,
    isReviewSourceMissing,
    openReviewPaneId,
    reviewSourcePaneId,
    showHandedOffPill,
  } = useReviewControls(pane, status);
  const completionLabel = isReviewPane ? 'Review complete' : 'Ready for review';

  const startRename = () => {
    setRenameValue(paneLabel);
    setRenaming(true);
  };

  const commitRename = () => {
    const next = renameValue.trim();
    if (next && next !== paneLabel) {
      renamePane(pane.id, next);
    }
    setRenaming(false);
  };

  return (
    <div
      className={cn(
        'group/header flex items-center gap-3 border-b border-[var(--border)] border-t-2 px-4 py-2',
        !sidebarSelected && 'border-t-transparent',
      )}
      style={topLineColor ? { borderTopColor: topLineColor } : undefined}
    >
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
      >
        <ArrowLeft size={14} />
        <span>Fleet</span>
      </button>
      <span className="text-[var(--border)]">|</span>
      {pane.agent && <Badge label={pane.agent} />}
      <StatusDot status={status} ready={justFinished} readyLabel={completionLabel} size="sm" />
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
          className="flex-1 min-w-0 max-w-xs bg-[var(--surface)] border border-[var(--border)] rounded px-1.5 py-0.5 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
        />
      ) : (
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-[var(--text)]">
          <span className="truncate">{paneLabel}</span>
          <button
            type="button"
            onClick={startRename}
            className="opacity-0 group-hover/header:opacity-100 shrink-0 text-[var(--text-muted)] hover:text-[var(--accent)] transition-opacity"
            aria-label={`Rename ${paneLabel}`}
          >
            <Pencil size={12} />
          </button>
        </span>
      )}
      {isReviewPane && pane.review && (
        <ReviewNavigationButton
          direction="back"
          label={isReviewSourceMissing ? 'Source closed' : `Back to ${pane.review.sourceSlug}`}
          targetPaneId={reviewSourcePaneId}
        />
      )}
      <div className="ml-auto flex items-center gap-1 shrink-0">
        {openReviewPaneId && (
          <ReviewNavigationButton direction="forward" label="Open review" targetPaneId={openReviewPaneId} />
        )}
        {canReview && <ReviewLaunchButton paneId={pane.id} defaultAgent={pane.agent as AgentName | undefined} highlight={justFinished} />}
        {canSendFixes && (
          <HoverTooltip label="Review findings before sending to the author" className="flex shrink-0 items-center">
            <button
              onClick={() => setSendFixesDialogOpen(true)}
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
          <span className="text-[10px] text-[var(--text-muted)] shrink-0">Fixes sent</span>
        )}
        {totalTokens > 0 && (
          <span className="text-[10px] text-[var(--text-muted)]">
            {formatTokenCount(totalTokens)} tokens
          </span>
        )}
        <HoverTooltip label="Exit pane" align="end">
          <button
            type="button"
            onClick={onBack}
            aria-label="Exit pane"
            className="shrink-0 rounded p-1 text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--surface-raised)] transition-colors"
          >
            <X size={14} />
          </button>
        </HoverTooltip>
      </div>
    </div>
  );
}

interface FocusTabBarProps {
  activeFileTabId: string | null;
  activeTab: FocusTab;
  fileTabs: readonly FileTab[];
  onFileTabClick: (tab: FileTab) => TabActionResult;
  onFileTabClose: (tab: FileTab) => TabActionResult;
  onFileTabCloseAll: () => TabActionResult;
  onFileTabCloseOthers: (tab: FileTab) => TabActionResult;
  onFileTabCloseToRight: (tab: FileTab) => TabActionResult;
  onTabChange: (t: FocusTab) => TabActionResult;
  paneId: string;
}

function FocusTabBar({
  activeFileTabId,
  activeTab,
  fileTabs,
  onFileTabClick,
  onFileTabClose,
  onFileTabCloseAll,
  onFileTabCloseOthers,
  onFileTabCloseToRight,
  onTabChange,
  paneId,
}: FocusTabBarProps) {
  const status = useWorktreeStatusStore((s) => s.statuses[paneId]);
  const fileTabActive = activeFileTabId !== null;

  return (
    <div className="flex items-center border-b border-[var(--border)]" role="tablist">
      <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
        {FOCUS_TABS.map((tab) => (
          <FocusTabButton
            key={tab.id}
            active={!fileTabActive && activeTab === tab.id}
            deletions={status?.deletions ?? 0}
            insertions={status?.insertions ?? 0}
            onTabChange={onTabChange}
            tab={tab}
          />
        ))}

        <FileTabsStrip
          activeId={activeFileTabId}
          onClick={onFileTabClick}
          onClose={onFileTabClose}
          onCloseAll={onFileTabCloseAll}
          onCloseOthers={onFileTabCloseOthers}
          onCloseToRight={onFileTabCloseToRight}
          tabs={fileTabs}
        />
      </div>
    </div>
  );
}

function FocusTabButton({
  active,
  deletions,
  insertions,
  onTabChange,
  tab,
}: {
  active: boolean;
  deletions: number;
  insertions: number;
  onTabChange: (t: FocusTab) => TabActionResult;
  tab: { id: FocusTab; label: string };
}) {
  const Icon = PANE_TAB_ICONS[tab.id];

  return (
    <button
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={(event) => activateTab(event, () => onTabChange(tab.id))}
      onKeyDown={handleTablistNavigation}
      className={cn(
        'shrink-0 px-3 py-1.5 text-[11px] font-medium transition-colors relative',
        active
          ? 'text-[var(--text)]'
          : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
      )}
    >
      <span className="flex items-center gap-1.5">
        <Icon size={12} />
        {tab.label}
        {tab.id === 'worktree' && <InlineDiffStats insertions={insertions} deletions={deletions} />}
      </span>
      {active && (
        <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[var(--accent)]" />
      )}
    </button>
  );
}
