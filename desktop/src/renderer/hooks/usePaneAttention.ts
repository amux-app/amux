import { useMemo } from 'react';
import type { AumxPane } from 'aumx/core';
import { getPaneAttention, type PaneAttention, type PaneAttentionSession } from '../lib/pane-attention';
import type { PaneActivity } from '../../shared/pane-activity';
import { useAgentSessionStore } from '../stores/agent-session.store';
import { usePaneActivityStore } from '../stores/pane-activity.store';
import { usePaneStore } from '../stores/pane.store';
import { useUiStore } from '../stores/ui.store';
import { jumpToPaneRecord } from './usePaneActions';

export interface PaneAttentionState {
  waitingCount: number;
  waitingItems: PaneAttention[];
  jumpToNextWaitingPane: () => void;
}

function collectWaitingItems(
  panes: readonly AumxPane[],
  sessions: Readonly<Record<string, PaneAttentionSession>>,
  justFinishedPaneIds: ReadonlySet<string>,
  activityByPaneId: Readonly<Record<string, PaneActivity>>,
): PaneAttention[] {
  const items: PaneAttention[] = [];
  for (const pane of panes) {
    const attention = getPaneAttention(pane, sessions[pane.id], justFinishedPaneIds, activityByPaneId[pane.id]);
    if (attention?.kind === 'waiting') items.push(attention);
  }
  return items;
}

function collectWaitingPaneIds(items: readonly PaneAttention[]): Set<string> {
  const paneIds = new Set<string>();
  for (const item of items) {
    if (item.kind === 'waiting') paneIds.add(item.paneId);
  }
  return paneIds;
}

function findWaitingPaneIdInRange(
  paneOrder: readonly string[],
  waitingPaneIds: ReadonlySet<string>,
  from: number,
  to: number,
): string | null {
  for (let index = from; index < to; index++) {
    if (waitingPaneIds.has(paneOrder[index])) return paneOrder[index];
  }
  return null;
}

export function getNextAttentionPaneId(
  items: readonly PaneAttention[],
  paneOrder: readonly string[],
  selectedPaneId: string | null,
): string | null {
  const waitingPaneIds = collectWaitingPaneIds(items);
  if (waitingPaneIds.size === 0) return null;

  const selectedIndex = selectedPaneId === null ? -1 : paneOrder.indexOf(selectedPaneId);
  const after = findWaitingPaneIdInRange(paneOrder, waitingPaneIds, selectedIndex + 1, paneOrder.length);
  return after ?? findWaitingPaneIdInRange(paneOrder, waitingPaneIds, 0, selectedIndex + 1);
}

// Imperative so callers (⌘⇧J, the ResourceBar stat, the attention peek) never
// have to subscribe to the pane list or the agent sessions, which churn on
// every JSONL push. Every attention navigation goes through here.
export function jumpToWaitingPane(paneId: string): void {
  const { panes, selectPane } = usePaneStore.getState();
  const target = panes.find((pane) => pane.id === paneId);
  if (!target) return;

  selectPane(target.id);
  const ui = useUiStore.getState();
  if (ui.viewMode === 'focus') ui.focusPane(target.id);
  void jumpToPaneRecord(target);
}

export function jumpToNextWaitingPane(): void {
  const { panes, selectedPaneId } = usePaneStore.getState();
  const { justFinishedPaneIds } = usePaneActivityStore.getState();
  const items = collectWaitingItems(
    panes,
    useAgentSessionStore.getState().sessions,
    justFinishedPaneIds,
    usePaneActivityStore.getState().activityByPaneId,
  );
  const nextPaneId = getNextAttentionPaneId(items, panes.map((pane) => pane.id), selectedPaneId);
  if (nextPaneId !== null) jumpToWaitingPane(nextPaneId);
}

export function usePaneAttention(): PaneAttentionState {
  const panes = usePaneStore((s) => s.panes);
  const justFinishedPaneIds = usePaneActivityStore((s) => s.justFinishedPaneIds);
  const sessions = useAgentSessionStore((s) => s.sessions);
  const activityByPaneId = usePaneActivityStore((s) => s.activityByPaneId);

  const waitingItems = useMemo(
    () => collectWaitingItems(panes, sessions, justFinishedPaneIds, activityByPaneId),
    [activityByPaneId, justFinishedPaneIds, panes, sessions],
  );

  return useMemo(
    () => ({ waitingCount: waitingItems.length, waitingItems, jumpToNextWaitingPane }),
    [waitingItems],
  );
}
