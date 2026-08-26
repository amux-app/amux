import type { MarketplaceInstallIntent } from '../../../shared/ipc-types';
import type { DetectedPlugin, InstalledPlugin } from 'muxbase/core';
import { ChevronDown, ChevronUp, Download, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../lib/cn';
import { AgentBrandIcon, isBrandedAgentName } from '../shared/agent-brand-icons';
import { Spinner } from '../shared/Spinner';

interface MarketplacePluginCardProps {
  plugin: DetectedPlugin;
  installed?: InstalledPlugin;
  installing: boolean;
  installDisabled: boolean;
  onInstall: (intent: MarketplaceInstallIntent) => void;
  onUninstall: () => void;
}

function useCheckboxGroup(allItems: string[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set()); // default: none selected

  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });

  const setAll = (checked: boolean) =>
    setSelected(checked ? new Set(allItems) : new Set());

  const allSelected = allItems.length > 0 && selected.size === allItems.length;

  return { selected, toggle, setAll, allSelected };
}

function ItemChip({
  name,
  description,
  checked,
  onToggle,
}: {
  name: string;
  description?: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="relative group/chip">
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
        {/* Custom checkbox */}
        <span className={cn(
          'inline-flex items-center justify-center w-3.5 h-3.5 rounded border flex-shrink-0 transition-colors',
          checked
            ? 'bg-[var(--surface-raised)] border-[var(--divider-strong)]'
            : 'bg-transparent border-[var(--border)]',
        )}>
          {checked && (
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
              <path d="M1.5 4L3.5 6L6.5 2" stroke="var(--text-secondary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
        {name}
      </button>

      {/* Tooltip — only shown when description exists */}
      {description && (
        <div className="absolute bottom-full left-0 mb-1.5 z-50 pointer-events-none hidden group-hover/chip:block">
          <div className="max-w-[280px] px-2.5 py-1.5 rounded-lg bg-[var(--chrome)] border border-[var(--divider-strong)] shadow-2xl">
            <p className="text-[10px] text-[var(--text-secondary)] leading-relaxed whitespace-normal">{description}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function SelectionGroup({
  title,
  items,
  descriptions,
  selected,
  allSelected,
  onToggle,
  onToggleAll,
}: {
  title: string;
  items: string[];
  descriptions: Record<string, string | undefined>;
  selected: Set<string>;
  allSelected: boolean;
  onToggle: (name: string) => void;
  onToggleAll: (v: boolean) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[9px] font-semibold uppercase tracking-[0.1em] text-[var(--text-muted)]">
          {title}
        </span>
        <button
          type="button"
          onClick={() => onToggleAll(!allSelected)}
          aria-label={`${allSelected ? 'Deselect all' : 'Select all'} ${title.toLowerCase()}`}
          className="text-[9px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
        >
          {allSelected ? 'Deselect all' : 'Select all'}
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((name) => (
          <ItemChip
            key={name}
            name={name}
            description={descriptions[name]}
            checked={selected.has(name)}
            onToggle={() => onToggle(name)}
          />
        ))}
      </div>
    </div>
  );
}

export function MarketplacePluginCard({
  plugin,
  installed,
  installing,
  installDisabled,
  onInstall,
  onUninstall,
}: MarketplacePluginCardProps) {
  const skillNames = plugin.skills.map((s) => s.name);
  const mcpNames = plugin.mcpServers.map((s) => s.name);
  const agentNames = (plugin.agents ?? []).map((a) => a.name);

  const skillDescriptions: Record<string, string | undefined> = Object.fromEntries(
    plugin.skills.map((s) => [s.name, s.description]),
  );
  const mcpDescriptions: Record<string, string | undefined> = Object.fromEntries(
    plugin.mcpServers.map((s) => [s.name, s.description]),
  );
  const agentDescriptions: Record<string, string | undefined> = Object.fromEntries(
    (plugin.agents ?? []).map((a) => [a.name, a.description]),
  );

  const skills = useCheckboxGroup(skillNames);
  const mcps = useCheckboxGroup(mcpNames);
  const agents = useCheckboxGroup(agentNames);

  const [expanded, setExpanded] = useState(false);

  const hasSelectable = skillNames.length > 0 || mcpNames.length > 0 || agentNames.length > 0;
  const hasAutoInstallOnly = !hasSelectable && (plugin.hooks.length > 0 || plugin.jsPlugins.length > 0);
  const selectedCount = skills.selected.size + mcps.selected.size + agents.selected.size;
  const totalCount = skillNames.length + mcpNames.length + agentNames.length;
  const nothingSelected = selectedCount === 0;

  return (
    <div className={cn(
      'rounded-xl border overflow-hidden transition-colors',
      installed
        ? 'border-[var(--success)]/25 bg-[var(--surface)]'
        : 'border-[var(--border)] bg-[var(--surface)] hover:border-[var(--divider-strong)]',
    )}>
      {/* Header */}
      <div className="flex items-start gap-3 px-4 pt-3.5 pb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[13px] font-semibold text-[var(--text)] truncate">{plugin.name}</span>
            {plugin.version && (
              <span className="shrink-0 text-[10px] font-mono text-[var(--text-muted)] bg-[var(--surface-raised)] px-1.5 py-0.5 rounded border border-[var(--border)]">
                v{plugin.version}
              </span>
            )}
          </div>

          {plugin.description && (
            <p className="text-[11px] text-[var(--text-muted)] leading-snug line-clamp-2 mb-2">
              {plugin.description}
            </p>
          )}

          {/* Count summary */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {skillNames.length > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border bg-[var(--surface-raised)] text-[var(--text-secondary)] border-[var(--border)]">
                <span className="tabular-nums">{skillNames.length}</span>
                <span className="text-[var(--text-muted)]">skill{skillNames.length !== 1 ? 's' : ''}</span>
              </span>
            )}
            {mcpNames.length > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border bg-[var(--surface-raised)] text-[var(--text-secondary)] border-[var(--border)]">
                <span className="tabular-nums">{mcpNames.length}</span>
                <span className="text-[var(--text-muted)]">MCP{mcpNames.length !== 1 ? 's' : ''}</span>
              </span>
            )}
            {plugin.hooks.length > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border bg-[var(--surface-raised)] text-[var(--text-secondary)] border-[var(--border)]">
                <span className="tabular-nums">{plugin.hooks.length}</span>
                <span className="text-[var(--text-muted)]">hook{plugin.hooks.length !== 1 ? 's' : ''}</span>
              </span>
            )}
            {agentNames.length > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border bg-[var(--surface-raised)] text-[var(--text-secondary)] border-[var(--border)]">
                <span className="tabular-nums">{agentNames.length}</span>
                <span className="text-[var(--text-muted)]">agent{agentNames.length !== 1 ? 's' : ''}</span>
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="shrink-0 flex flex-col items-end gap-2 pt-0.5">
          {installed ? (
            <button
              type="button"
              onClick={onUninstall}
              className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium rounded-lg text-[var(--error)] hover:bg-[var(--error)]/10 border border-[var(--error)]/30 transition-colors"
            >
              <Trash2 size={11} />
              Uninstall
            </button>
          ) : (
            hasSelectable ? (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                disabled={installDisabled}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium rounded-lg border transition-colors',
                  expanded
                    ? 'bg-[var(--surface-raised)] text-[var(--text)] border-[var(--divider-strong)]'
                    : 'bg-[var(--surface-raised)] text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--text)] hover:border-[var(--divider-strong)]',
                )}
              >
                {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                {expanded ? 'Collapse' : 'Install'}
              </button>
            ) : hasAutoInstallOnly ? (
              <button
                type="button"
                onClick={() => onInstall({ mode: 'full' })}
                disabled={installDisabled}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium rounded-lg bg-[var(--accent)] text-[var(--bg)] hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {installing ? <Spinner /> : <Download size={12} />}
                Install
              </button>
            ) : null
          )}

          {/* Agent badges for installed */}
          {installed && (
            <div className="flex items-center gap-1">
              {Object.entries(installed.agents).map(([agent, info]) => {
                if (!info || !isBrandedAgentName(agent)) return null;
                return (
                  <div
                    key={agent}
                    title={`${agent}: ${info.status}${info.skipped?.length ? ` — ${info.skipped.join(', ')}` : ''}`}
                    className={cn(
                      'flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium border',
                      info.status === 'full'
                        ? 'bg-[var(--success)]/10 text-[var(--success)] border-[var(--success)]/25'
                        : 'bg-[var(--warning)]/10 text-[var(--warning)] border-[var(--warning)]/25',
                    )}
                  >
                    <AgentBrandIcon agent={agent} size="sm" />
                    {agent}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Selection panel */}
      {!installed && expanded && hasSelectable && (
        <div className="border-t border-[var(--border)] px-4 pt-3 pb-4 space-y-3.5">
          <SelectionGroup
            title="Skills"
            items={skillNames}
            descriptions={skillDescriptions}
            selected={skills.selected}
            allSelected={skills.allSelected}
            onToggle={skills.toggle}
            onToggleAll={skills.setAll}
          />
          <SelectionGroup
            title="MCP Servers"
            items={mcpNames}
            descriptions={mcpDescriptions}
            selected={mcps.selected}
            allSelected={mcps.allSelected}
            onToggle={mcps.toggle}
            onToggleAll={mcps.setAll}
          />
          <SelectionGroup
            title="Agents"
            items={agentNames}
            descriptions={agentDescriptions}
            selected={agents.selected}
            allSelected={agents.allSelected}
            onToggle={agents.toggle}
            onToggleAll={agents.setAll}
          />

          {/* Install CTA */}
          <div className="flex items-center justify-between pt-0.5">
            <span className="text-[10px] text-[var(--text-muted)]">
              {nothingSelected
                ? 'Select items to install'
                : `${selectedCount} of ${totalCount} selected`}
            </span>
            <button
              type="button"
              onClick={() => onInstall({
                mode: 'selected',
                selectedSkills: skillNames.filter((name) => skills.selected.has(name)),
                selectedMcpServers: mcpNames.filter((name) => mcps.selected.has(name)),
                selectedAgents: agentNames.filter((name) => agents.selected.has(name)),
              })}
              disabled={installDisabled || nothingSelected}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg bg-[var(--accent)] text-[var(--bg)] hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              {installing ? <Spinner /> : <Download size={12} />}
              Install selected{selectedCount > 0 ? ` (${selectedCount})` : ''}
            </button>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] pt-3">
            <span className="text-[10px] text-[var(--text-muted)]">
              Uses native agent registration when available and may add capabilities beyond the selected items.
            </span>
            <button
              type="button"
              onClick={() => onInstall({ mode: 'full' })}
              disabled={installDisabled}
              className="shrink-0 px-2.5 py-1.5 text-[10px] font-medium rounded-lg border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--divider-strong)] disabled:opacity-40 transition-colors"
            >
              Install full plugin
            </button>
          </div>
        </div>
      )}

      {/* Installed footer */}
      {installed && (
        <div className="px-4 py-1.5 border-t border-[var(--border)]">
          <span className="text-[10px] text-[var(--text-muted)]">
            Installed {new Date(installed.installedAt).toLocaleDateString()}
          </span>
        </div>
      )}
    </div>
  );
}
