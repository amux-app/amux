import type {
  DetectedPlugin,
  InstalledPlugin,
  MarketplaceErrorCode,
  MarketplaceInstallMode,
  MarketplaceSource,
} from 'muxbase/core';
import { create } from 'zustand';
import * as marketplaceApi from '../api/marketplace.api';

const toErrorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

function marketplaceFailureMessage(
  response: { error?: string; errorCode?: MarketplaceErrorCode },
  fallback: string,
): string {
  const detail = response.error ?? fallback;
  return response.errorCode === 'INVALID_SOURCE_TREE'
    ? `Marketplace source is invalid or unsafe: ${detail}`
    : detail;
}

/** Sidebar tree + Settings filter tabs share this — one id per DetectedPlugin artifact bucket. */
export type MarketplaceFilter = 'all' | 'skills' | 'agents' | 'hooks' | 'mcp' | 'plugins';

export interface MarketplaceCounts {
  skills: number;
  agents: number;
  hooks: number;
  mcpServers: number;
  jsPlugins: number;
}

/** Live inventory across every added source, browsed or not — matches what the sidebar tree and the Settings tab counts both show. */
export function aggregateMarketplaceCounts(browsedPlugins: Record<string, DetectedPlugin[]>): MarketplaceCounts {
  const counts: MarketplaceCounts = { skills: 0, agents: 0, hooks: 0, mcpServers: 0, jsPlugins: 0 };
  for (const plugins of Object.values(browsedPlugins)) {
    for (const plugin of plugins) {
      counts.skills += plugin.skills.length;
      counts.agents += plugin.agents.length;
      counts.hooks += plugin.hooks.length;
      counts.mcpServers += plugin.mcpServers.length;
      counts.jsPlugins += plugin.jsPlugins.length;
    }
  }
  return counts;
}

interface MarketplaceState {
  sources: MarketplaceSource[];
  installedPlugins: InstalledPlugin[];
  browsedPlugins: Record<string, DetectedPlugin[]>;
  isLoading: boolean;
  installingPlugin: string | null;
  error: string | null;
  activeFilter: MarketplaceFilter;
}

interface MarketplaceActions {
  loadSources: () => Promise<void>;
  addSource: (url: string) => Promise<boolean>;
  removeSource: (url: string) => Promise<void>;
  updateSource: (url: string) => Promise<void>;
  browseSource: (sourceUrl: string) => Promise<void>;
  installPlugin: (pluginId: string, sourceUrl: string, mode?: MarketplaceInstallMode, selectedSkills?: string[], selectedMcpServers?: string[], selectedAgents?: string[], previewDigest?: string) => Promise<boolean>;
  previewPlugin: (pluginId: string, sourceUrl: string, mode?: MarketplaceInstallMode, selectedSkills?: string[], selectedMcpServers?: string[], selectedAgents?: string[]) => Promise<Awaited<ReturnType<typeof marketplaceApi.previewPlugin>>>;
  uninstallPlugin: (pluginId: string, sourceUrl: string) => Promise<void>;
  loadInstalled: () => Promise<void>;
  clearError: () => void;
  setActiveFilter: (filter: MarketplaceFilter) => void;
}

