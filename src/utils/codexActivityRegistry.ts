import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import { shQuote } from './shellEscape.js';

const MUXBASE_INTERNAL_DIR = join(homedir(), '.muxbase', 'internal');
const CODEX_DIR = join(homedir(), '.codex');
const CODEX_HOOKS_PATH = join(CODEX_DIR, 'hooks.json');
const CODEX_HOOK_SCRIPT_PATH = join(MUXBASE_INTERNAL_DIR, 'record-codex-activity.cjs');

const CODEX_ACTIVITY_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Stop',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'SubagentStart',
  'SubagentStop',
] as const;

const HOOK_SCRIPT = `'use strict';
const fs = require('fs');
const path = require('path');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const journal = process.env.MUXBASE_ACTIVITY_JOURNAL;
    const paneId = process.env.MUXBASE_PANE_ID;
    const paneIncarnationId = process.env.MUXBASE_PANE_INCARNATION_ID;
    const data = JSON.parse(raw || '{}');
    const kind = eventKind(data.hook_event_name);
    if (!journal || !paneId || !paneIncarnationId || !kind) return;
    const entityId = data.hook_event_name === 'SubagentStart' || data.hook_event_name === 'SubagentStop'
      ? data.agent_id
      : undefined;
    const entity = data.hook_event_name === 'SubagentStart'
      ? { kind: 'subagent', mutating: 'unknown', sinceWallMs: Date.now() }
      : undefined;
    const record = {
      eventId: [data.hook_event_name, data.session_id || '', data.turn_id || '', process.pid, Date.now()].join(':'),
      kind,
      origin: 'adapter',
      paneId,
      paneIncarnationId,
      sessionId: data.session_id,
      turnId: data.turn_id,
      emittedAt: Date.now(),
      entityId,
      entity,
      waitReason: data.hook_event_name === 'PermissionRequest' ? 'permission' : undefined,
    };
    const encoded = JSON.stringify(record);
    if (Buffer.byteLength(encoded) >= 4096) return;
    fs.mkdirSync(path.dirname(journal), { recursive: true, mode: 0o700 });
    rotateJournalIfNeeded(journal);
    const fd = fs.openSync(journal, 'a', 0o600);
    try { fs.writeSync(fd, encoded + '\\n'); } finally { fs.closeSync(fd); }
    if (data.hook_event_name === 'SessionStart') {
      const handshake = JSON.stringify({
        eventId: ['handshake', data.session_id || '', process.pid, Date.now()].join(':'),
        kind: 'adapter_handshake',
        origin: 'adapter',
        paneId,
        paneIncarnationId,
        sessionId: data.session_id,
        adapterVersion: process.env.MUXBASE_ACTIVITY_ADAPTER_VERSION || data.version || 'unknown',
        adapterSupport: process.env.MUXBASE_ACTIVITY_ADAPTER_SUPPORT === 'full' || process.env.MUXBASE_ACTIVITY_ADAPTER_SUPPORT === 'partial'
          ? process.env.MUXBASE_ACTIVITY_ADAPTER_SUPPORT
          : 'partial',
        adapterCapabilities: parseAdapterCapabilities(),
        emittedAt: Date.now(),
      });
      if (Buffer.byteLength(handshake) < 4096) {
        const handshakeFd = fs.openSync(journal, 'a', 0o600);
        try { fs.writeSync(handshakeFd, handshake + '\\n'); } finally { fs.closeSync(handshakeFd); }
      }
    }
  } catch {
    // Hooks are observational and must never alter Codex control flow.
  }
});

function parseAdapterCapabilities() {
  try {
    const value = JSON.parse(process.env.MUXBASE_ACTIVITY_ADAPTER_CAPABILITIES || '[]');
    return Array.isArray(value) ? value : [];
  } catch (_) {
    return [];
  }
}

function rotateJournalIfNeeded(journal) {
  try {
    if (!fs.existsSync(journal) || fs.statSync(journal).size < 4 * 1024 * 1024) return;
    const rotated = journal + '.' + Date.now() + '.' + process.pid;
    fs.renameSync(journal, rotated);
    const freshFd = fs.openSync(journal, 'a', 0o600);
    fs.closeSync(freshFd);
    const prefix = path.basename(journal) + '.';
    const rotatedFiles = fs.readdirSync(path.dirname(journal))
      .filter((name) => name.startsWith(prefix))
      .map((name) => path.join(path.dirname(journal), name))
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
    for (const old of rotatedFiles.slice(2)) fs.unlinkSync(old);
  } catch (_) {}
}

function eventKind(name) {
  switch (name) {
    case 'SessionStart': return 'session_start';
    case 'SessionEnd': return 'session_end';
    case 'UserPromptSubmit': return 'turn_start_candidate';
    case 'Stop': return 'turn_end_candidate';
    case 'PreToolUse': return 'turn_started';
    case 'PostToolUse': return 'wait_resolved';
    case 'PermissionRequest': return 'wait_started_candidate';
    case 'SubagentStart': return 'background_started';
    case 'SubagentStop': return 'background_ended';
    default: return null;
  }
}
`;

