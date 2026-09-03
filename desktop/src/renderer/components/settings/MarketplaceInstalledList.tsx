import type { AgentName, DetectedPlugin, InstalledItem, InstalledItemType, InstalledPlugin } from 'muxbase/core';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../lib/cn';
import { Spinner } from '../shared/Spinner';
import { AgentBrandIcon } from '../shared/agent-brand-icons';

const AGENT_KEYS = ['claude', 'codex', 'opencode', 'pi'] as const satisfies readonly AgentName[];
const AGENT_LABELS: Record<AgentName, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};

const TYPE_CHIP_LABELS: Record<InstalledItemType, string> = {
  skill: 'SKILL',
  mcpServer: 'MCP',
  agent: 'AGENT',
  hook: 'HOOK',
};

// ── Checkbox ──────────────────────────────────────────────────────────────────

function Checkbox({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onChange(); }}
      aria-label={checked ? 'Deselect' : 'Select'}
      className={cn(
        'shrink-0 inline-flex items-center justify-center w-4 h-4 rounded border transition-colors',
        checked
          ? 'bg-[var(--accent)] border-[var(--accent)]'
          : 'bg-transparent border-[var(--border)] hover:border-[var(--divider-strong)]',
      )}
    >
      {checked && (
        <svg width="9" height="9" viewBox="0 0 8 8" fill="none">
          <path d="M1.5 4L3.5 6L6.5 2" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

// ── Agent toggle chip ─────────────────────────────────────────────────────────

function AgentToggleChip({
  agent,
  installed,
  canInstall,
  busy,
  onToggle,
}: {
  agent: AgentName;
  installed: boolean;
  canInstall: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  const disabled = busy || (!installed && !canInstall);
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      title={
        busy ? 'Working…'
        : installed ? `Uninstall from ${AGENT_LABELS[agent]}`
        : canInstall ? `Install to ${AGENT_LABELS[agent]}`
        : `Cannot install to ${AGENT_LABELS[agent]} (external item)`
      }
      className={cn(
        'flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium transition-all select-none',
        installed
          ? 'bg-[var(--success)]/15 border-[var(--success)]/40 text-[var(--success)] hover:bg-[var(--error)]/10 hover:border-[var(--error)]/40 hover:text-[var(--error)]'
          : canInstall
          ? 'bg-transparent border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)]/50 hover:text-[var(--accent)]'
          : 'bg-transparent border-[var(--border)]/50 text-[var(--text-muted)]/40 cursor-not-allowed',
        busy && 'opacity-60 pointer-events-none',
      )}
    >
      {busy ? <Spinner /> : <AgentBrandIcon agent={agent} size="sm" />}
      <span>{AGENT_LABELS[agent]}</span>
    </button>
  );
}

// ── Item row ──────────────────────────────────────────────────────────────────

function InstalledItemRow({
  item,
  busyAgents,
  bulkSelected,
  onBulkToggle,
  onAgentToggle,
}: {
  item: InstalledItem;
  busyAgents: Set<AgentName>;
  bulkSelected: boolean;
  onBulkToggle: () => void;
  onAgentToggle: (agent: AgentName, installed: boolean) => void;
}) {
  const canInstall = !!item.pluginId && !!item.sourceUrl;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--divider-strong)] transition-colors">
      <div className="flex items-center gap-2.5 px-3 py-2">
        <Checkbox checked={bulkSelected} onChange={onBulkToggle} />

        <div className="flex-1 min-w-0 flex items-center gap-1.5 flex-wrap">
          <span className="text-[12px] font-medium text-[var(--text)] truncate">{item.name}</span>
          <span className="shrink-0 text-[9px] font-mono px-1.5 py-px rounded border border-[var(--border)] text-[var(--text-muted)] bg-[var(--surface-raised)]">
            {TYPE_CHIP_LABELS[item.type]}
          </span>
          {!item.removable && (
            <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide px-1.5 py-px rounded-full border border-[var(--warning)]/30 text-[var(--warning)] bg-[var(--warning)]/10">
              read-only
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {AGENT_KEYS.map((agent) => {
            const installed = item.agents.includes(agent);
            return (
              <AgentToggleChip
                key={agent}
                agent={agent}
                installed={installed}
                canInstall={canInstall && !installed}
                busy={busyAgents.has(agent)}
                onToggle={() => item.removable || !installed ? onAgentToggle(agent, installed) : undefined}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Modify editor (plugin-level) ──────────────────────────────────────────────

function EditChip({ name, checked, onToggle }: { name: string; checked: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-mono transition-all select-none',
        checked
          ? 'bg-[var(--surface-raised)] text-[var(--text)] border-[var(--divider-strong)]'
          : 'bg-transparent text-[var(--text-muted)] border-[var(--border)] hover:border-[var(--divider-strong)] hover:text-[var(--text-secondary)]',
      )}
    >
      <span className={cn(
        'inline-flex items-center justify-center w-3.5 h-3.5 rounded border flex-shrink-0 transition-colors',
        checked ? 'bg-[var(--surface-raised)] border-[var(--divider-strong)]' : 'bg-transparent border-[var(--border)]',
      )}>
        {checked && (
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
            <path d="M1.5 4L3.5 6L6.5 2" stroke="var(--text-secondary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      {name}
    </button>
  );
}

function EditGroup({ title, items, selected, onToggle }: {
  title: string;
  items: string[];
  selected: Set<string>;
  onToggle: (name: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <span className="text-[9px] font-semibold uppercase tracking-[0.1em] text-[var(--text-muted)]">{title}</span>
      <div className="flex flex-wrap gap-1.5 mt-1.5">
        {items.map((name) => (
          <EditChip key={name} name={name} checked={selected.has(name)} onToggle={() => onToggle(name)} />
        ))}
      </div>
    </div>
  );
}

function ModifyEditor({
  plugin,
  installed,
  busy,
  onSave,
  onCancel,
}: {
  plugin: DetectedPlugin;
  installed: InstalledPlugin;
  busy: boolean;
  onSave: (skills: string[], mcps: string[], agents: string[]) => void;
  onCancel: () => void;
}) {
  const allSkills = plugin.skills.map((s) => s.name);
  const allMcps = plugin.mcpServers.map((s) => s.name);
  const allAgents = (plugin.agents ?? []).map((a) => a.name);

  const sel = installed.selectedArtifacts;
  const initialSkills = new Set<string>(sel?.skills ?? allSkills);
  const initialMcps = new Set<string>(sel?.mcpServers ?? allMcps);
  const initialAgents = new Set<string>(sel?.agentNames ?? allAgents);

  const [skills, setSkills] = useState<Set<string>>(initialSkills);
  const [mcps, setMcps] = useState<Set<string>>(initialMcps);
  const [agents, setAgents] = useState<Set<string>>(initialAgents);

  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>) => (name: string) =>
    set((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });

  const total = skills.size + mcps.size + agents.size;

  const setsEqual = (a: Set<string>, b: Set<string>) =>
    a.size === b.size && [...a].every((v) => b.has(v));
  const hasChanges =
    !setsEqual(skills, initialSkills) ||
    !setsEqual(mcps, initialMcps) ||
    !setsEqual(agents, initialAgents);

  return (
    <div className="mt-2 border border-[var(--divider-strong)] rounded-lg px-3 py-3 space-y-3 bg-[var(--surface-raised)]/40">
      <EditGroup title="Skills" items={allSkills} selected={skills} onToggle={toggle(setSkills)} />
      <EditGroup title="MCP Servers" items={allMcps} selected={mcps} onToggle={toggle(setMcps)} />
      <EditGroup title="Agents" items={allAgents} selected={agents} onToggle={toggle(setAgents)} />
      <div className="flex items-center justify-between pt-0.5">
        <span className="text-[10px] text-[var(--text-muted)]">
          {total === 0 ? 'Nothing selected — this will uninstall the plugin' : `${total} selected`}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="px-2.5 py-1.5 text-[11px] font-medium rounded-lg text-[var(--text-muted)] hover:text-[var(--text)] border border-[var(--border)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(Array.from(skills), Array.from(mcps), Array.from(agents))}
            disabled={busy || !hasChanges}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg bg-[var(--accent)] text-[var(--bg)] hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            {busy && <Spinner />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Plugin group ──────────────────────────────────────────────────────────────

function PluginGroup({
  pluginId,
  sourceUrl,
  plugin,
  installedRecord,
  items,
  busyItemAgents,
  modifyBusy,
  editingPluginKey,
  bulkSelected,
  onBulkToggle,
  onAgentToggle,
  onPluginModifyClick,
  onPluginModifySave,
  onPluginModifyCancel,
}: {
  pluginId: string;
  sourceUrl: string;
  plugin: DetectedPlugin | undefined;
  installedRecord: InstalledPlugin | undefined;
  items: InstalledItem[];
  busyItemAgents: Map<string, Set<AgentName>>;
  modifyBusy: boolean;
  editingPluginKey: string | null;
  bulkSelected: Set<string>;
  onBulkToggle: (key: string) => void;
  onAgentToggle: (item: InstalledItem, agent: AgentName, installed: boolean) => void;
  onPluginModifyClick: (key: string) => void;
  onPluginModifySave: (pluginId: string, sourceUrl: string, skills: string[], mcps: string[], agents: string[]) => void;
  onPluginModifyCancel: () => void;
}) {
  const pluginKey = `${sourceUrl}::${pluginId}`;
  const isEditingPlugin = editingPluginKey === pluginKey;
  const canModifyPlugin = plugin && installedRecord && (
    plugin.skills.length > 0 || plugin.mcpServers.length > 0 || (plugin.agents?.length ?? 0) > 0
  );
  const removableItems = items.filter((i) => i.removable);
  const allSelected = removableItems.length > 0 && removableItems.every((i) => bulkSelected.has(itemKey(i)));
  const someSelected = removableItems.some((i) => bulkSelected.has(itemKey(i)));

  return (
    <div className="rounded-lg border border-[var(--border)] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-[var(--surface-raised)] border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (allSelected) {
                removableItems.forEach((i) => bulkSelected.has(itemKey(i)) && onBulkToggle(itemKey(i)));
              } else {
                removableItems.forEach((i) => !bulkSelected.has(itemKey(i)) && onBulkToggle(itemKey(i)));
              }
            }}
            className={cn(
              'shrink-0 inline-flex items-center justify-center w-4 h-4 rounded border transition-colors',
              allSelected
                ? 'bg-[var(--accent)] border-[var(--accent)]'
                : someSelected
                ? 'bg-[var(--accent)]/40 border-[var(--accent)]/60'
                : 'bg-transparent border-[var(--border)] hover:border-[var(--divider-strong)]',
            )}
            title={allSelected ? 'Deselect all in plugin' : 'Select all in plugin'}
          >
            {allSelected && (
              <svg width="9" height="9" viewBox="0 0 8 8" fill="none">
                <path d="M1.5 4L3.5 6L6.5 2" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
            {someSelected && !allSelected && (
              <svg width="7" height="7" viewBox="0 0 8 8" fill="none">
                <rect x="1.5" y="3.5" width="5" height="1" rx="0.5" fill="var(--bg)" />
              </svg>
            )}
          </button>
          <span className="text-[11px] font-semibold text-[var(--text-secondary)]">
            {plugin?.name ?? pluginId}
            {plugin?.version && (
              <span className="ml-1.5 text-[9px] font-mono text-[var(--text-muted)] bg-[var(--surface)] px-1.5 py-px rounded border border-[var(--border)]">
                v{plugin.version}
              </span>
            )}
          </span>
          <span className="text-[10px] text-[var(--text-muted)]">{items.length} item{items.length !== 1 ? 's' : ''}</span>
        </div>
        {canModifyPlugin && !isEditingPlugin && (
          <button
            type="button"
            onClick={() => onPluginModifyClick(pluginKey)}
            className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-lg text-[var(--text-muted)] hover:text-[var(--text)] border border-[var(--border)] hover:border-[var(--divider-strong)] transition-colors"
          >
            Modify
          </button>
        )}
      </div>

      <div className="divide-y divide-[var(--border)]">
        {items.map((item) => {
          const ik = itemKey(item);
          return (
            <div key={ik} className="px-1 py-0.5">
              <InstalledItemRow
                item={item}
                busyAgents={busyItemAgents.get(ik) ?? new Set()}
                bulkSelected={bulkSelected.has(ik)}
                onBulkToggle={() => onBulkToggle(ik)}
                onAgentToggle={(agent, installed) => onAgentToggle(item, agent, installed)}
              />
            </div>
          );
        })}
      </div>

      {isEditingPlugin && plugin && installedRecord && (
        <div className="px-3 pb-3">
          <ModifyEditor
            key={installedRecord.installedAt}
            plugin={plugin}
            installed={installedRecord}
            busy={modifyBusy}
            onSave={(s, m, a) => onPluginModifySave(pluginId, sourceUrl, s, m, a)}
            onCancel={onPluginModifyCancel}
          />
        </div>
      )}
    </div>
  );
}

// ── Main exported component ───────────────────────────────────────────────────

interface MarketplaceInstalledListProps {
  items: InstalledItem[];
  installedPlugins: InstalledPlugin[];
  allEntries: Array<{ plugin: DetectedPlugin; source: { url: string } }>;
  availableAgents: AgentName[];
  onUninstall: (item: InstalledItem, agents: AgentName[]) => Promise<void>;
  onInstallItem: (item: InstalledItem, agents: AgentName[]) => Promise<void>;
}

const TYPE_ORDER: Record<InstalledItemType, number> = { skill: 0, mcpServer: 1, agent: 2, hook: 3 };
const sortItems = (a: InstalledItem, b: InstalledItem) =>
  TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.name.localeCompare(b.name);
const itemKey = (item: InstalledItem) =>
  item.type === 'hook' && item.pluginId
    ? `${item.type}::${item.pluginId}::${item.name}`
    : `${item.type}::${item.name}`;
const agentItemKey = (item: InstalledItem, agent: AgentName) => `${item.type}::${item.name}::${agent}`;

export function MarketplaceInstalledList({
  items,
  installedPlugins,
  allEntries,
  availableAgents,
  onUninstall,
  onInstallItem,
}: MarketplaceInstalledListProps) {
  const [editingPluginKey, setEditingPluginKey] = useState<string | null>(null);
  const [modifyingKey, setModifyingKey] = useState<string | null>(null);
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Per-agent busy state: agentItemKey → busy
  const [busyAgentItems, setBusyAgentItems] = useState<Set<string>>(new Set());

  const toggleBulk = (key: string) =>
    setBulkSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  const handleAgentToggle = async (item: InstalledItem, agent: AgentName, installed: boolean) => {
    const key = agentItemKey(item, agent);
    setBusyAgentItems((prev) => new Set(prev).add(key));
    try {
      if (installed) {
        await onUninstall(item, [agent]);
      } else {
        await onInstallItem(item, [agent]);
      }
    } finally {
      setBusyAgentItems((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const handlePluginModifySave = async (pluginId: string, sourceUrl: string, newSkills: string[], newMcps: string[], newAgentNames: string[]) => {
    const key = `${sourceUrl}::${pluginId}`;
    setModifyingKey(key);

    const record = installedPlugins.find((i) => i.pluginId === pluginId && i.sourceUrl === sourceUrl);
    const sel = record?.selectedArtifacts;

    const entry = allEntries.find((e) => e.plugin.id === pluginId && e.source.url === sourceUrl);
    const plugin = entry?.plugin;
    const allSkills = plugin?.skills.map((s) => s.name) ?? [];
    const allMcps = plugin?.mcpServers.map((s) => s.name) ?? [];
    const allAgentNames = (plugin?.agents ?? []).map((a) => a.name);

    const prevSkills = new Set<string>(sel?.skills ?? allSkills);
    const prevMcps = new Set<string>(sel?.mcpServers ?? allMcps);
    const prevAgentNames = new Set<string>(sel?.agentNames ?? allAgentNames);

    type DiffEntry = { type: InstalledItemType; name: string };
    const toRemove: DiffEntry[] = [
      ...[...prevSkills].filter((n) => !newSkills.includes(n)).map((n) => ({ type: 'skill' as InstalledItemType, name: n })),
      ...[...prevMcps].filter((n) => !newMcps.includes(n)).map((n) => ({ type: 'mcpServer' as InstalledItemType, name: n })),
      ...[...prevAgentNames].filter((n) => !newAgentNames.includes(n)).map((n) => ({ type: 'agent' as InstalledItemType, name: n })),
    ];
    const toAdd: DiffEntry[] = [
      ...newSkills.filter((n) => !prevSkills.has(n)).map((n) => ({ type: 'skill' as InstalledItemType, name: n })),
      ...newMcps.filter((n) => !prevMcps.has(n)).map((n) => ({ type: 'mcpServer' as InstalledItemType, name: n })),
      ...newAgentNames.filter((n) => !prevAgentNames.has(n)).map((n) => ({ type: 'agent' as InstalledItemType, name: n })),
    ];

    const makeItem = (type: InstalledItemType, name: string): InstalledItem => ({
      type, name, agents: availableAgents, source: 'amux', pluginId, sourceUrl, removable: true,
    });

    for (const e of toRemove) {
      await onUninstall(makeItem(e.type, e.name), availableAgents);
    }
    await Promise.all(toAdd.map((e) => onInstallItem(makeItem(e.type, e.name), availableAgents)));

    setModifyingKey(null);
    setEditingPluginKey(null);
  };

  const handleBulkUninstall = async () => {
    setBulkBusy(true);
    const targets = items.filter((item) => bulkSelected.has(itemKey(item)) && item.removable);
    for (const item of targets) {
      await onUninstall(item, item.agents as AgentName[]);
    }
    setBulkSelected(new Set());
    setBulkBusy(false);
  };

  if (items.length === 0) {
    return (
      <p className="text-[11px] text-[var(--text-muted)] py-8 text-center">
        Nothing installed yet. Switch to Browse to add plugins, skills, and MCP servers.
      </p>
    );
  }

  // Group by pluginId+sourceUrl when available; ungrouped = no pluginId (hand-installed).
  const pluginGroups = new Map<string, { pluginId: string; sourceUrl: string; items: InstalledItem[] }>();
  const ungrouped: InstalledItem[] = [];

  for (const item of items) {
    if (item.pluginId && item.sourceUrl) {
      const key = `${item.sourceUrl}::${item.pluginId}`;
      if (!pluginGroups.has(key)) {
        pluginGroups.set(key, { pluginId: item.pluginId, sourceUrl: item.sourceUrl, items: [] });
      }
      pluginGroups.get(key)!.items.push(item);
    } else {
      ungrouped.push(item);
    }
  }

  // Stable alphabetical sort so the list order doesn't change between renders.
  const sortedGroups = Array.from(pluginGroups.values())
    .sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  for (const group of sortedGroups) {
    group.items.sort(sortItems);
  }
  ungrouped.sort(sortItems);

  const removableKeys = items.filter((i) => i.removable).map(itemKey);
  const allRemovableSelected = removableKeys.length > 0 && removableKeys.every((k) => bulkSelected.has(k));

  // Build per-item busy agent map for PluginGroup
  const busyItemAgentsMap = new Map<string, Set<AgentName>>();
  for (const key of busyAgentItems) {
    const parts = key.split('::');
    const agent = parts[parts.length - 1] as AgentName;
    const ik = parts.slice(0, -1).join('::');
    if (!busyItemAgentsMap.has(ik)) busyItemAgentsMap.set(ik, new Set());
    busyItemAgentsMap.get(ik)!.add(agent);
  }

  return (
    <div className="space-y-2">
      {/* Bulk action bar */}
      <div className="flex items-center gap-2 pb-1 min-h-[28px]">
        <button
          type="button"
          onClick={() => setBulkSelected(allRemovableSelected ? new Set() : new Set(removableKeys))}
          className={cn(
            'inline-flex items-center justify-center w-4 h-4 rounded border transition-colors shrink-0',
            allRemovableSelected && removableKeys.length > 0
              ? 'bg-[var(--accent)] border-[var(--accent)]'
              : 'bg-transparent border-[var(--border)] hover:border-[var(--divider-strong)]',
          )}
          title={allRemovableSelected ? 'Deselect all' : 'Select all removable'}
        >
          {allRemovableSelected && removableKeys.length > 0 && (
            <svg width="9" height="9" viewBox="0 0 8 8" fill="none">
              <path d="M1.5 4L3.5 6L6.5 2" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
        <span className="text-[10px] text-[var(--text-muted)]">
          {bulkSelected.size > 0 ? `${bulkSelected.size} selected` : 'Select items to bulk uninstall'}
        </span>
        <div className="ml-auto">
          <button
            type="button"
            onClick={handleBulkUninstall}
            disabled={bulkSelected.size === 0 || bulkBusy}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium rounded-lg text-[var(--error)] border border-[var(--error)]/30 transition-all',
              bulkSelected.size > 0 ? 'opacity-100 hover:bg-[var(--error)]/10' : 'opacity-0 pointer-events-none',
              bulkBusy && 'opacity-40',
            )}
          >
            {bulkBusy ? <Spinner /> : <Trash2 size={11} />}
            Uninstall {bulkSelected.size > 0 ? bulkSelected.size : ''}
          </button>
        </div>
      </div>

      {sortedGroups.map(({ pluginId, sourceUrl, items: groupItems }) => {
        const key = `${sourceUrl}::${pluginId}`;
        const plugin = allEntries.find((e) => e.plugin.id === pluginId && e.source.url === sourceUrl)?.plugin;
        const installedRecord = installedPlugins.find((i) => i.pluginId === pluginId && i.sourceUrl === sourceUrl);
        return (
          <PluginGroup
            key={key}
            pluginId={pluginId}
            sourceUrl={sourceUrl}
            plugin={plugin}
            installedRecord={installedRecord}
            items={groupItems}
            busyItemAgents={busyItemAgentsMap}
            modifyBusy={modifyingKey === key}
            editingPluginKey={editingPluginKey}
            bulkSelected={bulkSelected}
            onBulkToggle={toggleBulk}
            onAgentToggle={handleAgentToggle}
            onPluginModifyClick={setEditingPluginKey}
            onPluginModifySave={handlePluginModifySave}
            onPluginModifyCancel={() => setEditingPluginKey(null)}
          />
        );
      })}

      {ungrouped.map((item) => {
        const ik = itemKey(item);
        return (
          <InstalledItemRow
            key={ik}
            item={item}
            busyAgents={busyItemAgentsMap.get(ik) ?? new Set()}
            bulkSelected={bulkSelected.has(ik)}
            onBulkToggle={() => toggleBulk(ik)}
            onAgentToggle={(agent, installed) => handleAgentToggle(item, agent, installed)}
          />
        );
      })}
    </div>
  );
}
