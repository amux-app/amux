import type { MuxBasePane } from 'muxbase/core';
import type { SidebarOrganize, SidebarSort } from '../../shared/ipc-types';
import type { PaneActivity, PaneActivityState } from '../../shared/pane-activity';
import { type ActiveProjectSource, resolvePaneProjectDisplay } from './pane-project-display';

export interface SidebarPaneStatus {
  status: PaneActivityState | undefined;
  waiting: boolean;
}

export type SidebarStatusLookup = ReadonlyMap<string, SidebarPaneStatus>;
export type SidebarActivityLookup = Readonly<Record<string, Pick<PaneActivity, 'sinceWallMs'>>>;

export interface SidebarGroup {
  key: string;
  label: string | null;
  panes: MuxBasePane[];
}

const FLAT_GROUP_KEY = 'all';
const UNGROUPED_GROUP_KEY = 'ungrouped';
const UNGROUPED_LABEL = 'Other';
const WAITING_RANK = 0;
const ACTIVE_RANK = 1;
const IDLE_RANK = 2;

const RANK_BY_STATUS: Record<string, number> = {
  unknown: IDLE_RANK,
  starting: ACTIVE_RANK,
  stopped: IDLE_RANK,
  idle: IDLE_RANK,
  waiting: WAITING_RANK,
  working: ACTIVE_RANK,
  // Compatibility for tests/boot payloads from the pre-six-state renderer;
  // live renderer policy never emits this value.
  analyzing: ACTIVE_RANK,
};

function priorityRank(pane: MuxBasePane, statusOf: SidebarStatusLookup): number {
  const entry = statusOf.get(pane.id);
  if (entry?.waiting === true) return WAITING_RANK;
  if (entry?.status === undefined) return IDLE_RANK;
  return RANK_BY_STATUS[entry.status];
}

function isActiveNow(pane: MuxBasePane, statusOf: SidebarStatusLookup): boolean {
  const status = statusOf.get(pane.id)?.status;
  return status !== undefined && RANK_BY_STATUS[status] === ACTIVE_RANK;
}

function sinceWallMsOf(pane: MuxBasePane, activityOf: SidebarActivityLookup): number {
  return activityOf[pane.id]?.sinceWallMs ?? 0;
}

function effectiveUpdatedAt(pane: MuxBasePane, statusOf: SidebarStatusLookup, activityOf: SidebarActivityLookup): number {
  return isActiveNow(pane, statusOf) ? Number.MAX_SAFE_INTEGER : sinceWallMsOf(pane, activityOf);
}

function sortPanes(
  panes: MuxBasePane[],
  sort: SidebarSort,
  statusOf: SidebarStatusLookup,
  activityOf: SidebarActivityLookup,
): MuxBasePane[] {
  if (sort === 'manual') return panes;

  return panes
    .map((pane, index) => ({
      index,
      pane,
      rank: sort === 'priority' ? priorityRank(pane, statusOf) : IDLE_RANK,
      sinceWallMs: sinceWallMsOf(pane, activityOf),
      updatedAt: sort === 'updated' ? effectiveUpdatedAt(pane, statusOf, activityOf) : sinceWallMsOf(pane, activityOf),
    }))
    .sort((a, b) =>
      a.rank - b.rank
      || b.updatedAt - a.updatedAt
      || b.sinceWallMs - a.sinceWallMs
      || a.index - b.index)
    .map((entry) => entry.pane);
}

function groupByProject(
  panes: readonly MuxBasePane[],
  activeProject: ActiveProjectSource | null | undefined,
): SidebarGroup[] {
  const groups = new Map<string, SidebarGroup>();

  for (const pane of panes) {
    const display = resolvePaneProjectDisplay(pane, activeProject);
    const key = display?.root ?? UNGROUPED_GROUP_KEY;
    const group = groups.get(key);
    if (group) {
      group.panes.push(pane);
      continue;
    }
    groups.set(key, { key, label: display?.name ?? UNGROUPED_LABEL, panes: [pane] });
  }

  return [...groups.values()];
}

function minPriorityRank(group: SidebarGroup, statusOf: SidebarStatusLookup): number {
  return Math.min(...group.panes.map((pane) => priorityRank(pane, statusOf)));
}

function maxEffectiveUpdatedAt(group: SidebarGroup, statusOf: SidebarStatusLookup, activityOf: SidebarActivityLookup): number {
  return Math.max(...group.panes.map((pane) => effectiveUpdatedAt(pane, statusOf, activityOf)));
}

function compareGroupTieBreak(a: SidebarGroup, b: SidebarGroup): number {
  const aUngrouped = a.key === UNGROUPED_GROUP_KEY;
  const bUngrouped = b.key === UNGROUPED_GROUP_KEY;
  if (aUngrouped !== bUngrouped) return aUngrouped ? 1 : -1;
  return (a.label ?? '').localeCompare(b.label ?? '');
}

function orderGroups(
  groups: SidebarGroup[],
  sort: SidebarSort,
  statusOf: SidebarStatusLookup,
  activityOf: SidebarActivityLookup,
): SidebarGroup[] {
  if (sort === 'manual') return groups;

  if (sort === 'priority') {
    return groups
      .slice()
      .sort((a, b) => minPriorityRank(a, statusOf) - minPriorityRank(b, statusOf) || compareGroupTieBreak(a, b));
  }

  return groups
    .slice()
    .sort((a, b) =>
      maxEffectiveUpdatedAt(b, statusOf, activityOf) - maxEffectiveUpdatedAt(a, statusOf, activityOf)
      || compareGroupTieBreak(a, b));
}

export function orderSidebarPanes(
  panes: readonly MuxBasePane[],
  organize: SidebarOrganize,
  sort: SidebarSort,
  statusOf: SidebarStatusLookup,
  activityOf: SidebarActivityLookup,
  activeProject?: ActiveProjectSource | null,
): SidebarGroup[] {
  const groups: SidebarGroup[] = organize === 'flat'
    ? [{ key: FLAT_GROUP_KEY, label: null, panes: panes.slice() }]
    : groupByProject(panes, activeProject);

  for (const group of groups) {
    group.panes = sortPanes(group.panes, sort, statusOf, activityOf);
  }

  const ordered = orderGroups(groups, sort, statusOf, activityOf);
  if (ordered.length === 1) ordered[0].label = null;
  return ordered;
}
