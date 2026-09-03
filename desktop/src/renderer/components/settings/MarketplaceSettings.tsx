import type {
  MarketplaceInstallIntent,
  MarketplaceInstallRequest,
  MarketplacePreviewRequest,
  MarketplaceRequestIdentity,
} from '../../../shared/ipc-types';
import type { AgentName, DetectedPlugin, InstalledItem, InstalledPlugin } from 'muxbase/core';
import { Plus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '../../lib/cn';
import { useMarketplaceStore, type MarketplaceFilter } from '../../stores/marketplace.store';
import { MarketplacePluginCard } from './MarketplacePluginCard';
import { SourcesRow, type KnownSource } from './MarketplaceSourceControls';
import { Spinner } from '../shared/Spinner';
import { MarketplaceInstalledList } from './MarketplaceInstalledList';
import { MarketplaceUpdatesSection } from './MarketplaceUpdatesSection';
import knownSourcesData from './known-sources.json';
import { IPC } from '../../../shared/ipc-channels';
import { invoke } from '../../api/ipc';

type ViewMode = 'installed' | 'browse';

const FILTER_TABS: { id: MarketplaceFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'skills', label: 'Skills' },
  { id: 'agents', label: 'Instructions' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'plugins', label: 'JS Plugins' },
];

const KNOWN_SOURCES: KnownSource[] = knownSourcesData;

function pluginMatchesFilter(plugin: DetectedPlugin, filter: MarketplaceFilter): boolean {
  switch (filter) {
    case 'mcp': return plugin.mcpServers.length > 0;
    case 'skills': return plugin.skills.length > 0;
    case 'agents': return plugin.agents.length > 0;
    case 'hooks': return plugin.hooks.length > 0;
    case 'plugins': return plugin.jsPlugins.length > 0;
    default: return true;
  }
}

function hasInstallableContent(plugin: DetectedPlugin): boolean {
  return plugin.skills.length > 0
    || plugin.mcpServers.length > 0
    || (plugin.agents?.length ?? 0) > 0
    || plugin.hooks.length > 0
    || plugin.jsPlugins.length > 0;
}

function pluginMatchesSearch(plugin: DetectedPlugin, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return plugin.name.toLowerCase().includes(q) || (plugin.description?.toLowerCase().includes(q) ?? false);
}

// ── Main component

