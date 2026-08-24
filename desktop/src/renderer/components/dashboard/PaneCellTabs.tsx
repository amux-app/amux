import * as ContextMenu from '@radix-ui/react-context-menu';
import type { AumxPane } from 'aumx/core';
import type { PaneActivityState } from '../../../shared/pane-activity';
import { FileText, GitCompareArrows, Terminal, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { KeyboardEvent, MouseEvent } from 'react';
import type { ProviderId } from '../../../shared/ipc-types';
import { cn } from '../../lib/cn';
import { AGENT_PROVIDERS, MIN_TARGET_BUTTON_CLASS } from '../../lib/constants';
import type { FileTab } from '../../stores';
import { useAgentSessionStore } from '../../stores/agent-session.store';
import { useWorktreeStatusStore } from '../../stores/worktree-status.store';
import { AnimatedNumber } from '../shared/AnimatedNumber';
import { Kbd } from '../shared/Kbd';
import { ProviderHealthIndicator } from '../shared/ProviderHealthIndicator';
import { StatusDot } from '../shared/StatusDot';
import { PANE_TAB_ICONS } from './PaneTabIcons';

export type PaneCellTab = 'terminal' | 'diff' | 'activity' | 'summary' | 'tokens' | 'worktree';
export type TabActionResult = boolean | void | Promise<boolean | void>;

export interface FileTabsBarProps {
  tabs: readonly FileTab[];
  activeId: string | null;
  onClick: (tab: FileTab) => TabActionResult;
  onClose: (tab: FileTab) => TabActionResult;
  onCloseAll: () => TabActionResult;
  onCloseOthers: (tab: FileTab) => TabActionResult;
  onCloseToRight: (tab: FileTab) => TabActionResult;
}

const TABS: { id: PaneCellTab; label: string }[] = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'diff', label: 'Diff' },
  { id: 'activity', label: 'Activity' },
  { id: 'summary', label: 'Summary' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'worktree', label: 'Worktree' },
];

const PEEK_STATUS: Record<PaneActivityState, { label: string; pillClass: string }> = {
  unknown: { label: 'Unknown', pillClass: 'text-[var(--text-secondary)] bg-[var(--surface-raised)] border-[var(--border)]' },
  starting: { label: 'Starting', pillClass: 'text-[var(--text-secondary)] bg-[var(--surface-raised)] border-[var(--border)]' },
  working: { label: 'Working', pillClass: 'text-[var(--agent-working)] bg-[var(--agent-working)]/10 border-[var(--agent-working)]/30' },
  waiting: { label: 'Waiting', pillClass: 'text-[var(--agent-waiting)] bg-[var(--agent-waiting)]/10 border-[var(--agent-waiting)]/30' },
  idle: { label: 'Idle', pillClass: 'text-[var(--text-secondary)] bg-[var(--surface-raised)] border-[var(--border)]' },
  stopped: { label: 'Stopped', pillClass: 'text-[var(--text-secondary)] bg-[var(--surface-raised)] border-[var(--border)]' },
};

const FILE_TAB_MENU_CLASS =
  'z-50 min-w-44 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] py-1 shadow-xl';

const FILE_TAB_MENU_ITEM_CLASS =
  'flex h-7 cursor-default items-center px-3 text-xs text-[var(--text-secondary)] outline-none data-highlighted:bg-[var(--tool-item-hover-bg)] data-highlighted:text-[var(--text)] data-disabled:opacity-40';

const TAB_NAVIGATION_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

function settleTabAction(
  result: TabActionResult,
  onAccepted: () => void,
  onRefused: () => void,
): void {
  if (result instanceof Promise) {
    void result.then((accepted) => (accepted === false ? onRefused() : onAccepted()));
    return;
  }
  if (result === false) {
    onRefused();
    return;
  }
  onAccepted();
}

export function activateTab(
  event: MouseEvent<HTMLButtonElement>,
  activate: () => TabActionResult,
): void {
  event.stopPropagation();
  const target = event.currentTarget;
  const selected = target
    .closest('[role="tablist"]')
    ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? null;

  settleTabAction(activate(), () => undefined, () => {
    if (document.activeElement === target) selected?.focus();
  });
}

