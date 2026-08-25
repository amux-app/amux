import type { MuxBasePane } from 'muxbase/core';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Group, Panel, Separator } from 'react-resizable-panels';
import {
  MIN_FLEET_PANE_WIDTH_PX,
  MIN_FLEET_ROW_COMPRESSED_HEIGHT_PX,
  compactFleetPaneSlots,
  getFirstAvailableFleetSlot,
  getFleetLayoutMinHeight,
  getFleetRowMinHeight,
  useResponsivePanelLayout,
  useStableFleetPaneSlots,
} from '../../hooks/usePanelLayout';
import { useViewportVisibility } from '../../hooks/useViewportVisibility';
import type { PendingPane } from '../../stores';
import { useHiddenPanesStore, usePaneStore, useUiStore } from '../../stores';
import { resolveDuelPair } from '../../lib/duel-pair';
import { formatAgentLabel } from '../../lib/formatters';
import { EmptyState } from '../shared/EmptyState';
import { HoverTooltip } from '../shared/HoverTooltip';
import { PaneCell } from './PaneCell';

function SpawningCell({ pending }: { pending: PendingPane }) {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const t1 = setTimeout(() => setPhase(1), 1500);
    const t2 = setTimeout(() => setPhase(2), 3500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  const agentLabel = formatAgentLabel(pending.agent);
  const phaseText =
    phase === 0 ? 'Creating worktree...'
    : phase === 1 ? 'Spawning tmux pane...'
    : `Launching ${agentLabel}...`;

  return (
    <div
      aria-atomic="true"
      aria-label={`${agentLabel}: ${phaseText}`}
      aria-live="polite"
      className="h-full w-full flex flex-col bg-[var(--bg)]"
      role="status"
    >
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border)] min-h-[32px]">
        <span
          className="block w-2 h-2 rounded-full bg-[var(--accent)] animate-[pulse-dot_1.5s_ease-in-out_infinite] motion-reduce:animate-none"
        />
        <span className="text-xs font-medium text-[var(--text-secondary)] truncate">
          {agentLabel}
        </span>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center min-h-0">
        <div className="relative mb-5" style={{ width: 48, height: 48 }}>
          <div
            className="absolute inset-0 rounded-full border-2 border-transparent animate-spin motion-reduce:animate-none"
            style={{ borderTopColor: 'var(--accent)', animationDuration: '1.2s' }}
          />
          <div
            className="absolute rounded-full border-2 border-transparent animate-spin motion-reduce:animate-none"
            style={{ inset: 6, borderTopColor: 'var(--text-secondary)', animationDuration: '2s', animationDirection: 'reverse' }}
          />
        </div>

        <div className="text-sm font-medium text-[var(--text)]">{agentLabel}</div>
        <div className="mt-1 text-xs text-[var(--text-secondary)]">{phaseText}</div>

        <div className="mt-4 h-[2px] w-40 overflow-hidden rounded-full bg-[var(--surface-raised)]">
          <div
            className="h-full w-1/3 rounded-full animate-[boot-shimmer_1.8s_ease-in-out_infinite] motion-reduce:animate-none"
            style={{
              background: 'linear-gradient(90deg, transparent, var(--accent), transparent)',
            }}
          />
        </div>
      </div>
    </div>
  );
}

interface FleetPaneSlot {
  key: string;
  pane?: MuxBasePane;
  pendingPane?: PendingPane;
  slotIndex: number;
}

interface FleetPanePairModel {
  duelGroupId?: string;
  key: string;
  orderKey: number;
  slots: FleetPaneSlot[];
}

function buildFleetSlots(
  panes: MuxBasePane[],
  pendingPane: PendingPane | null,
  slotsByPaneId: ReadonlyMap<string, number>,
): FleetPaneSlot[] {
  const slots = panes.map((pane): FleetPaneSlot => {
    const slotIndex = slotsByPaneId.get(pane.id);
    if (slotIndex === undefined) {
      throw new Error(`Missing Fleet slot for pane ${pane.id}`);
    }
    return { key: pane.id, pane, slotIndex };
  });
  if (pendingPane) {
    slots.push({
      key: '__pending',
      pendingPane,
      slotIndex: getFirstAvailableFleetSlot(slotsByPaneId),
    });
  }
  return slots;
}