export function MarketplaceSettings() {
  const [searchQuery, setSearchQuery] = useState('');
  const [view, setView] = useState<ViewMode>('browse');
  const [updatingSource, setUpdatingSource] = useState<string | null>(null);
  const [addingUrl, setAddingUrl] = useState<string | null>(null);
  const [availableAgents, setAvailableAgents] = useState<AgentName[]>([]);
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());

  const sources = useMarketplaceStore((s) => s.sources);
  const installedPlugins = useMarketplaceStore((s) => s.installedPlugins);
  const installedItems = useMarketplaceStore((s) => s.installedItems);
  const browsedPlugins = useMarketplaceStore((s) => s.browsedPlugins);
  const isLoading = useMarketplaceStore((s) => s.isLoading);
  const activeInstall = useMarketplaceStore((s) => s.installInFlight);
  const error = useMarketplaceStore((s) => s.error);
  const filter = useMarketplaceStore((s) => s.activeFilter);
  const setFilter = useMarketplaceStore((s) => s.setActiveFilter);
  const addSource = useMarketplaceStore((s) => s.addSource);
  const removeSource = useMarketplaceStore((s) => s.removeSource);
  const updateSource = useMarketplaceStore((s) => s.updateSource);
  const claimInstall = useMarketplaceStore((s) => s.claimInstall);
  const previewPlugin = useMarketplaceStore((s) => s.previewPlugin);
  const releaseInstall = useMarketplaceStore((s) => s.releaseInstall);
  const installPlugin = useMarketplaceStore((s) => s.installPlugin);
  const uninstallPlugin = useMarketplaceStore((s) => s.uninstallPlugin);
  const loadSources = useMarketplaceStore((s) => s.loadSources);
  const browseSource = useMarketplaceStore((s) => s.browseSource);
  const loadInstalled = useMarketplaceStore((s) => s.loadInstalled);
  const scanInstalled = useMarketplaceStore((s) => s.scanInstalled);
  const uninstallItemFromAgents = useMarketplaceStore((s) => s.uninstallItemFromAgents);
  const installItemOnAgents = useMarketplaceStore((s) => s.installItemOnAgents);
  const clearError = useMarketplaceStore((s) => s.clearError);

  const handleUninstallItem = async (item: InstalledItem, agents: AgentName[]) => {
    await uninstallItemFromAgents(item, agents);
  };

  useEffect(() => {
    loadSources();
    loadInstalled();
    scanInstalled();
    // Best-effort agent-list enrichment for the Installed view; tolerate a missing IPC bridge.
    try {
      invoke<AgentName[]>(IPC.AGENT_LIST).then(setAvailableAgents).catch(() => {});
    } catch {
      // No preload bridge (e.g. in isolated component tests) — leave agents empty.
    }
  }, [loadSources, loadInstalled, scanInstalled]);

  // Re-scan when window regains focus so external changes (CLI removals) appear immediately.
  useEffect(() => {
    const onFocus = () => { scanInstalled(); loadInstalled(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [scanInstalled, loadInstalled]);

  useEffect(() => {
    for (const source of sources) {
      if (!(source.url in browsedPlugins)) browseSource(source.url);
    }
    // Also browse any source referenced by installed items but not yet in browsedPlugins
    // (happens when the user opens directly to the Installed tab before visiting Browse).
    for (const item of installedItems) {
      if (item.sourceUrl && !(item.sourceUrl in browsedPlugins)) browseSource(item.sourceUrl);
    }
  }, [sources, installedItems]);

  const addedUrls = useMemo(() => new Set(sources.map((s) => s.url)), [sources]);

  const allEntries = useMemo(() => {
    const entries = sources.flatMap((source) =>
      (browsedPlugins[source.url] ?? []).map((plugin) => ({ plugin, source })),
    );
    // Filter out plugins with no installable content, sort with-content first
    const withContent = entries.filter(({ plugin }) => hasInstallableContent(plugin));
    const empty = entries.filter(({ plugin }) => !hasInstallableContent(plugin));
    return [...withContent, ...empty];
  }, [sources, browsedPlugins]);

  const filteredEntries = useMemo(() => allEntries.filter(({ plugin, source }) =>
    pluginMatchesFilter(plugin, filter)
    && pluginMatchesSearch(plugin, searchQuery)
    && (selectedSources.size === 0 || selectedSources.has(source.url)),
  ), [allEntries, filter, searchQuery, selectedSources]);

  const availableEntries = filteredEntries.filter(({ plugin, source }) =>
    !installedPlugins.some((i) => i.pluginId === plugin.id && i.sourceUrl === source.url),
  );

  const handleAddSource = async (url: string) => {
    if (addingUrl) return;
    setAddingUrl(url);
    await addSource(url);
    setAddingUrl(null);
    setSelectedSources((prev) => new Set([...prev, url]));
  };

  const handleToggleSource = (url: string) => {
    setSelectedSources((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };

  const handleUpdateSource = async (url: string) => {
    setUpdatingSource(url);
    await updateSource(url);
    setUpdatingSource(null);
  };

  const isLoadingPlugins = sources.some((s) => !(s.url in browsedPlugins));
  const hasAnyPlugin = allEntries.length > 0;

  const handleInstall = async (
    pluginId: string,
    sourceUrl: string,
    intent: MarketplaceInstallIntent,
  ): Promise<boolean> => {
    const identity: MarketplaceRequestIdentity = { pluginId, sourceUrl };
    if (!claimInstall(identity)) return false;
    try {
      const previewRequest: MarketplacePreviewRequest = { ...identity, ...intent };
      const response = await previewPlugin(previewRequest);
      if (!response.success || !response.preview) return false;
      if (response.preview.introducesExecutableBehavior) {
        const effects = response.preview.agents.flatMap((entry) => entry.artifacts.map((item) => {
          const detail = item.detail ? ` — ${item.detail}` : '';
          return `${entry.agent}: ${item.name} → ${item.destinationPaths.join(', ')}${detail}`;
        }));
        const environment = response.preview.environmentVariableNames.length > 0
          ? `\nEnvironment variable names: ${response.preview.environmentVariableNames.join(', ')}`
          : '';
        const generated = response.preview.generatedFiles.length > 0
          ? `\nGenerated files: ${response.preview.generatedFiles.join(', ')}`
          : '';
        const confirmed = window.confirm(
          `This installation adds executable agent behavior. Review these effects before continuing:\n\n${effects.join('\n')}${environment}${generated}`,
        );
        if (!confirmed) return false;
      }
      const installRequest: MarketplaceInstallRequest = {
        ...previewRequest,
        previewDigest: response.preview.digest,
      };
      return installPlugin(installRequest);
    } finally {
      releaseInstall(identity);
    }
  };

  return (
    <div className="space-y-5">
      {/* Error banner */}
      {error && (
        <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-[var(--error)]/10 border border-[var(--error)]/25">
          <span className="text-[11px] text-[var(--error)] leading-snug">{error}</span>
          <button
            type="button"
            onClick={clearError}
            aria-label="Dismiss error"
            className="shrink-0 p-0.5 rounded text-[var(--error)]/70 hover:text-[var(--error)] transition-colors"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Updates */}
      <MarketplaceUpdatesSection />

      {/* View toggle */}
      <div className="inline-flex gap-1 p-0.5 rounded-lg bg-[var(--surface)] border border-[var(--border)]">
        {(['browse', 'installed'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={cn(
              'px-3 py-1 rounded-md text-[11px] font-medium capitalize transition-colors',
              view === v
                ? 'bg-[var(--accent)] text-[var(--bg)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
            )}
          >
            {v}
            {v === 'installed' && installedItems.length > 0 && (
              <span className="ml-1.5 tabular-nums opacity-70">{installedItems.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* Installed view — flat list across all agents */}
      {view === 'installed' && (
        <section>
          <MarketplaceInstalledList
            items={installedItems}
            installedPlugins={installedPlugins}
            allEntries={allEntries}
            availableAgents={availableAgents}
            onUninstall={handleUninstallItem}
            onInstallItem={installItemOnAgents}
          />
        </section>
      )}

      {/* Browse view — sources + available plugins */}
      {view === 'browse' && (
        <>
          {/* Sources row */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-[0.12em]">Sources</h3>
            </div>
            {isLoading ? (
              <div className="flex items-center gap-2">
                <Spinner />
                <span className="text-[11px] text-[var(--text-muted)]">Loading…</span>
              </div>
            ) : (
              <SourcesRow
                sources={sources}
                knownSources={KNOWN_SOURCES}
                updatingSource={updatingSource}
                addingUrl={addingUrl}
                addedUrls={addedUrls}
                selectedSources={selectedSources}
                onAdd={handleAddSource}
                onUpdate={handleUpdateSource}
                onRemove={removeSource}
                onToggle={handleToggleSource}
              />
            )}
          </section>

          {/* Plugins section */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-[0.12em]">
                Plugins
                {hasAnyPlugin && (
                  <span className="ml-2 font-normal normal-case tracking-normal">
                    {filteredEntries.length} of {allEntries.length}
                  </span>
                )}
              </h3>
            </div>

            {sources.length === 0 ? (
              <EmptyState onAdd={handleAddSource} addedUrls={addedUrls} addingUrl={addingUrl} />
            ) : isLoadingPlugins && !hasAnyPlugin ? (
              <div className="flex flex-col items-center gap-2 py-10 text-[var(--text-muted)]">
                <Spinner />
                <span className="text-[11px]">Fetching plugins from sources…</span>
              </div>
            ) : (
              <>
                {/* Search + filter */}
                <div className="space-y-2 mb-4">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search plugins, skills, MCP servers…"
                    className="w-full px-3 py-2 text-xs bg-[var(--surface)] border border-[var(--border)] rounded-lg text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors"
                  />
                  <div className="flex gap-1.5 flex-wrap">
                    {FILTER_TABS.map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setFilter(tab.id)}
                        className={cn(
                          'px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors',
                          filter === tab.id
                            ? 'bg-[var(--accent)] text-[var(--bg)]'
                            : 'bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] border border-[var(--border)]',
                        )}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                </div>

                {availableEntries.length === 0 ? (
                  <p className="text-[11px] text-[var(--text-muted)] py-4 text-center">
                    {filteredEntries.length === 0
                      ? 'No plugins match your search.'
                      : 'Everything from your sources is installed. See the Installed tab to manage it.'}
                  </p>
                ) : (
                  <div className="space-y-5">
                    <PluginGroup
                      title="Available"
                      entries={availableEntries}
                      installedPlugins={installedPlugins}
                      activeInstall={activeInstall}
                      onInstall={handleInstall}
                      onUninstall={uninstallPlugin}
                    />
                  </div>
                )}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ onAdd, addedUrls, addingUrl }: { onAdd: (url: string) => void; addedUrls: Set<string>; addingUrl: string | null }) {
  const suggested = KNOWN_SOURCES.filter((s) => !addedUrls.has(s.url));
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-[var(--text-muted)] mb-3">
        Add a source to browse and install plugins, skills, and MCP servers across all your agents.
      </p>
      {suggested.map((s) => (
        <button
          key={s.url}
          type="button"
          disabled={addingUrl === s.url}
          onClick={() => onAdd(s.url)}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]/40 hover:bg-[var(--surface-raised)] transition-colors text-left disabled:opacity-50"
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[12px] font-medium text-[var(--text)]">{s.label}</span>
              {s.tag && (
                <span className="text-[9px] font-semibold uppercase tracking-wide text-[var(--text-muted)] bg-[var(--surface-raised)] border border-[var(--border)] px-1.5 py-px rounded-full">
                  {s.tag}
                </span>
              )}
            </div>
            <div className="text-[10px] text-[var(--text-muted)] mt-0.5">{s.description}</div>
          </div>
          {addingUrl === s.url ? <Spinner /> : <Plus size={14} className="text-[var(--accent)] shrink-0" />}
        </button>
      ))}
    </div>
  );
}

// ── Plugin group ──────────────────────────────────────────────────────────────

interface PluginGroupProps {
  title: string;
  entries: Array<{ plugin: DetectedPlugin; source: { url: string } }>;
  installedPlugins: InstalledPlugin[];
  activeInstall: MarketplaceRequestIdentity | null;
  onInstall: (pluginId: string, sourceUrl: string, intent: MarketplaceInstallIntent) => Promise<boolean>;
  onUninstall: (pluginId: string, sourceUrl: string) => Promise<void>;
}

function PluginGroup({ title, entries, installedPlugins, activeInstall, onInstall, onUninstall }: PluginGroupProps) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)] mb-2.5">
        {title} <span className="font-normal normal-case tracking-normal opacity-60">({entries.length})</span>
      </div>
      <div className="space-y-2">
        {entries.map(({ plugin, source }) => {
          const installed = installedPlugins.find(
            (i) => i.pluginId === plugin.id && i.sourceUrl === source.url,
          );
          return (
            <MarketplacePluginCard
              key={`${source.url}::${plugin.id}`}
              plugin={plugin}
              installed={installed}
              installing={activeInstall?.pluginId === plugin.id && activeInstall.sourceUrl === source.url}
              installDisabled={activeInstall !== null}
              onInstall={(intent) => onInstall(plugin.id, source.url, intent)}
              onUninstall={() => onUninstall(plugin.id, source.url)}
            />
          );
        })}
      </div>
    </div>
  );
}
