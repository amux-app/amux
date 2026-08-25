import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { AgentName } from '../../utils/agentLaunch.js';
import type { HookEntry, TranslationResult } from './types.js';
import { loadJson } from './utils.js';

// Legacy sentinels are keyed as `${SENTINEL_PREFIX}${pluginId}__${event}__${index}`.
// New entries also persist the exact owner to avoid delimiter ambiguity in plugin IDs.
const SENTINEL_PREFIX = '__marketplace__';
const OWNER_FIELD = '__marketplaceOwner';

const EVENT_MAP_TO_OPENCODE: Record<string, string> = {
  PreToolUse: 'tool.execute.before',
  PostToolUse: 'tool.execute.after',
  PermissionRequest: 'permission.ask',
  UserPromptSubmit: 'chat.message',
  SessionStart: 'session.created',
  Stop: 'session.idle',
  SessionEnd: 'session.deleted',
  PreCompact: 'session.compacted',
  PostCompact: 'session.compacted',
};

function legacyHookOwner(value: unknown, event: string): string | null {
  if (typeof value !== 'string' || !value.startsWith(SENTINEL_PREFIX)) return null;
  const suffix = value.slice(SENTINEL_PREFIX.length);
  const eventMarker = `__${event}__`;
  const eventIndex = suffix.lastIndexOf(eventMarker);
  if (eventIndex < 0 || !/^\d+$/.test(suffix.slice(eventIndex + eventMarker.length))) return null;
  return suffix.slice(0, eventIndex);
}

function getOrCreateHookList(
  hookMap: Record<string, Record<string, unknown>[]>,
  event: string,
): Record<string, unknown>[] {
  const existing = Object.hasOwn(hookMap, event) ? hookMap[event] : undefined;
  if (Array.isArray(existing)) return existing;

  const list: Record<string, unknown>[] = [];
  Object.defineProperty(hookMap, event, {
    configurable: true,
    enumerable: true,
    value: list,
    writable: true,
  });
  return list;
}

function upsertHookEntry(
  list: Record<string, unknown>[],
  sentinel: string,
  entry: Record<string, unknown>,
): void {
  const index = list.findIndex((hook) => hook[SENTINEL_PREFIX] === sentinel);
  if (index === -1) list.push(entry);
  else list.splice(index, 1, entry);
}

/** Matches the exact owner on new entries and safely parses legacy sentinels. */
export function isMarketplaceHookOwnedBy(entry: unknown, pluginId: string, event: string): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const hook = entry as Record<string, unknown>;
  const owner = hook[OWNER_FIELD];
  if (typeof owner === 'string') return owner === pluginId;
  return legacyHookOwner(hook[SENTINEL_PREFIX], event) === pluginId;
}

export class HookTranslator {
  constructor(private readonly homeDir = os.homedir()) {}

  uninstallForAgent(pluginId: string, agent: AgentName): void {
    switch (agent) {
      case 'claude': this.uninstallFromClaude(pluginId); break;
      case 'codex': this.uninstallFromCodex(pluginId); break;
      case 'opencode': this.uninstallFromOpencode(pluginId); break;
      case 'pi': throw new Error('Marketplace hooks are not supported for Pi');
    }
  }

  // Translate all hooks for a plugin at once. This is the preferred call site because
  // OpenCode generates one combined JS file — calling translateForAgent in a loop would
  // overwrite it on each iteration.
  translateAllForAgent(hooks: HookEntry[], targetAgent: AgentName, pluginId: string): TranslationResult[] {
    if (hooks.length === 0) return [];
    if (targetAgent === 'pi') throw new Error('Marketplace hooks are not supported for Pi');
    if (targetAgent === 'opencode') {
      return [this.toOpencodeAll(hooks, pluginId)];
    }
    // Map ALL hooks — no-command hooks produce partial results rather than being silently dropped
    return hooks.map((hook, idx) => this.translateOne(hook, targetAgent, pluginId, idx));
  }

  // Single-hook translation (kept for callers that still use it one-by-one for Claude/Codex)
  translateForAgent(hook: HookEntry, targetAgent: AgentName, pluginId: string, hookIndex = 0): TranslationResult {
    if (!hook.command) {
      return { status: 'partial', path: '', skipped: [`${hook.event}: no shell command (JS-only hook)`] };
    }
    return this.translateOne(hook, targetAgent, pluginId, hookIndex);
  }

  private translateOne(hook: HookEntry, targetAgent: AgentName, pluginId: string, hookIndex: number): TranslationResult {
    if (!hook.command) {
      return { status: 'partial', path: '', skipped: [`${hook.event}: no shell command (JS-only hook)`] };
    }
    switch (targetAgent) {
      case 'claude': return this.toClaude(hook, pluginId, hookIndex);
      case 'codex': return this.toCodex(hook, pluginId, hookIndex);
      case 'opencode': return this.toOpencodeAll([hook], pluginId);
      case 'pi': throw new Error('Marketplace hooks are not supported for Pi');
    }
  }

  private sentinelKey(pluginId: string, event: string, index: number): string {
    return `${SENTINEL_PREFIX}${pluginId}__${event}__${index}`;
  }