export function handleTablistNavigation(event: KeyboardEvent<HTMLElement>): boolean {
  if (!TAB_NAVIGATION_KEYS.has(event.key)) return false;
  const tablist = event.currentTarget.closest('[role="tablist"]');
  if (!tablist) return false;
  const tabs = Array.from(tablist.querySelectorAll<HTMLElement>('[role="tab"]'));
  const currentIndex = tabs.indexOf(event.currentTarget);
  if (currentIndex < 0 || tabs.length < 2) return false;

  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? tabs.length - 1
      : event.key === 'ArrowRight'
        ? (currentIndex + 1) % tabs.length
        : (currentIndex - 1 + tabs.length) % tabs.length;
  const next = tabs[nextIndex];
  event.preventDefault();
  event.stopPropagation();
  next.focus();
  next.click();
  return true;
}

export function CellTabBar({
  activeTab,
  onTabChange,
  paneId,
  agent,
  hasWorktree,
  fileTabs,
}: {
  activeTab: PaneCellTab;
  onTabChange: (tab: PaneCellTab) => TabActionResult;
  paneId: string;
  agent?: string;
  hasWorktree: boolean;
  fileTabs: FileTabsBarProps;
}) {
  const fileTabActive = fileTabs.activeId !== null;

  return (
    <div className="flex items-center border-b border-[var(--divider)] bg-[var(--chrome)]">
      {/* The tablist owns only the tabs; the stats capsule is a sibling so its
          controls are never exposed as tablist children. */}
      <div className="flex min-w-0 flex-1 items-center overflow-x-auto" role="tablist">
        {TABS.map((tab) => {
          const isActive = !fileTabActive && activeTab === tab.id;
          const Icon = PANE_TAB_ICONS[tab.id];
          const label = tab.id === 'terminal' && agent ? 'Agent' : tab.label;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              aria-label={label}
              tabIndex={isActive ? 0 : -1}
              title={label}
              onClick={(event) => activateTab(event, () => onTabChange(tab.id))}
              onKeyDown={handleTablistNavigation}
              className={cn(
                'shrink-0 px-3 py-1.5 text-[11px] font-medium transition-colors relative',
                isActive
                  ? 'text-[var(--text)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text)]',
              )}
            >
              <span className="flex items-center gap-1.5">
                <Icon size={12} />
                <span className="hidden @min-[380px]/panecell:inline">{label}</span>
              </span>
              {isActive && (
                <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[var(--accent)]" />
              )}
            </button>
          );
        })}

        <FileTabsStrip {...fileTabs} />
      </div>

      <PaneStatsCapsule paneId={paneId} agent={agent} hasWorktree={hasWorktree} />
    </div>
  );
}

export function FileTabsStrip({
  activeId,
  onClick,
  onClose,
  onCloseAll,
  onCloseOthers,
  onCloseToRight,
  tabs,
}: FileTabsBarProps) {
  if (tabs.length === 0) return null;

  return (
    <>
      <span className="shrink-0 mx-1 h-3.5 w-px bg-[var(--border)]" aria-hidden />
      {tabs.map((tab, index) => (
        <FileTabButton
          key={tab.id}
          hasTabsToRight={index < tabs.length - 1}
          isActive={activeId === tab.id}
          onClick={onClick}
          onClose={onClose}
          onCloseAll={onCloseAll}
          onCloseOthers={onCloseOthers}
          onCloseToRight={onCloseToRight}
          tab={tab}
        />
      ))}
    </>
  );
}

const FILE_TAB_ACTIVATION_KEYS = ['Enter', ' '];
const FILE_TAB_CLOSE_KEYS = ['Delete', 'Backspace'];

function findTabAfterClose(closing: HTMLElement): HTMLElement | null {
  const tablist = closing.closest('[role="tablist"]');
  if (!tablist) return null;
  const tabs = Array.from(tablist.querySelectorAll<HTMLElement>('[role="tab"]'));
  const index = tabs.indexOf(closing);
  if (index < 0) return null;
  return tabs[index + 1] ?? tabs[index - 1] ?? null;
}

