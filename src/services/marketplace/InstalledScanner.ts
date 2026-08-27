import { existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import type { AgentName } from '../../utils/agentLaunch.js';
import { AgentTranslator } from './AgentTranslator.js';
import { HookTranslator } from './HookTranslator.js';
import { McpTranslator } from './McpTranslator.js';
import { SkillTranslator } from './SkillTranslator.js';
import type { InstalledPlugin } from './types.js';

export type InstalledItemType = 'skill' | 'mcpServer' | 'agent' | 'hook';

// A single installable item as it exists on disk, unioned across every agent that has it.
export interface InstalledItem {
  type: InstalledItemType;
  name: string;                 // display name (agents de-scoped from `<pluginId>__<name>`)
  agents: AgentName[];          // union of agents that have this item installed
  source: 'amux' | 'external'; // amux = tracked in the marketplace registry
  pluginId?: string;            // present when source === 'amux'
  sourceUrl?: string;           // present when source === 'amux'
  removable: boolean;           // false for hooks we can't safely attribute (no sentinel)
}

// Intermediate per-agent scan result before cross-agent merging.
interface ScannedItem {
  type: InstalledItemType;
  name: string;
  agent: AgentName;
  pluginId?: string;   // present when identifiable on disk (agents/hooks) — hint for attribution
  removable: boolean;
}

function listDirNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((entry) => {
      if (entry.startsWith('.')) return false;
      try {
        return statSync(path.join(dir, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function listMdBasenames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -'.md'.length));
  } catch {
    return [];
  }
}

// Split an on-disk agent basename `<pluginId>__<name>` into its parts. Returns the whole
// string as the display name when it isn't scoped (i.e. a hand-installed / external agent).
function parseAgentFilename(basename: string): { name: string; pluginId?: string } {
  const idx = basename.indexOf('__');
  if (idx <= 0) return { name: basename };
  return { pluginId: basename.slice(0, idx), name: basename.slice(idx + 2) };
}

export class InstalledScanner {
  // Scan every provided agent's on-disk locations, then merge with the registry so each
  // item carries an accurate `source`/`pluginId`. Only `agents` (which are actually
  // installed on the user's machine) are scanned.
  scan(agents: AgentName[], installed: InstalledPlugin[]): InstalledItem[] {
    const scanned: ScannedItem[] = [];
    for (const agent of agents) {
      scanned.push(...this.scanAgent(agent));
    }
    return this.merge(scanned, installed);
  }

  private scanAgent(agent: AgentName): ScannedItem[] {
    const items: ScannedItem[] = [];

    for (const name of listDirNames(SkillTranslator.skillsDir(agent))) {
      items.push({ type: 'skill', name, agent, removable: true });
    }

    for (const name of McpTranslator.listServerNames(agent)) {
      items.push({ type: 'mcpServer', name, agent, removable: true });
    }

    // Codex has no custom-agent support, so its agents dir is never populated by Amux.
    for (const basename of listMdBasenames(AgentTranslator.agentsDir(agent))) {
      const { name, pluginId } = parseAgentFilename(basename);
      items.push({ type: 'agent', name, agent, pluginId, removable: true });
    }

    for (const hook of HookTranslator.listInstalled(agent)) {
      // Only sentinel/marketplace hooks carry a pluginId — those are the ones we can remove.
      items.push({ type: 'hook', name: hook.event, agent, pluginId: hook.pluginId, removable: hook.pluginId !== undefined });
    }

    return items;
  }

  // Fold per-agent scan results into one item per (type, name), unioning the agent lists
  // and attaching registry attribution (source/pluginId/sourceUrl) where available.
  private merge(scanned: ScannedItem[], installed: InstalledPlugin[]): InstalledItem[] {
    const byKey = new Map<string, InstalledItem>();

    for (const item of scanned) {
      // Hooks: include pluginId in the key so two different plugins owning the same event
      // stay as separate rows. Items with no pluginId (external hooks) key on event alone
      // and merge across agents as before.
      const key = item.type === 'hook' && item.pluginId
        ? `${item.type}::${item.pluginId}::${item.name}`
        : `${item.type}::${item.name}`;
      const attribution = this.attribute(item, installed);

      const existing = byKey.get(key);
      if (existing) {
        if (!existing.agents.includes(item.agent)) existing.agents.push(item.agent);
        // Prefer amux attribution and preserve pluginId/sourceUrl if any agent had it.
        if (attribution.source === 'amux' && existing.source !== 'amux') {
          existing.source = 'amux';
          existing.pluginId = attribution.pluginId;
          existing.sourceUrl = attribution.sourceUrl;
        }
        // An item is removable only if removable everywhere it appears.
        existing.removable = existing.removable && item.removable;
      } else {
        byKey.set(key, {
          type: item.type,
          name: item.name,
          agents: [item.agent],
          source: attribution.source,
          pluginId: attribution.pluginId ?? item.pluginId,
          sourceUrl: attribution.sourceUrl,
          removable: item.removable,
        });
      }
    }

    return Array.from(byKey.values());
  }

  // Decide whether a scanned item was installed by Amux. Agents/hooks are attributable by
  // their on-disk pluginId; skills/mcp have no marker, so we consult the registry's
  // selectedArtifacts. Returns amux attribution when a match is found, else external.
  private attribute(
    item: ScannedItem,
    installed: InstalledPlugin[],
  ): { source: 'amux' | 'external'; pluginId?: string; sourceUrl?: string } {
    // Agents and hooks carry the pluginId on disk — match the owning registry record.
    if (item.pluginId) {
      const record = installed.find((i) => i.pluginId === item.pluginId);
      if (record) return { source: 'amux', pluginId: record.pluginId, sourceUrl: record.sourceUrl };
      // pluginId present but no registry record (e.g. registry pruned) — still Amux-shaped.
      return { source: 'amux', pluginId: item.pluginId };
    }

    // Skills / MCP: attributed only if a registry record lists them in selectedArtifacts.
    for (const record of installed) {
      const sel = record.selectedArtifacts;
      if (!sel) continue;
      const listed =
        (item.type === 'skill' && sel.skills.includes(item.name)) ||
        (item.type === 'mcpServer' && sel.mcpServers.includes(item.name));
      if (listed) return { source: 'amux', pluginId: record.pluginId, sourceUrl: record.sourceUrl };
    }

    return { source: 'external' };
  }
}
