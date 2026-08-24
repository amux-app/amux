import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { shQuote } from './shellEscape.js';

export interface ClaudeSessionRecord {
  paneId: string;
  sessionId?: string;
  transcriptPath: string;
  source?: string;
  cwd?: string;
  updatedAt: number;
}

const AUMX_DIR = join(homedir(), '.aumx');
const REGISTRY_DIR = join(AUMX_DIR, 'claude-sessions');
const INTERNAL_DIR = join(AUMX_DIR, 'internal');
const WRAPPER_DIR = join(INTERNAL_DIR, 'bin');
const CLAUDE_WRAPPER_PATH = join(WRAPPER_DIR, 'claude');
const HOOK_SCRIPT_PATH = join(INTERNAL_DIR, 'record-claude-session.cjs');
const HOOK_SETTINGS_PATH = join(INTERNAL_DIR, 'claude-session-hook.settings.json');

const HOOK_SCRIPT = `'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function formatError(error) {
  if (error && error.stack) return error.stack;
  if (error && error.message) return error.message;
  return String(error);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const paneId = process.env.AUMX_PANE_ID;
    if (!paneId) return;
    const data = JSON.parse(raw || '{}');
    appendActivityEvent(paneId, data);
    const transcriptPath = data.transcript_path;
    if (typeof transcriptPath !== 'string' || /[\\\\/]subagents[\\\\/]/.test(transcriptPath)) return;
    const dir = path.join(os.homedir(), '.aumx', 'claude-sessions');
    fs.mkdirSync(dir, { recursive: true });
    const safe = paneId.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const payload = JSON.stringify({
      paneId: paneId,
      sessionId: data.session_id,
      transcriptPath: transcriptPath,
      source: data.source,
      cwd: data.cwd,
      updatedAt: Date.now(),
    });
    const tmp = path.join(dir, safe + '.json.' + process.pid + '.tmp');
    const finalPath = path.join(dir, safe + '.json');
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.renameSync(tmp, finalPath);
  } catch (error) {
    process.stderr.write('[aumx] Failed to record Claude session: ' + formatError(error) + '\\n');
  }
});

function appendActivityEvent(paneId, data) {
  const journal = process.env.AUMX_ACTIVITY_JOURNAL;
  const paneIncarnationId = process.env.AUMX_PANE_INCARNATION_ID;
  const kind = eventKind(data.hook_event_name);
  if (!journal || !paneIncarnationId || !kind) return;
  if (data.hook_event_name === 'Notification' && !humanInputNotification(data.notification_type)) return;
  const turnId = stableTurnId(paneId, data);
  appendRecord(journal, {
    eventId: [data.hook_event_name, data.session_id || '', turnId || '', process.pid, Date.now()].join(':'),
    kind,
    origin: 'adapter',
    paneId,
    paneIncarnationId,
    sessionId: data.session_id,
    turnId,
    emittedAt: Date.now(),
    entityId: backgroundEntityId(data),
    entity: backgroundEntity(data),
    background_snapshot: data.hook_event_name === 'Stop' ? backgroundSnapshot(data) : undefined,
    waitReason: notificationWaitReason(data),
  });
  if (data.hook_event_name === 'SessionStart') {
    appendRecord(journal, {
      eventId: ['handshake', data.session_id || '', process.pid, Date.now()].join(':'),
      kind: 'adapter_handshake',
      origin: 'adapter',
      paneId,
      paneIncarnationId,
      sessionId: data.session_id,
      adapterVersion: process.env.AUMX_ACTIVITY_ADAPTER_VERSION || data.version || 'unknown',
      adapterSupport: process.env.AUMX_ACTIVITY_ADAPTER_SUPPORT === 'full' || process.env.AUMX_ACTIVITY_ADAPTER_SUPPORT === 'partial'
        ? process.env.AUMX_ACTIVITY_ADAPTER_SUPPORT
        : 'partial',
      adapterCapabilities: parseAdapterCapabilities(),
      emittedAt: Date.now(),
    });
  }
}

function appendRecord(journal, record) {
  const encoded = JSON.stringify(record);
  if (Buffer.byteLength(encoded) >= 4096) return;
  fs.mkdirSync(path.dirname(journal), { recursive: true, mode: 0o700 });
  rotateJournalIfNeeded(journal);
  const fd = fs.openSync(journal, 'a', 0o600);
  try { fs.writeSync(fd, encoded + '\\n'); } finally { fs.closeSync(fd); }
}

function rotateJournalIfNeeded(journal) {
  try {
    if (!fs.existsSync(journal) || fs.statSync(journal).size < 4 * 1024 * 1024) return;
    const rotated = journal + '.' + Date.now() + '.' + process.pid;
    fs.renameSync(journal, rotated);
    const fd = fs.openSync(journal, 'a', 0o600);
    fs.closeSync(fd);
    const prefix = path.basename(journal) + '.';
    const files = fs.readdirSync(path.dirname(journal))
      .filter((name) => name.startsWith(prefix))
      .map((name) => path.join(path.dirname(journal), name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const old of files.slice(2)) fs.unlinkSync(old);
  } catch (_) {}
}

function stableTurnId(paneId, data) {
  if (typeof data.prompt_id === 'string' && data.prompt_id) return data.prompt_id;
  if (typeof data.session_id !== 'string' || !data.session_id) return undefined;
  const safePaneId = paneId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const statePath = path.join(os.homedir(), '.aumx', 'claude-turns', safePaneId + '.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) {}
  if (data.hook_event_name === 'UserPromptSubmit' || !state.turnId || state.sessionId !== data.session_id) {
    state = { generation: (Number(state.generation) || 0) + 1, sessionId: data.session_id, turnId: 'legacy-session-turn:' + data.session_id + ':' + ((Number(state.generation) || 0) + 1) };
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
      const temporary = statePath + '.' + process.pid + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(temporary, statePath);
    } catch (_) {}
  }
  return state.turnId;
}

function notificationWaitReason(data) {
  if (data.hook_event_name === 'PermissionRequest') return 'permission';
  if (data.hook_event_name === 'Elicitation') return 'elicitation';
  if (data.hook_event_name !== 'Notification') return undefined;
  return humanInputNotification(data.notification_type) ? 'question' : undefined;
}

function humanInputNotification(type) {
  return type === 'permission_prompt' || type === 'question_prompt'
    || type === 'input_required' || type === 'elicitation_dialog';
}

function backgroundSnapshot(data) {
  const entities = [];
  for (const task of Array.isArray(data.background_tasks) ? data.background_tasks : []) {
    if (typeof task !== 'object' || task === null) continue;
    const entityId = task.id || task.task_id || task.agent_id;
    if (typeof entityId !== 'string' || !entityId) continue;
    entities.push({ entityId, kind: task.agent_id ? 'subagent' : 'task', mutating: 'unknown', sinceWallMs: Date.now() });
  }
  for (const cron of Array.isArray(data.session_crons) ? data.session_crons : []) {
    if (typeof cron !== 'object' || cron === null) continue;
    const entityId = cron.id || cron.cron_id;
    if (typeof entityId !== 'string' || !entityId) continue;
    entities.push({ entityId, kind: 'cron', mutating: 'unknown', sinceWallMs: Date.now() });
  }
  return entities;
}

function parseAdapterCapabilities() {
  try {
    const value = JSON.parse(process.env.AUMX_ACTIVITY_ADAPTER_CAPABILITIES || '[]');
    return Array.isArray(value) ? value : [];
  } catch (_) {
    return [];
  }
}

function eventKind(name) {
  switch (name) {
    case 'SessionStart': return 'session_start';
    case 'SessionEnd': return 'session_end';
    case 'UserPromptSubmit': return 'turn_start_candidate';
    case 'Stop': return 'turn_end_candidate';
    case 'StopFailure': return 'turn_failed';
    case 'PermissionRequest': return 'wait_started_candidate';
    case 'PreToolUse': return 'turn_started';
    case 'PostToolUse': return 'wait_resolved';
    case 'Elicitation': return 'wait_started_candidate';
    case 'ElicitationResult': return 'wait_resolved';
    case 'Notification': return 'wait_started_candidate';
    case 'PreCompact': return 'compaction_started';
    case 'PostCompact': return 'compaction_settled';
    case 'SubagentStart': return 'background_started';
    case 'SubagentStop': return 'background_ended';
    case 'TaskCreated': return 'background_started';
    case 'TaskCompleted': return 'background_ended';
    default: return null;
  }
}

function backgroundEntityId(data) {
  if (data.hook_event_name === 'SubagentStart' || data.hook_event_name === 'SubagentStop') return data.agent_id;
  if (data.hook_event_name === 'TaskCreated' || data.hook_event_name === 'TaskCompleted') return data.task_id;
  return undefined;
}

function backgroundEntity(data) {
  if (data.hook_event_name === 'SubagentStart') return { kind: 'subagent', mutating: 'unknown', sinceWallMs: Date.now() };
  if (data.hook_event_name === 'TaskCreated') return { kind: 'task', mutating: 'unknown', sinceWallMs: Date.now() };
  return undefined;
}
`;

