import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { atomicWriteFileSync } from './atomicWrite.js';

const PLUGIN_DIRECTORY = join(homedir(), '.config', 'opencode', 'plugins');
const PLUGIN_PATH = join(PLUGIN_DIRECTORY, 'aumx-activity.js');
const CONSENT_PATH = join(homedir(), '.config', 'opencode', 'aumx-activity.enabled');
const OWNERSHIP_MARKER = '// AUMX_ACTIVITY_ADAPTER: opencode:v1';

const PLUGIN_SOURCE = `${OWNERSHIP_MARKER}
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const consentPath = ${JSON.stringify(CONSENT_PATH)};

export const AumxActivityPlugin = async () => {
  const activeTurnIds = new Map();
  const handshakenSessions = new Set();
  return {
    event: async ({ event }) => {
      try {
        if (!existsSync(consentPath)) return;
        const journal = process.env.AUMX_ACTIVITY_JOURNAL;
        const paneId = process.env.AUMX_PANE_ID;
        const paneIncarnationId = process.env.AUMX_PANE_INCARNATION_ID;
        const properties = event.properties ?? event;
        const sessionId = properties.sessionID ?? properties.sessionId;
        const status = properties.status?.type ?? properties.status;
        const kind = activityKind(event.type, status);
        if (!journal || !paneId || !paneIncarnationId || !kind) return;
        let turnId = properties.turnID ?? properties.turnId;
        if (!turnId && sessionId) {
          turnId = activeTurnIds.get(sessionId);
          if (!turnId && event.type === 'session.status' && (status === 'busy' || status === 'retry')) {
            turnId = randomUUID();
            activeTurnIds.set(sessionId, turnId);
          }
        }
        const record = {
          eventId: randomUUID(),
          kind,
          origin: 'adapter',
          paneId,
          paneIncarnationId,
          sessionId,
          turnId,
          emittedAt: Date.now(),
          waitReason: event.type === 'permission.asked' ? 'permission' : undefined,
        };
        if (event.type === 'session.error') record.kind = 'turn_failure_candidate';
        const encoded = JSON.stringify(record);
        if (Buffer.byteLength(encoded) >= 4096) return;
        mkdirSync(dirname(journal), { recursive: true, mode: 0o700 });
        rotateJournalIfNeeded(journal);
        appendFileSync(journal, encoded + '\\n', { mode: 0o600 });
        if (sessionId && !handshakenSessions.has(sessionId)) {
          const handshake = JSON.stringify({
            eventId: randomUUID(),
            kind: 'adapter_handshake',
            origin: 'adapter',
            paneId,
            paneIncarnationId,
            sessionId,
            adapterVersion: process.env.AUMX_ACTIVITY_ADAPTER_VERSION ?? properties.version ?? 'unknown',
            adapterSupport: process.env.AUMX_ACTIVITY_ADAPTER_SUPPORT === 'full' || process.env.AUMX_ACTIVITY_ADAPTER_SUPPORT === 'partial'
              ? process.env.AUMX_ACTIVITY_ADAPTER_SUPPORT
              : 'partial',
            adapterCapabilities: parseAdapterCapabilities(),
            emittedAt: Date.now(),
          });
          appendFileSync(journal, handshake + '\\n', { mode: 0o600 });
          handshakenSessions.add(sessionId);
        }
        if (sessionId && (event.type === 'session.idle' || (event.type === 'session.status' && status === 'idle'))) {
          activeTurnIds.delete(sessionId);
        }
      } catch {
        // An observer must never change the agent's execution path.
      }
    },
  };
};

function activityKind(type, status) {
  if (type === 'session.status') {
    if (status === 'busy' || status === 'retry') return 'turn_started';
    if (status === 'idle') return 'turn_settled';
  }
  if (type === 'session.idle') return 'turn_settled';
  if (type === 'permission.asked') return 'wait_started';
  if (type === 'permission.replied') return 'wait_resolved';
  if (type === 'session.error') return 'turn_failure_candidate';
  return null;
}

function parseAdapterCapabilities() {
  try {
    const value = JSON.parse(process.env.AUMX_ACTIVITY_ADAPTER_CAPABILITIES || '[]');
    return Array.isArray(value) ? value : [];
  } catch (_) {
    return [];
  }
}

function rotateJournalIfNeeded(journal) {
  try {
    if (!existsSync(journal) || statSync(journal).size < 4 * 1024 * 1024) return;
    const rotated = journal + '.' + Date.now() + '.' + process.pid;
    renameSync(journal, rotated);
    const freshFd = openSync(journal, 'a', 0o600);
    closeSync(freshFd);
    const prefix = journal.split('/').pop() + '.';
    const rotatedFiles = readdirSync(dirname(journal))
      .filter((name) => name.startsWith(prefix))
      .map((name) => dirname(journal) + '/' + name)
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    for (const old of rotatedFiles.slice(2)) unlinkSync(old);
  } catch (_) {}
}
`;

export function openCodeActivityPluginPath(): string {
  return PLUGIN_PATH;
}

/** Installs an additive OpenCode local plugin after explicit user consent. */
export function ensureOpenCodeActivityPlugin(): string | null {
  try {
    mkdirSync(PLUGIN_DIRECTORY, { recursive: true, mode: 0o700 });
    const existing = readFileSafe(PLUGIN_PATH);
    if (existing !== null && !isOwned(existing)) return null;
    if (existing !== PLUGIN_SOURCE) {
      atomicWriteFileSync(PLUGIN_PATH, PLUGIN_SOURCE);
    }
    chmodSync(PLUGIN_PATH, 0o600);
    atomicWriteFileSync(CONSENT_PATH, 'enabled\n');
    chmodSync(CONSENT_PATH, 0o600);
    return PLUGIN_PATH;
  } catch {
    return null;
  }
}

export function removeOpenCodeActivityPlugin(): boolean {
  removeConsentGate();
  const existing = readFileSafe(PLUGIN_PATH);
  if (existing === null) return true;
  if (!isOwned(existing)) return false;
  try {
    unlinkSync(PLUGIN_PATH);
    return true;
  } catch {
    return false;
  }
}

function isOwned(source: string): boolean {
  return source.startsWith(OWNERSHIP_MARKER);
}

function removeConsentGate(): void {
  try {
    if (existsSync(CONSENT_PATH)) unlinkSync(CONSENT_PATH);
  } catch {
    // Revocation remains best effort; the caller still stops consuming events.
  }
}

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
