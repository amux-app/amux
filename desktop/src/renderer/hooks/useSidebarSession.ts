import type { AumxPane } from 'aumx/core';
import { useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { PaneActivity, PaneActivityState } from '../../shared/pane-activity';
import { getEffectivePaneStatus, isPaneWaitingForUser, type PaneAttentionSession } from '../lib/pane-attention';
import type { SidebarPaneStatus, SidebarStatusLookup } from '../lib/sidebar-order';
import { useAgentSessionStore, usePaneActivityStore } from '../stores';

export interface SidebarSession {
  statusOf: SidebarStatusLookup;
  titleOf: ReadonlyMap<string, string>;
  waitingCount: number;
}

interface CachedStatusEntry {
  encodedValue: string;
  entry: SidebarPaneStatus;
}

type StatusEntryCache = Map<string, CachedStatusEntry>;

const FIELD_SEPARATOR = ' ';
const WAITING_MARK = '!';

const CODE_BY_STATUS: Record<PaneActivityState, string> = {
  unknown: 'u',
  starting: 's',
  stopped: 'x',
  idle: 'i',
  waiting: 'w',
  working: 'k',
};

const STATUS_BY_CODE: Record<string, PaneActivityState> = {
  u: 'unknown',
  s: 'starting',
  x: 'stopped',
  i: 'idle',
  k: 'working',
  w: 'waiting',
};

/**
 * One string per pane, index-aligned with `panes`: status code, waiting mark,
 * then the session title. Strings are primitives, so the shallow compare below
 * turns a raw session tick into no work at all — the array only changes identity
 * when something the sidebar actually paints has moved.
 */
function encodePane(
  pane: AumxPane,
  session: PaneAttentionSession,
  title: string | undefined,
  activity: PaneActivity | undefined,
): string {
  const status = getEffectivePaneStatus(pane, session, activity);
  const code = status === undefined ? '' : CODE_BY_STATUS[status];
  const waiting = isPaneWaitingForUser(pane, session, status) ? WAITING_MARK : '';
  return `${code}${waiting}${FIELD_SEPARATOR}${title ?? ''}`;
}

function statusEntryFor(pane: AumxPane, entry: string, cache: StatusEntryCache): SidebarPaneStatus {
  const cached = cache.get(pane.id);
  if (cached?.encodedValue === entry) return cached.entry;

  const boundary = entry.indexOf(FIELD_SEPARATOR);
  const marked = entry.slice(0, boundary);
  const waiting = marked.endsWith(WAITING_MARK);
  const fresh: SidebarPaneStatus = {
    status: STATUS_BY_CODE[waiting ? marked.slice(0, -1) : marked],
    waiting,
  };
  cache.set(pane.id, { encodedValue: entry, entry: fresh });
  return fresh;
}

/**
 * Reuses the previous status object per pane when its encoded string is
 * unchanged, so a tick that only moves an unrelated pane doesn't hand every
 * `React.memo`-wrapped row a new `status` reference and force it to re-render.
 */
function decode(panes: readonly AumxPane[], encoded: readonly string[], statusCache: StatusEntryCache): SidebarSession {
  const statusOf = new Map<string, SidebarPaneStatus>();
  const titleOf = new Map<string, string>();
  const seenIds = new Set<string>();
  let waitingCount = 0;

  panes.forEach((pane, index) => {
    const entry = encoded[index] ?? FIELD_SEPARATOR;
    const boundary = entry.indexOf(FIELD_SEPARATOR);
    const title = entry.slice(boundary + 1);
    const status = statusEntryFor(pane, entry, statusCache);

    seenIds.add(pane.id);
    if (status.waiting) waitingCount += 1;
    if (title) titleOf.set(pane.id, title);
    statusOf.set(pane.id, status);
  });

  for (const id of statusCache.keys()) {
    if (!seenIds.has(id)) statusCache.delete(id);
  }

  return { statusOf, titleOf, waitingCount };
}

/** The sidebar's single agent-session subscription. Rows read the result as props. */
export function useSidebarSession(panes: readonly AumxPane[]): SidebarSession {
  const statusCacheRef = useRef<StatusEntryCache>(new Map());
  const activities = usePaneActivityStore(
    useShallow((s) => panes.map((pane) => s.activityByPaneId[pane.id])),
  );
  const encoded = useAgentSessionStore(
    useShallow((s) => panes.map((pane, index) => {
      const session = s.sessions[pane.id];
      return encodePane(pane, session, session?.title, activities[index]);
    })),
  );

  return useMemo(() => decode(panes, encoded, statusCacheRef.current), [encoded, panes]);
}