function buildHookSettings(): string {
  const command = `node ${shQuote(HOOK_SCRIPT_PATH)}`;
  const hook = { hooks: [{ type: 'command', command }] };
  return JSON.stringify({
    _aumxHookVersion: 2,
    hooks: {
      SessionStart: [hook],
      SessionEnd: [hook],
      UserPromptSubmit: [hook],
      Stop: [hook],
      StopFailure: [hook],
      PermissionRequest: [hook],
      PreToolUse: [hook],
      PostToolUse: [hook],
      Elicitation: [hook],
      ElicitationResult: [hook],
      SubagentStart: [hook],
      SubagentStop: [hook],
      TaskCreated: [hook],
      TaskCompleted: [hook],
      Notification: [hook],
      PreCompact: [hook],
      PostCompact: [hook],
    },
  });
}

function buildClaudeWrapper(settingsPath: string): string {
  return `#!/bin/sh
if [ -n "$AUMX_CLAUDE_ORIGINAL_PATH" ]; then
  PATH="$AUMX_CLAUDE_ORIGINAL_PATH"
  export PATH
fi
exec claude --settings ${shQuote(settingsPath)} "$@"
`;
}

export function registryRecordPath(paneId: string): string {
  const safe = paneId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return join(REGISTRY_DIR, `${safe}.json`);
}

