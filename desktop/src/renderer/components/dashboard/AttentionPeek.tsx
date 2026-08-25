import type { MuxBasePane } from 'muxbase/core';
import { useMemo, type RefObject } from 'react';
import type { NormalizedSession } from '../../../shared/agent-session-types';
import type { PaneActivity, PaneActivityState } from '../../../shared/pane-activity';
import { jumpToWaitingPane } from '../../hooks/usePaneAttention';
import { formatRelativeTime } from '../../lib/formatters';
import {
  getEffectivePaneStatus,
  PANE_ATTENTION_PHRASES,
  type PaneAttention,
} from '../../lib/pane-attention';
import { useAgentSessionStore, useCommandPaletteStore, usePaneActivityStore, usePaneStore } from '../../stores';
import { AnchoredMenu } from '../shared/AnchoredMenu';
import { StatusDot } from '../shared/StatusDot';

const EMPTY_ROWS: AttentionPeekRow[] = [];
const MAX_ROWS = 3;
const ROW_CLASS = 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface)] focus-visible:outline-none focus-visible:bg-[var(--surface)]';
const SURFACE_CLASS = 'w-80 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] py-1 shadow-xl';
const WAITING_STATE_WORD = 'Waiting';

const ATTENTION_PEEK_LABEL = 'Waiting agents';
const ATTENTION_PEEK_MORE_TEST_ID = 'attention-peek-more';
const ATTENTION_PEEK_ROW_TEST_ID = 'attention-peek-row';

interface AttentionPeekProps {
  items: readonly PaneAttention[];
  onClose: () => void;
  open: boolean;
  triggerRef: RefObject<HTMLElement | null>;
}

interface AttentionPeekRow {
  elapsed: string;
  name: string;
  paneId: string;
  phrase: string;
  status: PaneActivityState;
}

function toRow(
  pane: MuxBasePane,
  session: NormalizedSession | undefined,
  activity: PaneActivity | undefined,
  item: PaneAttention,
): AttentionPeekRow {
  return {
    elapsed: session?.lastUpdateTime ? formatRelativeTime(session.lastUpdateTime) : '',
    name: pane.title || session?.title || pane.slug || pane.id,
    paneId: pane.id,
    phrase: `${WAITING_STATE_WORD} · ${PANE_ATTENTION_PHRASES[item.reason]}`,
    status: getEffectivePaneStatus(pane, session, activity),
  };
}

function buildRows(
  items: readonly PaneAttention[],
  panes: readonly MuxBasePane[],
  sessions: Readonly<Record<string, NormalizedSession>>,
  activityByPaneId: Readonly<Record<string, PaneActivity>>,
): AttentionPeekRow[] {
  const byId = new Map(panes.map((pane) => [pane.id, pane]));
  const rows: AttentionPeekRow[] = [];
  for (const item of items) {
    const pane = byId.get(item.paneId);
    if (pane) rows.push(toRow(pane, sessions[pane.id], activityByPaneId[pane.id], item));
  }
  return rows;
}

/**
 * Peek list behind the ResourceBar's waiting stat. Caps at three rows so it can
 * never scroll: past that the last row hands the fleet over to the command
 * palette, which is the surface built for long lists.
 */
export function AttentionPeek({ items, onClose, open, triggerRef }: Readonly<AttentionPeekProps>) {
  const panes = usePaneStore((s) => s.panes);
  const sessions = useAgentSessionStore((s) => s.sessions);
  const activityByPaneId = usePaneActivityStore((s) => s.activityByPaneId);

  const rows = useMemo(
    () => (open ? buildRows(items, panes, sessions, activityByPaneId) : EMPTY_ROWS),
    [activityByPaneId, items, open, panes, sessions],
  );

  const overflow = rows.length > MAX_ROWS ? rows.length - MAX_ROWS + 1 : 0;
  const visible = overflow > 0 ? rows.slice(0, MAX_ROWS - 1) : rows;

  const handleSelect = (paneId: string) => {
    onClose();
    jumpToWaitingPane(paneId);
  };

  const handleOverflow = () => {
    onClose();
    useCommandPaletteStore.getState().openToTab('panes');
  };

  return (
    <AnchoredMenu
      align="start"
      className={SURFACE_CLASS}
      label={ATTENTION_PEEK_LABEL}
      onClose={onClose}
      open={open}
      triggerRef={triggerRef}
    >
      {visible.map((row) => (
        <PeekRow key={row.paneId} onSelect={handleSelect} row={row} />
      ))}
      {overflow > 0 && (
        <button
          className={ROW_CLASS}
          data-testid={ATTENTION_PEEK_MORE_TEST_ID}
          onClick={handleOverflow}
          role="menuitem"
          type="button"
        >
          +{overflow} more
        </button>
      )}
    </AnchoredMenu>
  );
}

function PeekRow({ onSelect, row }: Readonly<{ onSelect: (paneId: string) => void; row: AttentionPeekRow }>) {
  return (
    <button
      className={ROW_CLASS}
      data-testid={ATTENTION_PEEK_ROW_TEST_ID}
      onClick={() => onSelect(row.paneId)}
      role="menuitem"
      type="button"
    >
      <span aria-hidden="true" className="flex shrink-0">
        <StatusDot size="sm" status={row.status} />
      </span>
      <span className="min-w-0 truncate font-medium text-[var(--text)]">{row.name}</span>
      <span className="min-w-0 truncate text-[var(--text-secondary)]">{row.phrase}</span>
      {row.elapsed !== '' && (
        <span className="ml-auto shrink-0 text-[var(--text-muted)]">{row.elapsed}</span>
      )}
    </button>
  );
}
