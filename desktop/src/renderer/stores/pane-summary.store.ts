import { create } from 'zustand';
import type { PaneSummary } from '../../shared/pane-summary-types';
import {
  generatePaneSummaryRecap,
  generatePaneSummaryRecapMany,
  loadAllPaneSummaries,
  refreshPaneSummariesMany,
  refreshPaneSummary,
} from '../api/pane-summary.api';

const TTL_MS = 10 * 60 * 1000;

interface PaneSummaryState {
  summaries: Record<string, PaneSummary>;
  refreshingIds: Set<string>;
  recapInFlightIds: Set<string>;
  lastRefreshAllAt: number | null;
  lastSummarizeAllAt: number | null;
  hydrated: boolean;
}

interface PaneSummaryActions {
  hydrate: () => Promise<void>;
  refreshOne: (paneId: string, force: boolean) => Promise<void>;
  refreshAll: (paneIds: string[], force: boolean) => Promise<void>;
  generateRecapOne: (paneId: string, force: boolean) => Promise<void>;
  generateRecapAll: (paneIds: string[], force: boolean) => Promise<void>;
  applyUpdate: (summary: PaneSummary) => void;
  applyRemove: (paneId: string) => void;
  /** Drop all renderer-side state. Called when the active project changes. */
  reset: () => void;
}

export const usePaneSummaryStore = create<PaneSummaryState & PaneSummaryActions>((set, get) => ({
  summaries: {},
  refreshingIds: new Set<string>(),
  recapInFlightIds: new Set<string>(),
  lastRefreshAllAt: null,
  lastSummarizeAllAt: null,
  hydrated: false,

  hydrate: async () => {
    const items = await loadAllPaneSummaries();
    const map: Record<string, PaneSummary> = {};
    for (const item of items) {
      map[item.paneId] = item.generatedAt && Date.now() - item.generatedAt > TTL_MS
        ? { ...item, status: 'stale' }
        : item;
    }
    set({ summaries: map, hydrated: true });
  },

  refreshOne: async (paneId, force) => {
    const refreshing = new Set(get().refreshingIds);
    if (refreshing.has(paneId)) return;
    refreshing.add(paneId);
    set({ refreshingIds: refreshing });
    try {
      const res = await refreshPaneSummary(paneId, force);
      if (res.summary) get().applyUpdate(res.summary);
    } finally {
      const next = new Set(get().refreshingIds);
      next.delete(paneId);
      set({ refreshingIds: next });
    }
  },

  refreshAll: async (paneIds, force) => {
    const refreshing = new Set(get().refreshingIds);
    for (const id of paneIds) refreshing.add(id);
    set({ refreshingIds: refreshing, lastRefreshAllAt: Date.now() });
    try {
      const res = await refreshPaneSummariesMany(paneIds, force);
      if ('summaries' in res) {
        for (const s of res.summaries) get().applyUpdate(s);
      }
    } finally {
      const next = new Set(get().refreshingIds);
      for (const id of paneIds) next.delete(id);
      set({ refreshingIds: next });
    }
  },

  generateRecapOne: async (paneId, force) => {
    const inFlight = new Set(get().recapInFlightIds);
    if (inFlight.has(paneId)) return;
    inFlight.add(paneId);
    set({ recapInFlightIds: inFlight });
    try {
      const res = await generatePaneSummaryRecap(paneId, force);
      if (res.summary) get().applyUpdate(res.summary);
    } finally {
      const next = new Set(get().recapInFlightIds);
      next.delete(paneId);
      set({ recapInFlightIds: next });
    }
  },

  generateRecapAll: async (paneIds, force) => {
    const inFlight = new Set(get().recapInFlightIds);
    for (const id of paneIds) inFlight.add(id);
    set({ recapInFlightIds: inFlight, lastSummarizeAllAt: Date.now() });
    try {
      const res = await generatePaneSummaryRecapMany(paneIds, force);
      if ('summaries' in res) {
        for (const s of res.summaries) get().applyUpdate(s);
      }
    } finally {
      const next = new Set(get().recapInFlightIds);
      for (const id of paneIds) next.delete(id);
      set({ recapInFlightIds: next });
    }
  },

  applyUpdate: (summary) =>
    set((s) => ({ summaries: { ...s.summaries, [summary.paneId]: summary } })),

  applyRemove: (paneId) =>
    set((s) => {
      if (!(paneId in s.summaries)) return s;
      const { [paneId]: _, ...rest } = s.summaries;
      return { summaries: rest };
    }),

  reset: () =>
    set({
      summaries: {},
      refreshingIds: new Set<string>(),
      recapInFlightIds: new Set<string>(),
      lastRefreshAllAt: null,
      lastSummarizeAllAt: null,
      hydrated: false,
    }),
}));