export function ensureClaudeSessionHookSettings(): string | null {
  try {
    mkdirSync(INTERNAL_DIR, { recursive: true });
    mkdirSync(REGISTRY_DIR, { recursive: true });
    if (readFileSafe(HOOK_SCRIPT_PATH) !== HOOK_SCRIPT) writeFileSync(HOOK_SCRIPT_PATH, HOOK_SCRIPT, { mode: 0o600 });
    const settings = buildHookSettings();
    if (readFileSafe(HOOK_SETTINGS_PATH) !== settings) writeFileSync(HOOK_SETTINGS_PATH, settings, { mode: 0o600 });
    JSON.parse(readFileSync(HOOK_SETTINGS_PATH, 'utf8'));
    return HOOK_SETTINGS_PATH;
  } catch {
    return null;
  }
}

export function ensureClaudeSessionShellWrapper(settingsPath: string): string | null {
  try {
    mkdirSync(WRAPPER_DIR, { recursive: true });
    const wrapper = buildClaudeWrapper(settingsPath);
    if (readFileSafe(CLAUDE_WRAPPER_PATH) !== wrapper) writeFileSync(CLAUDE_WRAPPER_PATH, wrapper, { mode: 0o700 });
    chmodSync(CLAUDE_WRAPPER_PATH, 0o700);
    return WRAPPER_DIR;
  } catch {
    return null;
  }
}

/** Removes only the files owned by Amux; user Claude settings are untouched. */
export function removeClaudeSessionHookSettings(): boolean {
  let removed = false;
  for (const path of [HOOK_SCRIPT_PATH, HOOK_SETTINGS_PATH, CLAUDE_WRAPPER_PATH]) {
    try {
      unlinkSync(path);
      removed = true;
    } catch {
      // Missing owned artifacts are already removed.
    }
  }
  return removed;
}

export function readRegisteredSession(paneId: string): ClaudeSessionRecord | null {
  try {
    const record = JSON.parse(readFileSync(registryRecordPath(paneId), 'utf8')) as ClaudeSessionRecord;
    if (record && typeof record.transcriptPath === 'string' && record.transcriptPath.length > 0) {
      return record;
    }
  } catch {
  }
  return null;
}

export function deleteRegisteredSession(paneId: string): void {
  try {
    unlinkSync(registryRecordPath(paneId));
  } catch {
  }
}

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
