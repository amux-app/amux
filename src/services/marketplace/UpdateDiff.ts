import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import type {
  DetectedPlugin,
  HookEntry,
  MarketplaceSource,
  McpServerEntry,
  NewArtifact,
  SourceArtifactSnapshot,
  SourceUpdate,
} from './types.js';

type SnapshotEntry = SourceArtifactSnapshot[string];
// A snapshot entry as it may exist on disk: current shape (name → hash) or the
// legacy shape (bare name[]) written before content hashing was introduced.
type RawSnapshotEntry = {
  skills: Record<string, string> | string[];
  mcpServers: Record<string, string> | string[];
  agents: Record<string, string> | string[];
  jsPlugins: Record<string, string> | string[];
  hookEvents: Record<string, string> | string[];
};

function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

// Hash a file's contents; missing/unreadable files hash to a stable sentinel so a
// later successful read reliably registers as a change.
function hashFile(filePath: string): string {
  try {
    if (!existsSync(filePath)) return 'missing';
    return sha1(readFileSync(filePath, 'utf-8'));
  } catch {
    return 'unreadable';
  }
}

// Hash an entire directory tree by sorting entries and hashing path+content pairs.
// Falls back to hashFile when the path is a plain file (e.g. agent .md paths).
function hashDir(dirPath: string): string {
  try {
    const stat = statSync(dirPath);
    if (!stat.isDirectory()) return hashFile(dirPath);
    const h = createHash('sha1');
    const walk = (dir: string) => {
      const entries = readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(dirPath, full);
        if (entry.isDirectory()) {
          walk(full);
        } else {
          h.update(rel);
          try { h.update(readFileSync(full)); } catch { h.update('unreadable'); }
        }
      }
    };
    walk(dirPath);
    return h.digest('hex');
  } catch {
    return 'unreadable';
  }
}

// MCP servers have no single backing file, so hash their resolved config instead.
function hashMcp(server: McpServerEntry): string {
  return sha1(JSON.stringify({
    type: server.type ?? 'stdio',
    command: server.command ?? '',
    args: server.args ?? [],
    url: server.url ?? '',
    env: server.env ?? {},
    startupTimeoutSec: server.startupTimeoutSec ?? null,
  }));
}

// Hooks are defined by their command + matcher; hash those.
function hashHook(hook: HookEntry): string {
  return sha1(JSON.stringify({ command: hook.command ?? '', matcher: hook.matcher ?? '' }));
}

// Reduce a source's detected plugins to a per-plugin, per-type map of item name →
// content hash. This is the baseline later checks diff against to surface both newly
// added and content-changed items.
export function buildSnapshot(plugins: DetectedPlugin[]): SourceArtifactSnapshot {
  const snapshot: SourceArtifactSnapshot = {};
  for (const plugin of plugins) {
    const skills: Record<string, string> = {};
    for (const s of plugin.skills) skills[s.name] = hashDir(path.dirname(s.path));
    const agents: Record<string, string> = {};
    for (const a of plugin.agents) agents[a.name] = hashFile(a.path);
    const jsPlugins: Record<string, string> = {};
    for (const j of plugin.jsPlugins) jsPlugins[j.name] = hashFile(j.path);
    const mcpServers: Record<string, string> = {};
    for (const m of plugin.mcpServers) mcpServers[m.name] = hashMcp(m);
    const hookEvents: Record<string, string> = {};
    for (const h of plugin.hooks) hookEvents[h.event] = hashHook(h);

    snapshot[plugin.id] = { skills, agents, jsPlugins, mcpServers, hookEvents };
  }
  return snapshot;
}

// Coerce a possibly-legacy snapshot entry into the current name→hash shape. Legacy
// entries (string[]) carry names but no hashes, so each name maps to the LEGACY_HASH
// sentinel: the diff treats it as "known, content unknown" — not 'new', and never
// falsely 'updated' — and this same check rebaselines it to a real hash.
function normalizeSnapshotEntry(entry: RawSnapshotEntry | undefined): SnapshotEntry | undefined {
  if (!entry) return undefined;
  const coerce = (v: Record<string, string> | string[]): Record<string, string> => {
    if (Array.isArray(v)) {
      const out: Record<string, string> = {};
      for (const name of v) out[name] = LEGACY_HASH;
      return out;
    }
    return v;
  };
  return {
    skills: coerce(entry.skills),
    mcpServers: coerce(entry.mcpServers),
    agents: coerce(entry.agents),
    jsPlugins: coerce(entry.jsPlugins),
    hookEvents: coerce(entry.hookEvents),
  };
}

// Sentinel hash for items carried over from a legacy (names-only) snapshot. The diff
// treats a LEGACY baseline as "present, content unknown" and never reports it as
// 'updated' — it rebaselines to a real hash on this same check.
const LEGACY_HASH = '__legacy__';

// Diff a source's current plugins against the last-seen snapshot. Returns one
// SourceUpdate per plugin that gained new or content-changed items:
//   - name absent from snapshot           → changeType 'new'
//   - name present but hash differs        → changeType 'updated'
//   - name present, prior hash is LEGACY   → skipped (no baseline to compare)
// A plugin absent from the previous snapshot is entirely new.
export function diffAgainstSnapshot(
  source: Pick<MarketplaceSource, 'url' | 'name'>,
  plugins: DetectedPlugin[],
  previous: SourceArtifactSnapshot | undefined,
): SourceUpdate[] {
  const updates: SourceUpdate[] = [];
  const changedAt = new Date().toISOString();
  for (const plugin of plugins) {
    const prev = normalizeSnapshotEntry(previous?.[plugin.id] as RawSnapshotEntry | undefined);
    const newArtifacts: NewArtifact[] = [];

    const addChanged = (
      type: NewArtifact['type'],
      current: Array<{ name: string; description?: string; hash: string }>,
      prevHashes: Record<string, string> | undefined,
    ) => {
      for (const item of current) {
        const priorHash = prevHashes?.[item.name];
        if (priorHash === undefined) {
          newArtifacts.push({ type, name: item.name, description: item.description, changeType: 'new', changedAt });
        } else if (priorHash !== LEGACY_HASH && priorHash !== item.hash) {
          newArtifacts.push({ type, name: item.name, description: item.description, changeType: 'updated', changedAt });
        }
      }
    };

    addChanged('skill', plugin.skills.map((s) => ({ name: s.name, description: s.description, hash: hashDir(path.dirname(s.path)) })), prev?.skills);
    addChanged('mcpServer', plugin.mcpServers.map((m) => ({ name: m.name, description: m.description, hash: hashMcp(m) })), prev?.mcpServers);
    addChanged('agent', plugin.agents.map((a) => ({ name: a.name, description: a.description, hash: hashFile(a.path) })), prev?.agents);
    addChanged('jsPlugin', plugin.jsPlugins.map((j) => ({ name: j.name, hash: hashFile(j.path) })), prev?.jsPlugins);
    addChanged('hook', plugin.hooks.map((h) => ({ name: h.event, hash: hashHook(h) })), prev?.hookEvents);

    if (newArtifacts.length > 0) {
      updates.push({
        sourceUrl: source.url,
        sourceName: source.name,
        pluginId: plugin.id,
        pluginName: plugin.name,
        newArtifacts,
      });
    }
  }
  return updates;
}
