import { type RefObject, useLayoutEffect, useRef, useState } from 'react';

export const FLEET_RESIZE_HANDLE_PX = 5;
export const MIN_FLEET_PANE_HEIGHT_PX = 220;
export const MIN_FLEET_PANE_WIDTH_PX = 560;
export const MIN_FLEET_ROW_COMPRESSED_HEIGHT_PX = 110;

function getStackedHeight(rowCount: number, rowHeight: number): number {
  if (rowCount <= 0) return 0;
  return (rowCount * rowHeight) + ((rowCount - 1) * FLEET_RESIZE_HANDLE_PX);
}

export function getResponsiveColumnCount(count: number, availableWidth: number): number {
  if (count <= 1 || !Number.isFinite(availableWidth) || availableWidth <= 0) return 1;
  const twoColumnWidth = (MIN_FLEET_PANE_WIDTH_PX * 2) + FLEET_RESIZE_HANDLE_PX;
  return availableWidth >= twoColumnWidth ? 2 : 1;
}

export function getFleetLayoutMinHeight(count: number, columnCount: number): number {
  const normalizedColumns = Math.max(1, Math.floor(columnCount));
  return getStackedHeight(Math.ceil(count / normalizedColumns), MIN_FLEET_PANE_HEIGHT_PX);
}

export function getFleetRowMinHeight(slotCount: number): number {
  return getStackedHeight(slotCount, MIN_FLEET_ROW_COMPRESSED_HEIGHT_PX);
}

function findFirstAvailableFleetSlot(usedSlots: ReadonlySet<number>): number {
  let slot = 0;
  while (usedSlots.has(slot)) slot += 1;
  return slot;
}

export function getFirstAvailableFleetSlot(slotsByPaneId: ReadonlyMap<string, number>): number {
  return findFirstAvailableFleetSlot(new Set(slotsByPaneId.values()));
}

export function compactFleetPaneSlots(
  paneIds: readonly string[],
  stableSlotsByPaneId: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  const orderedPaneIds = [...paneIds].sort((leftId, rightId) => {
    const leftSlot = stableSlotsByPaneId.get(leftId);
    const rightSlot = stableSlotsByPaneId.get(rightId);
    if (leftSlot === undefined || rightSlot === undefined) {
      throw new Error('Cannot compact a Fleet pane without a stable slot');
    }
    return leftSlot - rightSlot;
  });

  return new Map(orderedPaneIds.map((paneId, slotIndex) => [paneId, slotIndex]));
}

function reconcileFleetPaneSlots(
  previous: ReadonlyMap<string, number>,
  paneIds: readonly string[],
): ReadonlyMap<string, number> {
  const livePaneIds = new Set(paneIds);
  const next = new Map(previous);
  let changed = false;

  for (const paneId of previous.keys()) {
    if (livePaneIds.has(paneId)) continue;
    next.delete(paneId);
    changed = true;
  }

  const usedSlots = new Set(next.values());
  let availableSlot = 0;
  for (const paneId of paneIds) {
    if (next.has(paneId)) continue;
    while (usedSlots.has(availableSlot)) availableSlot += 1;
    next.set(paneId, availableSlot);
    usedSlots.add(availableSlot);
    availableSlot += 1;
    changed = true;
  }

  return changed ? next : previous;
}

/**
 * Keeps each live pane's relative order stable across list reorders, sibling
 * removal, and hide/restore cycles. The next render computes an immutable
 * candidate; a layout effect commits it only after React commits that render,
 * so abandoned concurrent renders cannot corrupt slot ownership.
 */
export function useStableFleetPaneSlots(paneIds: readonly string[]): ReadonlyMap<string, number> {
  const committedSlotsRef = useRef<ReadonlyMap<string, number>>(new Map());
  const slots = reconcileFleetPaneSlots(committedSlotsRef.current, paneIds);

  useLayoutEffect(() => {
    committedSlotsRef.current = slots;
  }, [slots]);

  return slots;
}

export function useResponsivePanelLayout(
  paneCount: number,
  containerRef: RefObject<HTMLElement | null>,
): { columnCount: number } {
  const [columnCount, setColumnCount] = useState(1);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateWidth = (width: number) => {
      const normalized = Math.max(0, Math.floor(width));
      const nextColumnCount = getResponsiveColumnCount(paneCount, normalized);
      if (nextColumnCount === columnCount) return;
      setColumnCount(() => nextColumnCount);
    };
    const measure = () => updateWidth(container.getBoundingClientRect().width || container.offsetWidth);
    measure();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === container) ?? entries[0];
      if (entry) updateWidth(entry.contentRect.width);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [columnCount, containerRef, paneCount]);

  return { columnCount };
}
