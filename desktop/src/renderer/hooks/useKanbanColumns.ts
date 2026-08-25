import { useMemo, useEffect, useRef, useCallback, useState } from 'react';
import type { MuxBasePane } from 'muxbase/core';
import type { NormalizedSession } from '../../shared/agent-session-types';
import type { BacklogItem, DoneItem } from '../../shared/kanban-types';
import { getPaneKanbanActivityState, getPaneKanbanNextTransitionTime } from '../../shared/kanban-pane-activity';
import type { PaneActivity, PaneActivityState } from '../../shared/pane-activity';
import { getEffectivePaneStatus, isPaneWaitingForUser } from '../lib/pane-attention';
import { usePaneStore } from '../stores/pane.store';
import { usePaneActivityStore } from '../stores/pane-activity.store';
import { useKanbanStore } from '../stores/kanban.store';
import { useAgentSessionStore } from '../stores/agent-session.store';
import { useDirtyMapStore } from '../stores/worktree-dirty.store';
import { useColumnOverrideStore } from '../stores/column-override.store';
import { invoke } from '../api/ipc';
import { IPC } from '../../shared/ipc-channels';

export function useColumnOverride() {
  const setOverride = useColumnOverrideStore((s) => s.set);
  const removeOverride = useColumnOverrideStore((s) => s.remove);
  return { setOverride, removeOverride };
}

export interface KanbanColumn {
  id: string;
  title: string;
  color: string;
  items: KanbanColumnItem[];
  droppable: boolean;
  draggableCards: boolean;
}

export type KanbanColumnItem =
  | { type: 'backlog'; data: BacklogItem }
  | { type: 'pane'; data: MuxBasePane }
  | { type: 'done'; data: DoneItem }
  | { type: 'launching'; data: BacklogItem };

function isNeedsAttentionPane(
  pane: MuxBasePane,
  status: PaneActivityState,
  forceNeedsAttentionPaneIds: ReadonlySet<string> | undefined,
): boolean {
  return isPaneWaitingForUser(pane, undefined, status)
    || forceNeedsAttentionPaneIds?.has(pane.id) === true;
}

function getNaturalColumn(
  pane: MuxBasePane,
  status: PaneActivityState,
  options?: {
    forceInProgressPaneIds?: ReadonlySet<string>;
    forceNeedsAttentionPaneIds?: ReadonlySet<string>;
  },
): string {
  if (isNeedsAttentionPane(pane, status, options?.forceNeedsAttentionPaneIds)) {
    return 'needs-attention';
  }
  if (options?.forceInProgressPaneIds?.has(pane.id)) return 'in-progress';
  return 'in-progress';
}

export function computeEffectiveStatusByPaneId(
  panes: MuxBasePane[],
  sessions: Record<string, NormalizedSession>,
  paneActivityById: Record<string, PaneActivity>,
): Record<string, PaneActivityState> {
  const map: Record<string, PaneActivityState> = {};
  for (const pane of panes) {
    map[pane.id] = getEffectivePaneStatus(pane, sessions[pane.id], paneActivityById[pane.id]);
  }
  return map;
}

