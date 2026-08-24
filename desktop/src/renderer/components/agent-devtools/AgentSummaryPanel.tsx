import { useCallback } from 'react';
import { motion } from 'motion/react';
import { useAgentSessionStore, useUiStore } from '../../stores';
import { useActivitySubTabStore } from '../../stores/activity-subtab.store';
import { EmptyState } from '../shared/EmptyState';
import { PromptsView } from './PromptsView';
import { RecapsView } from './RecapsView';
import { cn } from '../../lib/cn';

type SummarySubTab = 'prompts' | 'recaps';

interface AgentSummaryPanelProps {
  paneId: string;
  /**
   * Called when an inner control (e.g. a prompt's "jump to message" arrow) wants
   * to surface a message inside the Activity tab. Caller flips the outer tab to
   * 'activity'; this panel separately wires the activity sub-tab to
   * 'conversation' and the scroll target.
   */
  onJumpToActivity: () => void;
}

export function AgentSummaryPanel({ paneId, onJumpToActivity }: AgentSummaryPanelProps) {
  const subTab = useActivitySubTabStore((s) => {
    // Reuse the activity-subtab slice so cross-panel selections stay coherent,
    // but only honour the two values this panel offers.
    const v = s.byPane[paneId];
    return v === 'recaps' ? 'recaps' : 'prompts';
  }) as SummarySubTab;
  const setSubTab = useActivitySubTabStore((s) => s.setSubTab);
  const session = useAgentSessionStore((s) => s.sessions[paneId]);

  const navigateToMessage = useCallback((messageId: string) => {
    // Switch the inner activity sub-tab first so when the outer tab flips,
    // Activity opens on Conversation with the right scroll target.
    setSubTab(paneId, 'conversation');
    onJumpToActivity();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        useUiStore.setState({ scrollToMessageId: messageId });
      });
    });
  }, [paneId, setSubTab, onJumpToActivity]);

  if (!session || session.messages.length === 0) {
    return (
      <EmptyState
        title="No Activity Yet"
        description="Prompts and recaps will appear here once the session starts."
        className="h-full"
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 pt-3 pb-2.5 border-b border-[var(--border)] bg-[var(--surface)] shrink-0">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-[11px] font-semibold text-[var(--text)] tracking-tight">Summary</span>
          <span className="text-[9px] text-[var(--text-muted)]">
            Prompts &amp; recaps for this pane
          </span>
        </div>

        <div className="inline-flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-0.5">
          <SubTabButton active={subTab === 'prompts'} onClick={() => setSubTab(paneId, 'prompts')}>
            Prompts
          </SubTabButton>
          <SubTabButton active={subTab === 'recaps'} onClick={() => setSubTab(paneId, 'recaps')}>
            Recaps
          </SubTabButton>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {subTab === 'prompts' && (
          <PromptsView session={session} onNavigateToMessage={navigateToMessage} />
        )}
        {subTab === 'recaps' && <RecapsView session={session} paneId={paneId} />}
      </div>
    </div>
  );
}

function SubTabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={cn(
        'relative px-3 py-1.5 text-[10px] font-medium rounded-md transition-colors',
        active
          ? 'text-[var(--text)] bg-[var(--surface)] border border-[var(--border)] shadow-sm'
          : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
      )}
    >
      {children}
      {active && (
        <motion.span
          layoutId="summary-tab-indicator"
          className="absolute inset-x-2 -bottom-0.5 h-[1.5px] rounded-full bg-[var(--accent)]"
          transition={{ type: 'spring', stiffness: 500, damping: 40 }}
        />
      )}
    </button>
  );
}
