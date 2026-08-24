import type { BacklogItem } from '../../shared/kanban-types';

const PANE_PREFIX = 'pane-';
const LAUNCHING_PREFIX = 'launching-';

export function paneCardId(paneId: string): string {
  return `${PANE_PREFIX}${paneId}`;
}

export function launchingCardId(itemId: string): string {
  return `${LAUNCHING_PREFIX}${itemId}`;
}

export function paneIdFromCardId(cardId: string | null): string | null {
  if (!cardId?.startsWith(PANE_PREFIX)) return null;
  const id = cardId.slice(PANE_PREFIX.length);
  return id || null;
}

export function launchingItemIdFromCardId(cardId: string | null): string | null {
  if (!cardId?.startsWith(LAUNCHING_PREFIX)) return null;
  const id = cardId.slice(LAUNCHING_PREFIX.length);
  return id || null;
}

export function resolveLaunchingItem(
  cardId: string | null,
  launchingItems: BacklogItem[],
): BacklogItem | null {
  const launchingId = launchingItemIdFromCardId(cardId);
  if (!launchingId) return null;
  return launchingItems.find((item) => item.id === launchingId) ?? null;
}

export function clearSelectionIfLaunching(
  currentSelection: string | null,
  launchingItemIds: string[],
): string | null {
  const selectedLaunchingId = launchingItemIdFromCardId(currentSelection);
  if (!selectedLaunchingId) return currentSelection;
  return launchingItemIds.includes(selectedLaunchingId) ? null : currentSelection;
}