export function useKanbanColumns(): {
  columns: KanbanColumn[];
  isLoading: boolean;
} {
  const panes = usePaneStore((s) => s.panes);
  const paneActivityById = usePaneActivityStore((s) => s.activityByPaneId);
  const backlog = useKanbanStore((s) => s.backlog);
  const done = useKanbanStore((s) => s.done);
  const sessions = useAgentSessionStore((s) => s.sessions);
  const dirtyMap = useDirtyMapStore((s) => s.dirtyMap);
  const setDirty = useDirtyMapStore((s) => s.setDirty);
  const pruneDirtyMap = useDirtyMapStore((s) => s.prune);
  const columnOverrides = useColumnOverrideStore((s) => s.overrides);
  const removeColumnOverride = useColumnOverrideStore((s) => s.remove);
  const pruneColumnOverrides = useColumnOverrideStore((s) => s.prune);
  const pendingChecks = useRef(new Set<string>());
  const previousPaneState = useRef<
    Record<
      string,
      {
        status?: PaneActivityState;
        worktreePath?: string;
        sessionLastUpdate?: number;
        heldInProgressOnIdle?: boolean;
      }
    >
  >({});
  const [kanbanNow, setKanbanNow] = useState(() => Date.now());

  useEffect(() => {
    // Keep activity-time calculations current when pane/session state changes.
    setKanbanNow(Date.now());
  }, [panes, sessions]);

  const nextKanbanRefreshAt = useMemo(() => {
    let nextAt: number | null = null;
    for (const pane of panes) {
      const candidate = getPaneKanbanNextTransitionTime(pane, sessions[pane.id], kanbanNow, paneActivityById[pane.id]);
      if (candidate === null) continue;
      if (nextAt === null || candidate < nextAt) {
        nextAt = candidate;
      }
    }
    return nextAt;
  }, [panes, sessions, kanbanNow, paneActivityById]);

  useEffect(() => {
    if (!nextKanbanRefreshAt) return;
    const delayMs = Math.max(0, nextKanbanRefreshAt - Date.now());
    const timeoutId = window.setTimeout(() => {
      setKanbanNow(Date.now());
    }, delayMs);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [nextKanbanRefreshAt]);

  const checkDirtyState = useCallback(
    async (pane: MuxBasePane) => {
      if (!pane.worktreePath || pendingChecks.current.has(pane.id)) return;
      pendingChecks.current.add(pane.id);
      try {
        const result = await invoke<{ hasChanges?: boolean }>(IPC.GIT_STATUS, {
          worktreePath: pane.worktreePath,
        });
        setDirty(pane.id, result.hasChanges === true);
      } catch {
        setDirty(pane.id, false);
      } finally {
        pendingChecks.current.delete(pane.id);
      }
    },
    [setDirty],
  );

  const forceInProgressPaneIds = useMemo(() => {
    const paneIds = new Set<string>();
    for (const pane of panes) {
      const activity = getPaneKanbanActivityState(pane, sessions[pane.id], kanbanNow, paneActivityById[pane.id]);
      if (activity.holdInProgressOnIdle) {
        paneIds.add(pane.id);
      }
    }
    return paneIds;
  }, [panes, sessions, kanbanNow, paneActivityById]);

  const effectiveStatusByPaneId = useMemo(
    () => computeEffectiveStatusByPaneId(panes, sessions, paneActivityById),
    [panes, sessions, paneActivityById],
  );

  const forceNeedsAttentionPaneIds = useMemo(() => {
    const paneIds = new Set<string>();
    for (const pane of panes) {
      if (isPaneWaitingForUser(pane, sessions[pane.id], effectiveStatusByPaneId[pane.id])) {
        paneIds.add(pane.id);
      }
    }
    return paneIds;
  }, [panes, sessions, effectiveStatusByPaneId]);

  useEffect(() => {
    const nextPaneState: Record<
      string,
      {
        status?: PaneActivityState;
        worktreePath?: string;
        sessionLastUpdate?: number;
        heldInProgressOnIdle?: boolean;
      }
    > = {};
    const paneIds = panes.map((p) => p.id);
    pruneDirtyMap(paneIds);
    pruneColumnOverrides(paneIds);

    for (const pane of panes) {
      const override = columnOverrides[pane.id];
      if (!override) continue;
      const naturalColumn = getNaturalColumn(
        pane,
        effectiveStatusByPaneId[pane.id],
        {
          forceInProgressPaneIds,
          forceNeedsAttentionPaneIds,
        },
      );
      if (naturalColumn === override) {
        removeColumnOverride(pane.id);
      }
    }

    const idlePanesWithWorktree = panes.filter(
      (p) => effectiveStatusByPaneId[p.id] === 'idle' && p.worktreePath,
    );
    for (const pane of idlePanesWithWorktree) {
      const previous = previousPaneState.current[pane.id];
      const sessionLastUpdate = sessions[pane.id]?.lastUpdateTime;
      const activity = getPaneKanbanActivityState(pane, sessions[pane.id], kanbanNow, paneActivityById[pane.id]);
      const effectiveStatus = effectiveStatusByPaneId[pane.id];
      const enteredIdle = previous?.status !== effectiveStatus;
      const worktreeChanged = previous?.worktreePath !== pane.worktreePath;
      const sessionUpdatedWhileIdle =
        sessionLastUpdate !== undefined
        && previous?.sessionLastUpdate !== sessionLastUpdate;
      const holdReleased = previous?.heldInProgressOnIdle === true && !activity.holdInProgressOnIdle;
      const shouldRecheckOnSessionUpdate = sessionUpdatedWhileIdle && dirtyMap[pane.id] !== true;
      const shouldRecheckOnHoldRelease = holdReleased && dirtyMap[pane.id] !== true;
      if (
        dirtyMap[pane.id] === undefined
        || enteredIdle
        || worktreeChanged
        || shouldRecheckOnSessionUpdate
        || shouldRecheckOnHoldRelease
      ) {
        checkDirtyState(pane);
      }
    }

    for (const pane of panes) {
      const sessionLastUpdate = sessions[pane.id]?.lastUpdateTime;
      const activity = getPaneKanbanActivityState(pane, sessions[pane.id], kanbanNow, paneActivityById[pane.id]);
      nextPaneState[pane.id] = {
      status: effectiveStatusByPaneId[pane.id],
        worktreePath: pane.worktreePath,
        sessionLastUpdate,
        heldInProgressOnIdle: activity.holdInProgressOnIdle,
      };
    }
    previousPaneState.current = nextPaneState;
  }, [panes, sessions, kanbanNow, dirtyMap, columnOverrides, checkDirtyState, pruneDirtyMap, pruneColumnOverrides, removeColumnOverride, forceInProgressPaneIds, forceNeedsAttentionPaneIds, effectiveStatusByPaneId, paneActivityById]);

  const columns = useMemo(
    () =>
      deriveKanbanColumns(panes, backlog, done, dirtyMap, {
        forceInProgressPaneIds,
        forceNeedsAttentionPaneIds,
        columnOverrides,
        effectiveStatusByPaneId,
      }),
    [panes, backlog, done, dirtyMap, forceInProgressPaneIds, forceNeedsAttentionPaneIds, columnOverrides, effectiveStatusByPaneId],
  );

  const isLoading = panes.some(
    (p) => effectiveStatusByPaneId[p.id] === 'idle' && p.worktreePath && dirtyMap[p.id] === undefined,
  );

  return { columns, isLoading };
}

export function deriveKanbanColumns(
  panes: MuxBasePane[],
  backlog: BacklogItem[],
  done: DoneItem[],
  dirtyMap: Record<string, boolean>,
  options?: {
    forceInProgressPaneIds?: ReadonlySet<string>;
    forceNeedsAttentionPaneIds?: ReadonlySet<string>;
    columnOverrides?: Record<string, string>;
    effectiveStatusByPaneId?: Record<string, PaneActivityState>;
  },
): KanbanColumn[] {
  const sortedBacklog = [...backlog].sort((a, b) => a.order - b.order);

  const inProgress: MuxBasePane[] = [];
  const needsAttention: MuxBasePane[] = [];
  const review: MuxBasePane[] = [];
  const donePanes: MuxBasePane[] = [];

  for (const pane of panes) {
    const override = options?.columnOverrides?.[pane.id];
    if (override === 'done') {
      donePanes.push(pane);
      continue;
    }
    if (override === 'needs-attention') {
      needsAttention.push(pane);
      continue;
    }
    if (override === 'review') {
      review.push(pane);
      continue;
    }
    if (override === 'in-progress') {
      inProgress.push(pane);
      continue;
    }

    const status = options?.effectiveStatusByPaneId?.[pane.id] ?? 'unknown';
    if (isNeedsAttentionPane(pane, status, options?.forceNeedsAttentionPaneIds)) {
      needsAttention.push(pane);
    } else {
      inProgress.push(pane);
    }
  }

  return [
    {
      id: 'backlog',
      title: 'Backlog',
      color: 'var(--text-muted)',
      droppable: true,
      draggableCards: true,
      items: sortedBacklog.map((item) => ({ type: 'backlog', data: item })),
    },
    {
      id: 'in-progress',
      title: 'In Progress',
      color: 'var(--agent-working)',
      droppable: true,
      draggableCards: true,
      items: inProgress.map((pane) => ({ type: 'pane', data: pane })),
    },
    {
      id: 'needs-attention',
      title: 'Needs Attention',
      color: 'var(--agent-waiting)',
      droppable: true,
      draggableCards: true,
      items: needsAttention.map((pane) => ({ type: 'pane', data: pane })),
    },
    {
      id: 'review',
      title: 'Review',
      color: 'var(--accent)',
      droppable: true,
      draggableCards: true,
      items: review.map((pane) => ({ type: 'pane', data: pane })),
    },
    {
      id: 'done',
      title: 'Done',
      color: 'var(--success)',
      droppable: true,
      draggableCards: true,
      items: [
        ...donePanes.map((pane) => ({ type: 'pane', data: pane } as const)),
        ...done.map((item) => ({ type: 'done', data: item } as const)),
      ],
    },
  ];
}

export function useRefreshDirtyMap(): () => void {
  const clear = useDirtyMapStore((s) => s.clear);

  return useCallback(() => {
    clear();
  }, [clear]);
}