function extractDuelPairs(slots: FleetPaneSlot[]): {
  duelPairs: FleetPanePairModel[];
  remaining: FleetPaneSlot[];
} {
  const byGroup = new Map<string, FleetPaneSlot[]>();
  for (const slot of slots) {
    const groupId = slot.pane?.duel?.groupId;
    if (!groupId) continue;
    const members = byGroup.get(groupId) ?? [];
    members.push(slot);
    byGroup.set(groupId, members);
  }

  const pairedKeys = new Set<string>();
  const duelPairs: FleetPanePairModel[] = [];
  for (const [groupId, members] of byGroup) {
    const pair = resolveDuelPair(
      members.flatMap((member) => member.pane ? [member.pane] : []),
      groupId,
    );
    if (!pair) continue;
    const slotsById = new Map(members.map((member) => [member.pane?.id, member]));
    const ordered = pair.map((pane) => slotsById.get(pane.id)).filter(
      (member): member is FleetPaneSlot => member !== undefined,
    );
    if (ordered.length !== 2) continue;
    for (const member of ordered) pairedKeys.add(member.key);
    duelPairs.push({
      duelGroupId: groupId,
      key: `duel-${groupId}`,
      orderKey: Math.min(...ordered.map((member) => member.slotIndex)),
      slots: ordered,
    });
  }

  return { duelPairs, remaining: slots.filter((slot) => !pairedKeys.has(slot.key)) };
}

function buildPositionalPairs(remaining: FleetPaneSlot[]): FleetPanePairModel[] {
  const byPair = new Map<number, FleetPaneSlot[]>();
  for (const slot of remaining) {
    const pairIndex = Math.floor(slot.slotIndex / 2);
    const pair = byPair.get(pairIndex) ?? [];
    pair.push(slot);
    byPair.set(pairIndex, pair);
  }
  return Array.from(byPair, ([pairIndex, pairSlots]) => ({
    key: `pos-${pairIndex}`,
    orderKey: Math.min(...pairSlots.map((slot) => slot.slotIndex)),
    slots: pairSlots.sort((left, right) => left.slotIndex - right.slotIndex),
  }));
}

function buildFleetPanePairs(
  panes: MuxBasePane[],
  pendingPane: PendingPane | null,
  slotsByPaneId: ReadonlyMap<string, number>,
): FleetPanePairModel[] {
  const slots = buildFleetSlots(panes, pendingPane, slotsByPaneId);
  const { duelPairs, remaining } = extractDuelPairs(slots);
  const pairs = [...duelPairs, ...buildPositionalPairs(remaining)];
  return pairs.sort((left, right) => left.orderKey - right.orderKey);
}

function StableFleetPaneContent({ slot }: { slot: FleetPaneSlot }) {
  const [host] = useState(() => {
    const element = document.createElement('div');
    element.className = 'h-full w-full min-h-0 min-w-0';
    return element;
  });
  // React runs the layout append below before the hook's passive observer
  // effect, so IntersectionObserver always receives an attached host.
  const viewportVisible = useViewportVisibility(host);

  useLayoutEffect(() => () => host.remove(), [host]);

  useLayoutEffect(() => {
    const target = document.getElementById(`fleet-pane-content-${slot.key}`);
    if (target && host.parentElement !== target) target.append(host);
  });

  if (slot.pane) {
    return createPortal(
      <PaneCell pane={slot.pane} viewportVisible={viewportVisible} />,
      host,
    );
  }
  if (slot.pendingPane) return createPortal(<SpawningCell pending={slot.pendingPane} />, host);
  return null;
}

function DuelVsChip({
  groupId,
  offsetPercent,
  orientation,
}: {
  groupId: string;
  offsetPercent: number;
  orientation: 'horizontal' | 'vertical';
}) {
  const position = orientation === 'horizontal'
    ? { left: `${offsetPercent}%`, top: '50%' }
    : { left: '50%', top: `${offsetPercent}%` };

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      <div className="absolute -translate-x-1/2 -translate-y-1/2" style={position}>
        <HoverTooltip label="Open duel view" className="pointer-events-auto flex items-center justify-center">
          <button
            type="button"
            aria-label="Open duel view"
            data-testid="fleet-duel-vs-chip"
            onClick={() => useUiStore.getState().openDuel(groupId)}
            className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--divider-strong)] bg-[var(--surface-raised)] text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] shadow-lg transition-transform hover:scale-110"
            style={{ backgroundImage: 'linear-gradient(135deg, rgb(99 102 241 / 0.25), rgb(20 184 166 / 0.25))' }}
          >
            vs
          </button>
        </HoverTooltip>
      </div>
    </div>
  );
}