export const useMarketplaceStore = create<MarketplaceState & MarketplaceActions>((set, get) => ({
  sources: [],
  installedPlugins: [],
  browsedPlugins: {},
  isLoading: false,
  installingPlugin: null,
  error: null,
  activeFilter: 'all',

  loadSources: async () => {
    set({ isLoading: true });
    try {
      const sources = await marketplaceApi.listSources();
      set({ sources });
    } catch (error) {
      set({ error: toErrorMessage(error) });
    } finally {
      set({ isLoading: false });
    }
  },

  addSource: async (url) => {
    set({ error: null });
    try {
      const response = await marketplaceApi.addSource(url);
      if (response.success && response.source) {
        set((state) => ({ sources: [response.source!, ...state.sources] }));
        return true;
      }
      set({ error: response.error ?? 'Failed to add source' });
      return false;
    } catch (error) {
      set({ error: toErrorMessage(error) });
      return false;
    }
  },

  removeSource: async (url) => {
    const response = await marketplaceApi.removeSource(url);
    if (!response.success) {
      set({ error: response.error ?? 'Failed to remove source' });
      return;
    }
    set((state) => ({
      sources: state.sources.filter((s) => s.url !== url),
      browsedPlugins: Object.fromEntries(
        Object.entries(state.browsedPlugins).filter(([key]) => key !== url),
      ),
    }));
  },

  updateSource: async (url) => {
    try {
      const response = await marketplaceApi.updateSource(url);
      if (response.success) {
        await get().loadSources();
      } else {
        set({ error: response.error ?? 'Failed to update source' });
      }
    } catch (error) {
      set({ error: toErrorMessage(error) });
    }
  },

  browseSource: async (sourceUrl) => {
    try {
      const response = await marketplaceApi.browseSource(sourceUrl);
      // Always mark as loaded (even empty) so we don't retry on every render.
      // Response-level errors are per-source — don't overwrite the global error.
      set((state) => ({
        browsedPlugins: { ...state.browsedPlugins, [sourceUrl]: response.plugins },
      }));
    } catch (error) {
      // Mark as loaded with empty list so the UI stops showing a spinner.
      set((state) => ({
        browsedPlugins: { ...state.browsedPlugins, [sourceUrl]: [] },
        error: toErrorMessage(error),
      }));
    }
  },

  installPlugin: async (pluginId, sourceUrl, mode = 'selected', selectedSkills, selectedMcpServers, selectedAgents, previewDigest) => {
    set({ installingPlugin: pluginId, error: null });
    try {
      const response = await marketplaceApi.installPlugin(pluginId, sourceUrl, mode, selectedSkills, selectedMcpServers, selectedAgents, previewDigest);
      if (response.success) {
        await get().loadInstalled();
        return true;
      }
      set({ error: marketplaceFailureMessage(response, 'Failed to install plugin') });
      return false;
    } catch (error) {
      set({ error: toErrorMessage(error) });
      return false;
    } finally {
      set({ installingPlugin: null });
    }
  },

  previewPlugin: async (pluginId, sourceUrl, mode = 'selected', selectedSkills, selectedMcpServers, selectedAgents) => {
    try {
      const response = await marketplaceApi.previewPlugin(pluginId, sourceUrl, mode, selectedSkills, selectedMcpServers, selectedAgents);
      if (!response.success) {
        set({ error: marketplaceFailureMessage(response, 'Failed to preview plugin installation') });
      }
      return response;
    } catch (error) {
      const message = toErrorMessage(error);
      set({ error: message });
      return { success: false, error: message };
    }
  },

  uninstallPlugin: async (pluginId, sourceUrl) => {
    set({ error: null });
    try {
      const response = await marketplaceApi.uninstallPlugin(pluginId, sourceUrl);
      if (!response.success) {
        set({ error: response.error ?? 'Failed to uninstall plugin' });
        return;
      }
      await get().loadInstalled();
      if (response.preservedArtifacts && response.preservedArtifacts.length > 0) {
        set({
          error: `Plugin uninstalled, but modified artifacts were preserved: ${response.preservedArtifacts.join(', ')}`,
        });
        return;
      }
      // Auto-remove the source when no installed plugins remain from it.
      const remaining = get().installedPlugins.filter((i) => i.sourceUrl === sourceUrl);
      if (remaining.length === 0) {
        await marketplaceApi.removeSource(sourceUrl);
        set((state) => ({
          sources: state.sources.filter((s) => s.url !== sourceUrl),
          browsedPlugins: Object.fromEntries(
            Object.entries(state.browsedPlugins).filter(([k]) => k !== sourceUrl),
          ),
        }));
      }
    } catch (error) {
      set({ error: toErrorMessage(error) });
    }
  },

  loadInstalled: async () => {
    try {
      const installed = await marketplaceApi.listInstalled();
      set({ installedPlugins: installed });
    } catch (error) {
      set({ error: toErrorMessage(error) });
    }
  },

  clearError: () => set({ error: null }),

  setActiveFilter: (activeFilter) => set({ activeFilter }),
}));
