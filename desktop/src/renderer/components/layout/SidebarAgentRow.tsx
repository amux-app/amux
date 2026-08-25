import type { AgentName, MuxBasePane } from 'muxbase/core';
import type { PaneActivityState } from '../../../shared/pane-activity';
import { PANE_NAME_MAX_LENGTH, validatePaneName } from 'muxbase/pane-name';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { cn } from '../../lib/cn';
import type { SidebarPaneStatus } from '../../lib/sidebar-order';
import { useWorktreeStatusStore } from '../../stores/worktree-status.store';
import { AgentBrandIcon } from '../shared/agent-brand-icons';
import { AnimatedNumber } from '../shared/AnimatedNumber';
import { restoreFocusTo } from '../shared/focus-restore';
import { HoverTooltip } from '../shared/HoverTooltip';
import { Spinner } from '../shared/Spinner';
import { StatusDot } from '../shared/StatusDot';
import { TypewriterText } from '../shared/TypewriterText';
import { SidebarAgentActionsMenu } from './SidebarAgentActionsMenu';
import { SIDEBAR_TOOLTIP_DELAY_MS } from './sidebarLayout';
import { SIDEBAR_ROW_SELECTED_CLASS, SIDEBAR_UI_FONT_CLASS } from './SidebarRow';

const LEADING_SLOT_CLASS = 'flex h-[16px] w-[16px] shrink-0 items-center justify-center';
const SPINNER_CLASS = 'border-t-[var(--sidebar-text-muted)] motion-reduce:hidden';
const REDUCED_MOTION_DOT_CLASS = 'hidden h-[6px] w-[6px] rounded-full motion-reduce:block';
const REDUCED_MOTION_DOT_STYLE: CSSProperties = { backgroundColor: 'var(--sidebar-status-working)' };
const WAITING_DOT_WRAPPER_STYLE = { '--dot-color': 'var(--sidebar-status-waiting)' } as CSSProperties;

const ROW_TWO_LINE_CLASS = cn(
  'sidebar-focus flex min-h-[40px] w-full items-center gap-[8px] rounded-[8px] px-[8px] py-[6px]',
  'text-left leading-none text-[var(--sidebar-text)]',
  'transition-[background-color,color] duration-150 hover:bg-[var(--sidebar-hover)]',
);

const ACTIVITY_STATUS_LABELS: Record<PaneActivityState, string> = {
  idle: 'Idle',
  starting: 'Starting',
  stopped: 'Stopped',
  unknown: 'Unknown',
  waiting: 'Waiting for input',
  working: 'Working',
};

export interface SidebarAgentRowProps {
  pane: MuxBasePane;
  hidden: boolean;
  onDelete: (paneId: string) => Promise<boolean>;
  onRename: (paneId: string, name: string) => void | Promise<void>;
  onSelect: (paneId: string) => void;
  selected: boolean;
  sessionTitle?: string;
  /** Effective activity state from the sidebar's session snapshot. */
  status: SidebarPaneStatus | undefined;
}

/** Waiting wins, so the dot, the tooltip, the priority sort and the section suffix agree. */
function visualStatus(status: SidebarPaneStatus | undefined): PaneActivityState {
  if (status?.waiting === true) return 'waiting';
  return status?.status ?? 'unknown';
}

function resolveSubLine(pane: MuxBasePane, visual: PaneActivityState): string {
  const statusLabel = ACTIVITY_STATUS_LABELS[visual].toLowerCase();
  if (pane.branchName) return `${statusLabel} · ${pane.branchName}`;
  if (pane.type === 'shell' && pane.shellType) return `${statusLabel} · ${pane.shellType.toLowerCase()}`;
  return statusLabel;
}

/** The agent whose brand mark anchors the row's right edge; shells fall back to the terminal glyph. */
function resolveBrandAgent(pane: MuxBasePane): AgentName | 'shell' | null {
  if (pane.agent) return pane.agent;
  if (pane.type === 'shell') return 'shell';
  return null;
}

/** Resting agent-identity mark pinned to the row's right edge. It shares the actions anchor and
 * cross-fades out as the hover/focus ⋯ menu fades in, so the two never overlap and nothing shifts. */