function FileTabButton({
  hasTabsToRight,
  tab,
  isActive,
  onClick,
  onClose,
  onCloseAll,
  onCloseOthers,
  onCloseToRight,
}: {
  hasTabsToRight: boolean;
  tab: FileTab;
  isActive: boolean;
  onClick: (tab: FileTab) => TabActionResult;
  onClose: (tab: FileTab) => TabActionResult;
  onCloseAll: () => TabActionResult;
  onCloseOthers: (tab: FileTab) => TabActionResult;
  onCloseToRight: (tab: FileTab) => TabActionResult;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (handleTablistNavigation(event)) return;
    if (FILE_TAB_ACTIVATION_KEYS.includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.click();
      return;
    }
    if (FILE_TAB_CLOSE_KEYS.includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      // Keyboard closes must hand focus to a neighbouring tab; the mouse close
      // path deliberately leaves focus where the pointer left it.
      const closing = event.currentTarget;
      const nextFocus = findTabAfterClose(closing);
      settleTabAction(onClose(tab), () => nextFocus?.focus(), () => closing.focus());
    }
  };

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        {/* The X is a pointer shortcut inside one semantic tab. Keyboard and
            assistive-technology users close the focused tab with Delete. */}
        <button
          type="button"
          role="tab"
          aria-keyshortcuts="Delete Backspace"
          aria-label={tab.fileName}
          aria-selected={isActive}
          tabIndex={isActive ? 0 : -1}
          onClick={(event) => activateTab(event, () => onClick(tab))}
          onKeyDown={handleKeyDown}
          className={cn(
            'group relative flex max-w-[180px] shrink-0 items-center text-[11px] font-medium transition-colors',
            isActive
              ? 'text-[var(--text)] bg-[var(--surface)]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-[var(--surface)]/40',
          )}
          title={`${tab.relativePath} — Delete closes this tab`}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-2 text-left">
            <FileText size={11} className={cn('shrink-0', isActive ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]')} />
            <span className="truncate">{tab.fileName}</span>
          </span>
          <span
            aria-hidden="true"
            data-testid="file-tab-close"
            title={`Close ${tab.fileName}`}
            onClick={(e) => { e.stopPropagation(); onClose(tab); }}
            className={cn(
              'mr-1 flex items-center justify-center rounded text-[var(--text-secondary)] transition-opacity hover:bg-[var(--surface-raised)] hover:text-[var(--text)]',
              MIN_TARGET_BUTTON_CLASS,
              isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
            )}
          >
            <X size={10} />
          </span>
          {isActive && (
            <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[var(--accent)]" />
          )}
        </button>
      </ContextMenu.Trigger>

      <ContextMenu.Portal>
        <ContextMenu.Content className={FILE_TAB_MENU_CLASS}>
          <ContextMenu.Item className={FILE_TAB_MENU_ITEM_CLASS} onSelect={() => onClose(tab)}>
            Close
          </ContextMenu.Item>
          <ContextMenu.Item
            className={FILE_TAB_MENU_ITEM_CLASS}
            disabled={!hasTabsToRight}
            onSelect={() => onCloseToRight(tab)}
          >
            Close to the Right
          </ContextMenu.Item>
          <ContextMenu.Item className={FILE_TAB_MENU_ITEM_CLASS} onSelect={() => onCloseOthers(tab)}>
            Close Others
          </ContextMenu.Item>
          <ContextMenu.Separator className="mx-2 my-1 h-px bg-[var(--border)]" />
          <ContextMenu.Item className={FILE_TAB_MENU_ITEM_CLASS} onSelect={onCloseAll}>
            Close All
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
export function TerminalPeek({
  pane,
  status,
  onJumpToTerminal,
}: {
  pane: AumxPane;
  status: PaneActivityState;
  onJumpToTerminal: () => void;
}) {
  const { label, pillClass } = PEEK_STATUS[status];
  const detail = pane.branchName ?? '';

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onJumpToTerminal(); }}
      className="shrink-0 h-9 flex items-center gap-2.5 px-4 border-t border-[var(--border)] bg-gradient-to-b from-[var(--surface)] to-[var(--bg)] hover:from-[var(--surface-raised)] hover:to-[var(--surface)] transition-colors text-left"
      title="Switch to terminal (⌘`)"
    >
      <span className={cn('shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider border', pillClass)}>
        <StatusDot status={status} size="sm" />
        {label}
      </span>
      <span className="shrink-0 text-[11px] font-semibold text-[var(--text)] truncate max-w-[160px]">
        {pane.slug || pane.id}
      </span>
      {detail && (
        <span className="flex-1 min-w-0 truncate text-[11px] text-[var(--text-secondary)] font-mono">
          {detail}
        </span>
      )}
      <span className="shrink-0 inline-flex items-center gap-1 text-[10px] text-[var(--text-secondary)] font-mono ml-auto">
        <Terminal size={11} />
        <Kbd keys="⌘`" className="text-[9px] px-1 py-0.5" />
      </span>
    </button>
  );
}

