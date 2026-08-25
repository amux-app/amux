import type { DetectedPlugin, InstalledPlugin, MarketplaceInstallMode } from 'muxbase/core';
import { Plus, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useMarketplaceBootstrap } from '../../hooks/useMarketplaceBootstrap';
import { cn } from '../../lib/cn';
import { useMarketplaceStore, type MarketplaceFilter } from '../../stores/marketplace.store';
import { SourcesRow, type KnownSource } from './MarketplaceSourceControls';
import { Spinner } from '../shared/Spinner';
import { MarketplacePluginCard } from './MarketplacePluginCard';
import knownSourcesData from './known-sources.json';

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
  const [updatingSource, setUpdatingSource] = useState<string | null>(null);
  const [addingUrl, setAddingUrl] = useState<string | null>(null);

  const sources = useMarketplaceStore((s) => s.sources);
  const installedPlugins = useMarketplaceStore((s) => s.installedPlugins);
  const browsedPlugins = useMarketplaceStore((s) => s.browsedPlugins);
  const isLoading = useMarketplaceStore((s) => s.isLoading);
  const installingPlugin = useMarketplaceStore((s) => s.installingPlugin);
  const error = useMarketplaceStore((s) => s.error);
  const filter = useMarketplaceStore((s) => s.activeFilter);
  const setFilter = useMarketplaceStore((s) => s.setActiveFilter);
  const addSource = useMarketplaceStore((s) => s.addSource);
  const removeSource = useMarketplaceStore((s) => s.removeSource);
  const updateSource = useMarketplaceStore((s) => s.updateSource);
  const previewPlugin = useMarketplaceStore((s) => s.previewPlugin);
  const installPlugin = useMarketplaceStore((s) => s.installPlugin);
  const uninstallPlugin = useMarketplaceStore((s) => s.uninstallPlugin);
  const clearError = useMarketplaceStore((s) => s.clearError);

  useMarketplaceBootstrap();

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

  const filteredEntries = useMemo(() => allEntries.filter(({ plugin }) =>
    pluginMatchesFilter(plugin, filter) && pluginMatchesSearch(plugin, searchQuery),
  ), [allEntries, filter, searchQuery]);

  const installedEntries = filteredEntries.filter(({ plugin, source }) =>
    installedPlugins.some((i) => i.pluginId === plugin.id && i.sourceUrl === source.url),
  );
  const availableEntries = filteredEntries.filter(({ plugin, source }) =>
    !installedPlugins.some((i) => i.pluginId === plugin.id && i.sourceUrl === source.url),
  );

  const handleAddSource = async (url: string) => {
    if (addingUrl) return;
    setAddingUrl(url);
    await addSource(url);
    setAddingUrl(null);
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
    mode: MarketplaceInstallMode,
    selectedSkills: string[],
    selectedMcpServers: string[],
    selectedAgents: string[],
  ): Promise<boolean> => {
    const response = await previewPlugin(pluginId, sourceUrl, mode, selectedSkills, selectedMcpServers, selectedAgents);
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
    return installPlugin(
      pluginId,
      sourceUrl,
      mode,
      selectedSkills,
      selectedMcpServers,
      selectedAgents,
      response.preview.digest,
    );
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
            className="shrink-0 p-0.5 rounded text-[var(--error)]/70 hover:text-[var(--error)] transition-colors"
          >
            <X size={13} />
          </button>
        </div>
      )}

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
            onAdd={handleAddSource}
            onUpdate={handleUpdateSource}
            onRemove={removeSource}
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

            {filteredEntries.length === 0 ? (
              <p className="text-[11px] text-[var(--text-muted)] py-4 text-center">No plugins match your search.</p>
            ) : (
              <div className="space-y-5">
                {installedEntries.length > 0 && (
                  <PluginGroup
                    title="Installed"
                    entries={installedEntries}
                    installedPlugins={installedPlugins}
                    installingPlugin={installingPlugin}
                    onInstall={handleInstall}
                    onUninstall={uninstallPlugin}
                  />
                )}
                {availableEntries.length > 0 && (
                  <PluginGroup
                    title="Available"
                    entries={availableEntries}
                    installedPlugins={installedPlugins}
                    installingPlugin={installingPlugin}
                    onInstall={handleInstall}
                    onUninstall={uninstallPlugin}
                  />
                )}
              </div>
            )}
          </>
        )}
      </section>
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
  installingPlugin: string | null;
  onInstall: (pluginId: string, sourceUrl: string, mode: MarketplaceInstallMode, selectedSkills: string[], selectedMcpServers: string[], selectedAgents: string[]) => Promise<boolean>;
  onUninstall: (pluginId: string, sourceUrl: string) => Promise<void>;
}

function PluginGroup({ title, entries, installedPlugins, installingPlugin, onInstall, onUninstall }: PluginGroupProps) {
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
              installing={installingPlugin === plugin.id}
              onInstall={(mode, skills, mcps, agts) => onInstall(plugin.id, source.url, mode, skills, mcps, agts)}
              onUninstall={() => onUninstall(plugin.id, source.url)}
            />
          );
        })}
      </div>
    </div>
  );
}