function TrailingBrand({ pane }: Readonly<{ pane: MuxBasePane }>) {
  const agent = resolveBrandAgent(pane);
  if (!agent) return null;
  return (
    <span
      aria-hidden="true"
      data-testid="sidebar-agent-brand"
      className={cn(
        'pointer-events-none flex shrink-0 items-center',
        'text-[var(--sidebar-text-muted)] opacity-70 transition-opacity duration-150',
        'group-hover/agent:opacity-0 group-focus-within/agent:opacity-0',
      )}
    >
      <AgentBrandIcon agent={agent} size="sm" className="h-[14px] w-[14px]" />
    </span>
  );
}

function SidebarDiffCounts({ paneId }: Readonly<{ paneId: string }>) {
  const status = useWorktreeStatusStore((s) => s.statuses[paneId]);
  const ins = status?.insertions ?? 0;
  const del = status?.deletions ?? 0;
  if (ins === 0 && del === 0) return null;
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-baseline gap-[3px] text-[10px] text-[var(--sidebar-text-muted)]"
      style={{ fontVariantNumeric: 'tabular-nums' }}
    >
      <span className="opacity-40 select-none">·</span>
      {ins > 0 && (
        <span className="text-[9px] leading-none text-[var(--sidebar-diff-addition)]">
          +<AnimatedNumber value={ins} />
        </span>
      )}
      {del > 0 && (
        <span className="text-[9px] leading-none text-[var(--sidebar-diff-deletion)]">
          -<AnimatedNumber value={del} />
        </span>
      )}
    </span>
  );
}

function deleteMessage(pane: MuxBasePane): string {
  if (pane.role === 'review') {
    return 'This stops the review agent and removes this chat from the sidebar. The temporary review workspace is cleaned up; your source worktree and project code are kept.';
  }
  if (!pane.worktreePath) {
    return pane.agent
      ? 'This stops the running agent and removes this chat from the sidebar. Project files are not deleted.'
      : 'This stops the running terminal and removes this chat from the sidebar. Project files are not deleted.';
  }
  return 'This stops the running agent and removes this chat from the sidebar. Your worktree and branch are kept, so no code is deleted.';
}

function RowTooltip({ name, subLine }: Readonly<{ name: string; subLine: string }>) {
  return (
    <span className={cn(SIDEBAR_UI_FONT_CLASS, 'block max-w-[240px]')}>
      <span className="block truncate text-[12px] font-medium text-[var(--text)]">{name}</span>
      <span className="mt-0.5 block truncate text-[10px] font-normal text-[var(--text-secondary)]">
        {subLine.charAt(0).toUpperCase()}{subLine.slice(1)}
      </span>
    </span>
  );
}

/** Leading affordance column: a muted ring spinner while working or analyzing, the
 * amber dot while waiting, nothing while idle. Fixed-size slot so rows never shift;
 * status already reaches AT via the row's own aria-label, so this subtree is hidden. */
function LeadingIndicator({ status }: Readonly<{ status: PaneActivityState }>) {
  return (
    <span className={LEADING_SLOT_CLASS} aria-hidden="true">
      {status === 'working' && (
        <>
          <Spinner size="xs" className={SPINNER_CLASS} />
          <span className={REDUCED_MOTION_DOT_CLASS} style={REDUCED_MOTION_DOT_STYLE} />
        </>
      )}
      {status === 'waiting' && (
        <span style={WAITING_DOT_WRAPPER_STYLE}>
          <StatusDot status="waiting" size="xs" variant="flat" />
        </span>
      )}
      {status === 'starting' && <StatusDot status="starting" size="xs" />}
      {status === 'stopped' && <StatusDot status="stopped" size="xs" />}
    </span>
  );
}