const WORKTREE_BRANCH_PATH =
  'M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z';

function DiffCounts({ insertions, deletions }: { insertions: number; deletions: number }) {
  return (
    <>
      <GitCompareArrows size={10} className="text-[var(--text-secondary)] shrink-0" />
      {insertions > 0 && (
        <span className="text-[var(--success)] text-[10px] font-semibold leading-none" style={{ fontVariantNumeric: 'tabular-nums' }}>
          +<AnimatedNumber value={insertions} />
        </span>
      )}
      {deletions > 0 && (
        <span className="text-[var(--error)] text-[10px] font-semibold leading-none" style={{ fontVariantNumeric: 'tabular-nums' }}>
          -<AnimatedNumber value={deletions} />
        </span>
      )}
    </>
  );
}

export function InlineDiffStats({ insertions, deletions }: { insertions: number; deletions: number }) {
  const visible = insertions > 0 || deletions > 0;

  return (
    <AnimatePresence>
      {visible && (
        <motion.span
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--surface-raised)] border border-[var(--border)] px-1.5 py-0.5 ml-1"
        >
          <DiffCounts insertions={insertions} deletions={deletions} />
        </motion.span>
      )}
    </AnimatePresence>
  );
}

function CapsuleDivider() {
  return <span className="h-3 w-px shrink-0 bg-[var(--border)]" aria-hidden />;
}

function PaneStatsCapsule({
  paneId,
  agent,
  hasWorktree,
}: {
  paneId: string;
  agent?: string;
  hasWorktree: boolean;
}) {
  const status = useWorktreeStatusStore((s) => s.statuses[paneId]);
  const sessionProvider = useAgentSessionStore((s) => s.sessions[paneId]?.providerId);
  const sessionModelId = useAgentSessionStore((s) => s.sessions[paneId]?.modelId);
  const insertions = status?.insertions ?? 0;
  const deletions = status?.deletions ?? 0;
  const staticProvider = agent ? AGENT_PROVIDERS[agent.toLowerCase()] : undefined;
  const provider = staticProvider ?? (sessionProvider as ProviderId | undefined);
  const hasProvider = !!provider;
  const hasDiff = insertions > 0 || deletions > 0;

  if (!hasProvider && !hasWorktree && !hasDiff) return null;

  return (
    <span className="mx-2 inline-flex shrink-0 items-center gap-[var(--space-dense)] rounded-full border border-[var(--divider-strong)] bg-[var(--surface-raised)] px-2.5 py-0.5">
      {hasProvider && <ProviderHealthIndicator provider={provider} modelId={sessionModelId} agent={agent} />}
      {hasWorktree && (
        <>
          {hasProvider && <CapsuleDivider />}
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="currentColor"
            className="shrink-0 text-[var(--success)]"
            aria-label="Worktree active"
          >
            <path d={WORKTREE_BRANCH_PATH} />
          </svg>
        </>
      )}
      {hasDiff && (
        <span className="hidden @min-[480px]/panecell:inline-flex items-center gap-[var(--space-dense)]">
          {(hasProvider || hasWorktree) && <CapsuleDivider />}
          <DiffCounts insertions={insertions} deletions={deletions} />
        </span>
      )}
    </span>
  );
}