  private toClaude(hook: HookEntry, pluginId: string, hookIndex: number): TranslationResult {
    const settingsPath = path.join(this.homeDir, '.claude', 'settings.json');
    mkdirSync(path.dirname(settingsPath), { recursive: true });

    const settings = loadJson(settingsPath);
    const hooksMap = this.ensureEventMap(settings, 'hooks');
    const list = getOrCreateHookList(hooksMap, hook.event);

    const sentinel = this.sentinelKey(pluginId, hook.event, hookIndex);
    const entry: Record<string, unknown> = {
      [SENTINEL_PREFIX]: sentinel,
      [OWNER_FIELD]: pluginId,
      ...(hook.matcher ? { matcher: { tool_name: hook.matcher } } : {}),
      hooks: [{ type: 'command', command: hook.command }],
    };
    // Replace existing entry with same sentinel key (idempotent re-install)
    upsertHookEntry(list, sentinel, entry);
    settings['hooks'] = hooksMap;

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    return { status: 'full', path: settingsPath, skipped: [] };
  }

  private toCodex(hook: HookEntry, pluginId: string, hookIndex: number): TranslationResult {
    const hooksPath = path.join(this.homeDir, '.codex', 'hooks.json');
    mkdirSync(path.dirname(hooksPath), { recursive: true });

    const data = loadJson(hooksPath);
    const list = getOrCreateHookList(
      data as Record<string, Record<string, unknown>[]>,
      hook.event,
    );

    const sentinel = this.sentinelKey(pluginId, hook.event, hookIndex);
    const entry: Record<string, unknown> = {
      [SENTINEL_PREFIX]: sentinel,
      [OWNER_FIELD]: pluginId,
      command: hook.command,
      ...(hook.matcher ? { matcher: hook.matcher } : {}),
    };
    upsertHookEntry(list, sentinel, entry);

    writeFileSync(hooksPath, JSON.stringify(data, null, 2), 'utf-8');
    return { status: 'full', path: hooksPath, skipped: [] };
  }

  // Generate one JS plugin file containing ALL hooks for this plugin.
  private toOpencodeAll(hooks: HookEntry[], pluginId: string): TranslationResult {
    const skipped: string[] = [];
    const pluginsDir = path.join(this.homeDir, '.config', 'opencode', 'plugins');
    mkdirSync(pluginsDir, { recursive: true });

    const registrations: string[] = [];
    for (const hook of hooks) {
      if (!hook.command) { skipped.push(`${hook.event}: no shell command`); continue; }
      const opencodeEvent = hook.sourceFormat === 'opencode'
        ? hook.event
        : EVENT_MAP_TO_OPENCODE[hook.event] ?? null;
      if (!opencodeEvent) { skipped.push(`${hook.event} has no OpenCode equivalent`); continue; }
      const matcherCheck = hook.matcher
        ? `    if (tool.name !== "${hook.matcher}") return;\n`
        : '';
      registrations.push(
        `  hooks["${opencodeEvent}"](async ({ tool }) => {\n${matcherCheck}    const { execSync } = await import("child_process");\n    execSync(${JSON.stringify(hook.command)}, { stdio: "inherit" });\n  });`,
      );
    }

    const pluginPath = path.join(pluginsDir, `marketplace-${pluginId}.js`);
    if (registrations.length === 0) {
      return { status: 'partial', path: '', skipped };
    }
    const content = `export const name = "marketplace-${pluginId}";\nexport function setup({ hooks }) {\n${registrations.join('\n')}\n}\n`;
    writeFileSync(pluginPath, content, 'utf-8');
    return { status: skipped.length > 0 ? 'partial' : 'full', path: pluginPath, skipped };
  }

  private uninstallFromClaude(pluginId: string): void {
    const settingsPath = path.join(this.homeDir, '.claude', 'settings.json');
    if (!existsSync(settingsPath)) return;

    const settings = loadJson(settingsPath);
    if (!settings['hooks'] || typeof settings['hooks'] !== 'object') return;

    const hooksMap = settings['hooks'] as Record<string, Record<string, unknown>[]>;
    for (const event of Object.keys(hooksMap)) {
      hooksMap[event] = hooksMap[event].filter((hook) => !isMarketplaceHookOwnedBy(hook, pluginId, event));
      if (hooksMap[event].length === 0) delete hooksMap[event];
    }
    if (Object.keys(hooksMap).length === 0) delete settings['hooks'];

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  }

  private uninstallFromCodex(pluginId: string): void {
    const hooksPath = path.join(this.homeDir, '.codex', 'hooks.json');
    if (!existsSync(hooksPath)) return;

    const data = loadJson(hooksPath);
    for (const event of Object.keys(data)) {
      const list = data[event] as Record<string, unknown>[];
      data[event] = list.filter((hook) => !isMarketplaceHookOwnedBy(hook, pluginId, event));
      if ((data[event] as unknown[]).length === 0) delete data[event];
    }

    writeFileSync(hooksPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  private uninstallFromOpencode(pluginId: string): void {
    const pluginPath = path.join(
      this.homeDir, '.config', 'opencode', 'plugins', `marketplace-${pluginId}.js`,
    );
    try { rmSync(pluginPath, { force: true }); } catch { /* already removed */ }
  }

  private ensureEventMap(obj: Record<string, unknown>, key: string): Record<string, Record<string, unknown>[]> {
    if (!obj[key] || typeof obj[key] !== 'object' || Array.isArray(obj[key])) {
      obj[key] = {};
    }
    return obj[key] as Record<string, Record<string, unknown>[]>;
  }
}