function SidebarAgentRowImpl({
  hidden,
  onDelete,
  onRename,
  onSelect,
  pane,
  selected,
  sessionTitle,
  status,
}: Readonly<SidebarAgentRowProps>) {
  // `status` already resolves activity plus the waiting overlay for the whole
  // list; reading the activity store again here would disagree with the sort.
  const visual = visualStatus(status);
  const name = pane.title || sessionTitle || pane.slug || pane.id;
  const subLine = resolveSubLine(pane, visual);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const actionsTriggerRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const restoreActionsFocusRef = useRef(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const renameErrorId = useId();
  const handleSelect = useCallback(() => onSelect(pane.id), [onSelect, pane.id]);

  useEffect(() => {
    if (renaming) {
      renameInputRef.current?.focus();
      return;
    }
    if (!restoreActionsFocusRef.current) return;
    restoreActionsFocusRef.current = false;
    restoreFocusTo(actionsTriggerRef.current);
  }, [renaming]);

  const startRename = useCallback(() => {
    setRenameError(null);
    setRenameValue(name);
    setRenaming(true);
  }, [name]);

  const cancelRename = useCallback(() => {
    setRenameError(null);
    restoreActionsFocusRef.current = true;
    setRenaming(false);
  }, []);

  const commitRename = useCallback(() => {
    const validation = validatePaneName(renameValue);
    if (!validation.ok) {
      setRenameError(validation.message);
      return;
    }
    setRenameError(null);
    restoreActionsFocusRef.current = true;
    setRenaming(false);
    if (validation.value !== name) void onRename(pane.id, validation.value);
  }, [name, onRename, pane.id, renameValue]);

  const getDeleteFocusTarget = useCallback((): HTMLElement | null => {
    const row = rowRef.current;
    const list = row?.closest('[data-sidebar-agent-list="true"]');
    const current = row?.querySelector<HTMLElement>('[data-sidebar-agent-select="true"]');
    if (!list || !current) return null;

    const rows = Array.from(
      list.querySelectorAll<HTMLElement>('[data-sidebar-agent-select="true"]'),
    );
    const index = rows.indexOf(current);
    if (index < 0) return null;
    return rows[index + 1] ?? rows[index - 1] ?? null;
  }, []);

  const handleRenameKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelRename();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      commitRename();
    }
  }, [cancelRename, commitRename]);

  return (
    <li ref={rowRef} className="group/agent relative" data-flip-id={pane.id}>
      {renaming ? (
        <div
          className={cn(
            ROW_TWO_LINE_CLASS,
            'sidebar-agent-name gap-[8px] pr-[8px] text-[13px]',
            hidden && !selected && 'opacity-50 hover:opacity-100',
            selected && SIDEBAR_ROW_SELECTED_CLASS,
          )}
        >
          <LeadingIndicator status={visual} />
          <input
            ref={renameInputRef}
            aria-describedby={renameError ? renameErrorId : undefined}
            aria-invalid={renameError ? true : undefined}
            aria-label={`Rename ${name}`}
            maxLength={PANE_NAME_MAX_LENGTH}
            onChange={(event) => {
              setRenameError(null);
              setRenameValue(event.target.value);
            }}
            onKeyDown={handleRenameKeyDown}
            value={renameValue}
            className={cn(
              'sidebar-focus min-w-0 flex-1 rounded-[4px] border bg-[var(--sidebar-bg)] px-[6px] py-[2px]',
              'text-[13px] text-[var(--sidebar-text)] outline-none',
              renameError ? 'border-[var(--error)]' : 'border-[var(--focus-ring)]',
            )}
          />
          {renameError && <span className="sr-only" id={renameErrorId}>{renameError}</span>}
        </div>
      ) : (
        <>
          <HoverTooltip
            className="block"
            label={<RowTooltip name={name} subLine={subLine} />}
            openDelayMs={SIDEBAR_TOOLTIP_DELAY_MS}
          >
            <button
              type="button"
              data-sidebar-agent-select="true"
              onClick={handleSelect}
              onDoubleClick={startRename}
              aria-current={selected ? true : undefined}
              aria-label={`${name} · ${ACTIVITY_STATUS_LABELS[visual]}`}
              className={cn(
                ROW_TWO_LINE_CLASS,
                'sidebar-agent-name cursor-pointer gap-[8px] pr-[8px] text-[13px]',
                hidden && !selected && 'opacity-50 hover:opacity-100',
                selected && SIDEBAR_ROW_SELECTED_CLASS,
              )}
            >
              <LeadingIndicator status={visual} />
              <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span className="flex min-w-0 items-center gap-[6px] leading-[1.2]">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium" data-agent-name="true">
                    <TypewriterText text={name} />
                  </span>
                  <TrailingBrand pane={pane} />
                </span>
                <span aria-hidden="true" className="flex min-w-0 items-baseline gap-[1px] text-[11px] leading-[1.2] text-[var(--sidebar-text-muted)]">
                  <span className="truncate">{subLine}</span>
                  <SidebarDiffCounts paneId={pane.id} />
                </span>
              </span>
            </button>
          </HoverTooltip>
          <SidebarAgentActionsMenu
            triggerRef={actionsTriggerRef}
            deleteMessage={deleteMessage(pane)}
            getDeleteFocusTarget={getDeleteFocusTarget}
            name={name}
            onDelete={() => onDelete(pane.id)}
            onRename={startRename}
          />
        </>
      )}
    </li>
  );
}

export const SidebarAgentRow = memo(SidebarAgentRowImpl);