type HookHandler = { async?: boolean; command: string; type: 'command' };
type HookGroup = { hooks: HookHandler[] };
type CodexHooksFile = { description?: string; hooks?: Record<string, HookGroup[]> };

/**
 * Installs additive Codex hook groups after the user has explicitly enabled
 * lifecycle adapters. Existing hooks are preserved byte-for-byte in meaning;
 * malformed settings fail closed rather than being overwritten.
 */
export function ensureCodexActivityHookSettings(): string | null {
  try {
    mkdirSync(MUXBASE_INTERNAL_DIR, { recursive: true, mode: 0o700 });
    mkdirSync(CODEX_DIR, { recursive: true, mode: 0o700 });
    if (readFileSafe(CODEX_HOOK_SCRIPT_PATH) !== HOOK_SCRIPT) {
      writeFileSync(CODEX_HOOK_SCRIPT_PATH, HOOK_SCRIPT, { mode: 0o700 });
    }
    chmodSync(CODEX_HOOK_SCRIPT_PATH, 0o700);

    const settings = readHooksFile();
    if (!settings) return null;
    const command = `node ${shQuote(CODEX_HOOK_SCRIPT_PATH)}`;
    const hooks = settings.hooks ?? {};
    for (const event of CODEX_ACTIVITY_EVENTS) {
      const groups = hooks[event] ?? [];
      if (!Array.isArray(groups) || !groups.every(isHookGroup)) return null;
      let found = false;
      const normalizedGroups = groups.map((group) => ({
        ...group,
        hooks: group.hooks.map((hook) => {
          if (hook.command !== command) return hook;
          found = true;
          return { command, type: 'command' as const };
        }),
      }));
      hooks[event] = found
        ? normalizedGroups
        : [...normalizedGroups, { hooks: [{ command, type: 'command' }] }];
    }
    writeHooksFile({ ...settings, hooks });
    return CODEX_HOOKS_PATH;
  } catch {
    return null;
  }
}

/** Removes only MuxBase-owned groups, preserving every user-defined hook. */
export function removeCodexActivityHookSettings(): boolean {
  const settings = readHooksFile();
  if (!settings?.hooks) return false;
  const command = `node ${shQuote(CODEX_HOOK_SCRIPT_PATH)}`;
  let changed = false;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups) || !groups.every(isHookGroup)) return false;
    const retained = groups
      .map((group) => {
        const handlers = group.hooks.filter((hook) => hook.command !== command);
        if (handlers.length !== group.hooks.length) changed = true;
        return handlers.length > 0 ? { ...group, hooks: handlers } : null;
      })
      .filter((group): group is HookGroup => group !== null);
    if (retained.length > 0) hooks[event] = retained;
  }
  if (!changed) return false;
  try {
    writeHooksFile({ ...settings, hooks });
    return true;
  } catch {
    return false;
  }
}

function readHooksFile(): CodexHooksFile | null {
  let content: string;
  try {
    content = readFileSync(CODEX_HOOKS_PATH, 'utf8');
  } catch (error) {
    // Only a genuinely absent file may be treated as empty. Any other read
    // failure must not let a write replace the user's existing hooks.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { hooks: {} } : null;
  }
  try {
    const value = JSON.parse(content) as unknown;
    if (!isRecord(value) || (value.hooks !== undefined && !isRecord(value.hooks))) return null;
    return value as CodexHooksFile;
  } catch {
    return null;
  }
}

function writeHooksFile(settings: CodexHooksFile): void {
  const temporaryPath = `${CODEX_HOOKS_PATH}.${randomUUID()}.tmp`;
  const mode = existingFileMode(CODEX_HOOKS_PATH) ?? 0o600;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode });
    renameSync(temporaryPath, CODEX_HOOKS_PATH);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Best-effort cleanup; preserve the original write error.
    }
    throw error;
  }
}

function existingFileMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

function isHookGroup(value: unknown): value is HookGroup {
  return isRecord(value)
    && Array.isArray(value.hooks)
    && value.hooks.every((hook) => isRecord(hook) && hook.type === 'command' && typeof hook.command === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
