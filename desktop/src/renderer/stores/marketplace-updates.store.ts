import type { NewArtifact, SourceArtifactSnapshot, SourceUpdate } from 'muxbase/core';
import { create } from 'zustand';
import type { MarketplacePreviewRequest } from '../../shared/ipc-types';
import * as marketplaceApi from '../api/marketplace.api';
import { useMarketplaceStore } from './marketplace.store';

interface MarketplaceUpdatesState {
  updates: SourceUpdate[];
  // Snapshot per sourceUrl from the last check — passed back to the main process
  // via ackUpdates so lastSeenArtifacts only advances after the user acts.
  snapshots: Record<string, SourceArtifactSnapshot>;
  checking: boolean;
  // Keyed by `${sourceUrl}::${pluginId}` while an install for that plugin is in flight.
  installing: Set<string>;
}

interface MarketplaceUpdatesActions {
  // Fetches updates from the main process; no-ops if a check is already in flight.
  check: () => Promise<void>;
  // Installs the given subset of a plugin's new/updated artifacts. Installed items are
  // dropped from the list; the card disappears once empty.
  installUpdate: (update: SourceUpdate, selected: NewArtifact[]) => Promise<void>;
  // Clears all surfaced updates from view (does not touch the on-disk snapshot).
  dismissAll: () => void;
}

const key = (sourceUrl: string, pluginId: string) => `${sourceUrl}::${pluginId}`;

export const useMarketplaceUpdatesStore = create<MarketplaceUpdatesState & MarketplaceUpdatesActions>((set, get) => ({
  updates: [],
  snapshots: {},
  checking: false,
  installing: new Set(),

  check: async () => {
    if (get().checking) return;
    set({ checking: true });
    try {
      const response = await marketplaceApi.checkUpdates();
      if (response.updates.length > 0) {
        set({ updates: response.updates, snapshots: response.snapshots });
      }
    } catch {
      // Silent — an update check is a background nicety, not a user-initiated action.
    } finally {
      set({ checking: false });
    }
  },

  installUpdate: async (update, selected) => {
    if (selected.length === 0) return;
    const k = key(update.sourceUrl, update.pluginId);
    set((state) => ({ installing: new Set(state.installing).add(k) }));

    const selectedSkills = selected.filter((a) => a.type === 'skill').map((a) => a.name);
    const selectedMcpServers = selected.filter((a) => a.type === 'mcpServer').map((a) => a.name);
    const selectedAgents = selected.filter((a) => a.type === 'agent').map((a) => a.name);
    const selectedHooks = selected.filter((a) => a.type === 'hook').map((a) => a.name);
    const selectedJsPlugins = selected.filter((a) => a.type === 'jsPlugin').map((a) => a.name);

    // Reuse the marketplace store's installer so the installed-plugins list stays in sync.
    // The store's install requires a preview digest, so preview first to obtain one.
    const store = useMarketplaceStore.getState();
    const previewRequest: MarketplacePreviewRequest = {
      pluginId: update.pluginId,
      sourceUrl: update.sourceUrl,
      mode: 'selected',
      selectedSkills,
      selectedMcpServers,
      selectedAgents,
      selectedHooks,
      selectedJsPlugins,
    };
    const preview = await store.previewPlugin(previewRequest);
    const ok = preview.success && preview.preview
      ? await store.installPlugin({ ...previewRequest, previewDigest: preview.preview.digest })
      : false;

    set((state) => {
      const installing = new Set(state.installing);
      installing.delete(k);
      if (!ok) return { installing };

      // Drop the installed items from the card; remove the whole card once empty.
      const installedNames = new Set(selected.map((a) => `${a.type}:${a.name}`));
      const updates = state.updates.flatMap((u) => {
        if (u.sourceUrl !== update.sourceUrl || u.pluginId !== update.pluginId) return [u];
        const remaining = u.newArtifacts.filter((a) => !installedNames.has(`${a.type}:${a.name}`));
        return remaining.length > 0 ? [{ ...u, newArtifacts: remaining }] : [];
      });

      // Advance the snapshot for this source now that at least one item was installed.
      const snapshot = state.snapshots[update.sourceUrl];
      if (snapshot) {
        void marketplaceApi.ackUpdates({ entries: [{ sourceUrl: update.sourceUrl, snapshot }] });
      }

      return { installing, updates };
    });
  },

  dismissAll: () => {
    const { updates, snapshots } = get();
    // Advance snapshots for all sources that had visible updates.
    const seen = new Set<string>();
    const entries = updates
      .filter((u) => {
        if (seen.has(u.sourceUrl)) return false;
        seen.add(u.sourceUrl);
        return u.sourceUrl in snapshots;
      })
      .map((u) => ({ sourceUrl: u.sourceUrl, snapshot: snapshots[u.sourceUrl] }));
    if (entries.length > 0) {
      void marketplaceApi.ackUpdates({ entries });
    }
    set({ updates: [] });
  },
}));
