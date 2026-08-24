import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { AumxPane } from 'aumx/core';
import { agentHasSessionParsing } from '../../../shared/agent-session-types';
import { InteractiveTerminal } from '../pane-detail/InteractiveTerminal';
import {
  LazyAgentActivityPanel,
  LazyTokenUsageDashboard,
} from '../agent-devtools/LazyAgentDevtools';
import { WorktreeTab } from '../pane-detail/WorktreeTab';
import { LazyGitDiffView } from '../pane-detail/LazyGitDiffView';
import { StatusDot } from '../shared/StatusDot';
import { Badge } from '../shared/Badge';
import { TabPanelSurface } from '../shared/TabPanelSurface';
import { useUiStore } from '../../stores/ui.store';
import { useAgentSessionStore } from '../../stores/agent-session.store';
import { usePaneActions } from '../../hooks/usePaneActions';
import { useAgentSessionHydration } from '../../hooks/useAgentSessionHydration';
import { usePaneEffectiveStatus } from '../../hooks/usePaneEffectiveStatus';
import { cn } from '../../lib/cn';
import { formatTokenCount } from '../../lib/formatters';

type SidePanelTab = 'terminal' | 'activity' | 'diff' | 'tokens' | 'worktree';

const TABS: { id: SidePanelTab; label: string }[] = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'activity', label: 'Activity' },
  { id: 'diff', label: 'Diff' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'worktree', label: 'Worktree' },
];

interface KanbanSidePanelProps {
  pane: AumxPane;
  onClose: () => void;
}

export function KanbanSidePanel({ pane, onClose }: KanbanSidePanelProps) {
  const status = usePaneEffectiveStatus(pane);
  const [activeTab, setActiveTab] = useState<SidePanelTab>('terminal');
  const terminalVisible = activeTab === 'terminal';
  const lastPaneIdRef = useRef(pane.id);
  const focusPane = useUiStore((s) => s.focusPane);
  const { jumpToPane } = usePaneActions();
  const session = useAgentSessionStore((s) => s.sessions[pane.id]);
  const totalTokens = session?.metrics.totalTokens ?? 0;

  useAgentSessionHydration(pane.id, agentHasSessionParsing(pane.agent));

  useEffect(() => {
    if (lastPaneIdRef.current !== pane.id) {
      lastPaneIdRef.current = pane.id;
      // Always open newly selected panes on Terminal so boot/progress is visible.
      setActiveTab('terminal');
    }
  }, [pane.id]);

  return (
    <div data-testid="kanban-side-panel" className="flex flex-col h-full bg-[var(--surface)] border-l border-[var(--border)]">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] shrink-0">
        <StatusDot status={status} size="sm" />
        <span data-testid="kanban-side-panel-slug" className="text-xs font-semibold text-[var(--text)] truncate font-mono flex-1">
          {pane.slug || pane.id}
        </span>
        {pane.agent && <Badge label={pane.agent} />}
        {totalTokens > 0 && (
          <span className="text-[10px] text-[var(--text-muted)]">total {formatTokenCount(totalTokens)}</span>
        )}
        <div className="flex items-center gap-0.5 ml-1">
          <button
            onClick={() => {
              if (pane.paneId) jumpToPane(pane.paneId);
            }}
            className="px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] hover:text-[var(--accent)] rounded transition-colors hover:bg-[var(--surface-raised)]"
            title="Jump to tmux pane"
          >
            Jump
          </button>
          <button
            onClick={() => focusPane(pane.id)}
            className="px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] hover:text-[var(--accent)] rounded transition-colors hover:bg-[var(--surface-raised)]"
            title="Focus view"
          >
            Focus
          </button>
          <button
            onClick={onClose}
            className="min-w-5 min-h-5 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)] rounded transition-colors hover:bg-[var(--surface-raised)]"
            aria-label="Close panel"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {pane.prompt && (
        <div className="px-3 py-2 border-b border-[var(--border)] shrink-0 bg-[var(--surface-raised)]/40">
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">
            Prompt
          </div>
          <p className="text-[11px] leading-[1.4] text-[var(--text-secondary)] line-clamp-4 whitespace-pre-wrap">
            {pane.prompt}
          </p>
        </div>
      )}

      <div className="flex border-b border-[var(--border)] shrink-0" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'px-3 py-1.5 text-[11px] font-medium transition-colors relative',
              activeTab === tab.id
                ? 'text-[var(--text)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
            )}
          >
            {tab.label}
            {activeTab === tab.id && (
              <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[var(--accent)]" />
            )}
          </button>
        ))}
      </div>

      <div className="relative flex-1 min-h-0 overflow-hidden">
        <div
          aria-hidden={!terminalVisible}
          className={cn(
            'absolute inset-0',
            terminalVisible ? 'visible z-10' : 'invisible pointer-events-none z-0',
          )}
        >
          <InteractiveTerminal pane={pane} />
        </div>

        {activeTab === 'activity' && (
          <TabPanelSurface>
            <LazyAgentActivityPanel paneId={pane.id} />
          </TabPanelSurface>
        )}
        {activeTab === 'diff' && (
          <TabPanelSurface>
            <LazyGitDiffView pane={pane} />
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
      </div>
    </div>
  );
}