function FleetPanePair({
  columnCount,
  pair,
}: {
  columnCount: number;
  pair: FleetPanePairModel;
}) {
  const orientation = columnCount === 2 ? 'horizontal' : 'vertical';
  const paneMinimum = pair.slots.length > 1
    ? orientation === 'horizontal'
      ? `${MIN_FLEET_PANE_WIDTH_PX}px`
      : `${MIN_FLEET_ROW_COMPRESSED_HEIGHT_PX}px`
    : 10;
  const showDuelChip = Boolean(pair.duelGroupId) && pair.slots.length > 1;
  const [splitPercent, setSplitPercent] = useState(50);

  return (
    <div className="relative h-full w-full">
      <Group id={`fleet-pair-${pair.key}`} orientation={orientation}>
        {pair.slots.map((slot, index) => (
          <Fragment key={slot.key}>
            {index > 0 && (
              <Separator
                className="muxbase-resize-handle"
                data-fleet-pane-separator="true"
                data-testid={`fleet-pane-separator-${pair.key}`}
                id={`fleet-pane-separator-${pair.key}`}
              />
            )}
            <Panel
              id={`fleet-pane-${slot.key}`}
              minSize={paneMinimum}
              onResize={showDuelChip && index === 0
                ? (size) => setSplitPercent(size.asPercentage)
                : undefined}
            >
              <div id={`fleet-pane-content-${slot.key}`} className="h-full w-full min-h-0 min-w-0" />
            </Panel>
          </Fragment>
        ))}
      </Group>
      {showDuelChip && pair.duelGroupId && (
        <DuelVsChip groupId={pair.duelGroupId} offsetPercent={splitPercent} orientation={orientation} />
      )}
    </div>
  );
}

function StableFleetLayout({
  columnCount,
  pairs,
}: {
  columnCount: number;
  pairs: FleetPanePairModel[];
}) {
  const slots = pairs.flatMap((pair) => pair.slots);
  const rowDefaultSize = `${100 / pairs.length}%`;

  return (
    <>
      {slots.map((slot) => <StableFleetPaneContent key={slot.key} slot={slot} />)}
      <Group id="fleet-root" orientation="vertical">
        {pairs.map((pair, visiblePairIndex) => {
          const pairMinHeight = columnCount === 1
            ? getFleetRowMinHeight(pair.slots.length)
            : MIN_FLEET_ROW_COMPRESSED_HEIGHT_PX;
          return (
            <Fragment key={`row-${pair.key}`}>
              {visiblePairIndex > 0 && (
                <Separator
                  className="muxbase-resize-handle"
                  data-fleet-row-separator="true"
                  data-testid={`fleet-row-separator-${pair.key}`}
                  id={`fleet-row-separator-${pair.key}`}
                />
              )}
              <Panel
                defaultSize={rowDefaultSize}
                id={`fleet-row-${pair.key}`}
                minSize={`${pairMinHeight}px`}
              >
                <FleetPanePair
                  columnCount={columnCount}
                  pair={pair}
                />
              </Panel>
            </Fragment>
          );
        })}
      </Group>
    </>
  );
}

export function PaneTerminalGrid() {
  const containerRef = useRef<HTMLDivElement>(null);
  const allPanes = usePaneStore((s) => s.panes);
  const pendingPane = usePaneStore((s) => s.pendingPane);
  const setCreating = usePaneStore((s) => s.setCreating);
  const hiddenPaneIds = useHiddenPanesStore((s) => s.hiddenPaneIds);
  const panes = allPanes.filter((p) => !hiddenPaneIds.has(p.id));
  const totalCount = panes.length + (pendingPane ? 1 : 0);
  const stableSlotsByPaneId = useStableFleetPaneSlots(allPanes.map((pane) => pane.id));
  const slotsByPaneId = compactFleetPaneSlots(
    panes.map((pane) => pane.id),
    stableSlotsByPaneId,
  );
  const { columnCount } = useResponsivePanelLayout(totalCount, containerRef);
  const pairs = buildFleetPanePairs(panes, pendingPane, slotsByPaneId);
  const rowCount = columnCount === 2 ? pairs.length : totalCount;
  const minHeight = getFleetLayoutMinHeight(rowCount, 1);

  if (totalCount === 0) {
    if (allPanes.length > 0) {
      return (
        <div className="flex items-center justify-center h-full">
          <EmptyState
            title="All panes minimized"
            description="Click an agent in the sidebar to restore it."
          />
        </div>
      );
    }
    return (
      <div className="flex items-center justify-center h-full">
        <EmptyState
          title="No panes yet"
          description="Create a new pane to get started."
          action="New Pane"
          onAction={() => setCreating(true)}
        />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-full w-full min-w-0 overflow-y-auto"
      data-fleet-column-count={columnCount}
      data-fleet-row-count={rowCount}
      data-fleet-scroll-root="true"
    >
      <div className="h-full min-w-0" style={{ minHeight: `${minHeight}px` }}>
        <StableFleetLayout columnCount={columnCount} pairs={pairs} />
      </div>
    </div>
  );
}
