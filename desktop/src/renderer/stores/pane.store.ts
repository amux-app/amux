import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { AumxPane, AgentName } from 'aumx/core';
import type { PaneActivityState } from '../../shared/pane-activity';
import { usePaneActivityStore } from './pane-activity.store';

export type LaunchMode = 'single' | 'duel';

export interface PendingPane {
  agent: AgentName;
  prompt: string;
  targetPaneId?: string;
}

interface PaneState {
  panes: AumxPane[];
  loaded: boolean;
  selectedPaneId: string | null;
  isCreating: boolean;
  createMode: LaunchMode;
  pendingPane: PendingPane | null;
}

interface PaneActions {
  setPanes: (panes: AumxPane[]) => void;
  selectPane: (id: string | null) => void;
  /** Temporary source-compatibility action; activity remains in its own store. */
  updatePaneStatus: (paneId: string, status: PaneActivityState) => void;
  setCreating: (creating: boolean, mode?: LaunchMode) => void;
  setPendingPane: (pending: PendingPane | null) => void;
  addPane: (pane: AumxPane) => void;
  removePane: (paneId: string) => void;
}

interface PaneStats {
  active: number;
  total: number;
  worktrees: number;
}

interface PaneKeyboardSnapshot {
  paneIds: string[];
  selectedPaneId: string | null;
  selectedTmuxPaneId: string | null;
}

function samePaneFields(a: AumxPane, b: AumxPane): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof AumxPane>;
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function mergePaneRuntimeFields(existing: AumxPane | undefined, incoming: AumxPane): AumxPane {
  if (!existing) return incoming;

  const merged: AumxPane = {
    ...incoming,
    terminalTranscriptPath: incoming.terminalTranscriptPath ?? existing.terminalTranscriptPath,
    review: incoming.review ?? existing.review,
  };

  return samePaneFields(merged, existing) ? existing : merged;
}

function preserveListIdentity(existing: AumxPane[], next: AumxPane[]): AumxPane[] {
  if (next.length !== existing.length) return next;
  return next.every((pane, index) => pane === existing[index]) ? existing : next;
}

export const usePaneStore = create<PaneState & PaneActions>((set) => ({
  panes: [],
  loaded: false,
  selectedPaneId: null,
  isCreating: false,
  createMode: 'single',
  pendingPane: null,

  setPanes: (panes) =>
    set((state) => {
      const byId = new Map(state.panes.map((pane) => [pane.id, pane]));
      const pendingResolved = !!state.pendingPane && (
        state.pendingPane.targetPaneId
          ? panes.some((pane) => pane.id === state.pendingPane!.targetPaneId)
          : panes.some((pane) => !byId.has(pane.id))
      );
      const merged = panes.map((incoming) => mergePaneRuntimeFields(byId.get(incoming.id), incoming));
      return {
        panes: preserveListIdentity(state.panes, merged),
        loaded: true,
        pendingPane: pendingResolved ? null : state.pendingPane,
      };
    }),

  selectPane: (id) =>
    set({ selectedPaneId: id }),

  updatePaneStatus: (paneId, status) => {
    const current = usePaneActivityStore.getState().activityByPaneId[paneId];
    const next = current ?? {
      activityRevision: 0,
      adapterHealth: 'degraded' as const,
      certainty: 'provisional' as const,
      liveness: 'unknown' as const,
      openBackgroundWork: [],
      origin: 'none' as const,
      paneIncarnationId: `compat-${paneId}`,
      sinceWallMs: Date.now(),
      state: 'unknown' as const,
    };
    usePaneActivityStore.setState((store) => {
      const justFinishedPaneIds = new Set(store.justFinishedPaneIds);
      if (current?.state === 'working' && status === 'idle') justFinishedPaneIds.add(paneId);
      if (status !== 'idle') justFinishedPaneIds.delete(paneId);
      return {
        activityByPaneId: { ...store.activityByPaneId, [paneId]: { ...next, state: status } },
        justFinishedPaneIds,
      };
    });
  },

  setCreating: (isCreating, createMode = 'single') => set({ isCreating, createMode }),

  setPendingPane: (pendingPane) => set({ pendingPane }),

  addPane: (pane) =>
    set((state) => ({
      panes: [...state.panes, pane],
    })),

  removePane: (paneId) =>
    set((state) => ({
      panes: state.panes.filter((p) => p.id !== paneId),
      selectedPaneId: state.selectedPaneId === paneId ? null : state.selectedPaneId,
    })),
}));

export function useFirstPaneId(): string | null {
  return usePaneStore((state) => state.panes[0]?.id ?? null);
}

export function usePaneById(paneId: string | null | undefined): AumxPane | null {
  return usePaneStore((state) => (
    paneId ? state.panes.find((pane) => pane.id === paneId) ?? null : null
  ));
}

export function usePaneStats(): PaneStats {
  const panes = usePaneStore((state) => state.panes);
  const activityByPaneId = usePaneActivityStore((state) => state.activityByPaneId);
  return useMemoPaneStats(panes, activityByPaneId);
}

function useMemoPaneStats(panes: AumxPane[], activityByPaneId: Record<string, { state: string }>): PaneStats {
  let active = 0;
  let worktrees = 0;

  for (const pane of panes) {
    if (pane.type !== 'shell') {
      worktrees++;
    }
    if (activityByPaneId[pane.id]?.state === 'working') {
      active++;
    }
  }

  return {
    active,
    total: panes.length,
    worktrees,
  };
}

export function useSelectedPane(): AumxPane | null {
  return usePaneStore((state) => {
    const selectedPaneId = state.selectedPaneId;
    return selectedPaneId
      ? state.panes.find((pane) => pane.id === selectedPaneId) ?? null
      : null;
  });
}

export function usePaneKeyboardSnapshot(): PaneKeyboardSnapshot {
  const paneIds = usePaneStore(useShallow((state) => state.panes.map((pane) => pane.id)));
  const selected = usePaneStore(useShallow((state) => {
    const selectedPane = state.selectedPaneId
      ? state.panes.find((pane) => pane.id === state.selectedPaneId)
      : null;

    return {
      selectedPaneId: state.selectedPaneId,
      selectedTmuxPaneId: selectedPane?.paneId ?? null,
    };
  }));

  return {
    paneIds,
    ...selected,
  };
}
