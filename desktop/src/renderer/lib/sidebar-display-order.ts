import type { SidebarGroup } from './sidebar-order';

function collectPaneIds(groups: readonly SidebarGroup[]): Set<string> {
  const ids = new Set<string>();
  for (const group of groups) {
    for (const pane of group.panes) ids.add(pane.id);
  }
  return ids;
}

function sameGroupKeys(held: readonly SidebarGroup[], target: readonly SidebarGroup[]): boolean {
  if (held.length !== target.length) return false;
  const targetKeys = new Set(target.map((group) => group.key));
  return held.every((group) => targetKeys.has(group.key));
}

function samePaneMembership(held: readonly SidebarGroup[], target: readonly SidebarGroup[]): boolean {
  const heldIds = collectPaneIds(held);
  const targetIds = collectPaneIds(target);
  if (heldIds.size !== targetIds.size) return false;
  for (const id of heldIds) {
    if (!targetIds.has(id)) return false;
  }
  return true;
}

function projectFreshGroup(heldGroup: SidebarGroup, targetGroup: SidebarGroup | undefined): SidebarGroup {
  if (!targetGroup) return heldGroup;
  const freshById = new Map(targetGroup.panes.map((pane) => [pane.id, pane] as const));
  return {
    key: heldGroup.key,
    label: targetGroup.label,
    panes: heldGroup.panes.map((pane) => freshById.get(pane.id) ?? pane),
  };
}

/**
 * Resolves which group/pane order the sidebar should paint. While the pointer is
 * inside the list, the held order is kept and only its pane data is refreshed from
 * the latest target groups — unless membership changed (a pane or group was added
 * or removed), in which case the target order is returned immediately so new or
 * removed panes are never hidden behind a stale hold.
 */
export function resolveSidebarDisplayOrder(
  targetGroups: readonly SidebarGroup[],
  heldGroups: readonly SidebarGroup[] | null,
  isPointerInside: boolean,
): readonly SidebarGroup[] {
  if (!isPointerInside || heldGroups === null) return targetGroups;
  if (!sameGroupKeys(heldGroups, targetGroups) || !samePaneMembership(heldGroups, targetGroups)) {
    return targetGroups;
  }

  const targetByKey = new Map(targetGroups.map((group) => [group.key, group] as const));
  return heldGroups.map((group) => projectFreshGroup(group, targetByKey.get(group.key)));
}
