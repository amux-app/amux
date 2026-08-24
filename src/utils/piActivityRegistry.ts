import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { atomicWriteFileSync } from './atomicWrite.js';

const EXTENSIONS_DIRECTORY = join(homedir(), '.pi', 'agent', 'extensions');
const EXTENSION_PATH = join(EXTENSIONS_DIRECTORY, 'aumx-activity.ts');
const CONSENT_PATH = join(homedir(), '.pi', 'agent', 'aumx-activity.enabled');
const OWNERSHIP_MARKER = '// AUMX_ACTIVITY_ADAPTER: pi:v1';

const EXTENSION_SOURCE = `${OWNERSHIP_MARKER}
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const consentPath = ${JSON.stringify(CONSENT_PATH)};

export default function (pi: ExtensionAPI) {
  let activeTurnId: string | undefined;
  const write = (kind: string, ctx: any, turnId?: string) => {
    try {
      if (!existsSync(consentPath)) return;
      const journal = process.env.AUMX_ACTIVITY_JOURNAL;
      const paneId = process.env.AUMX_PANE_ID;
      const paneIncarnationId = process.env.AUMX_PANE_INCARNATION_ID;
      if (!journal || !paneId || !paneIncarnationId) return;
      const record = {
        eventId: randomUUID(),
        kind,
        origin: "adapter",
        paneId,
        paneIncarnationId,
        sessionId: ctx.sessionManager.getSessionId(),
        turnId,
        emittedAt: Date.now(),
      };
      const encoded = JSON.stringify(record);
      if (Buffer.byteLength(encoded) >= 4096) return;
      mkdirSync(dirname(journal), { recursive: true, mode: 0o700 });
      rotateJournalIfNeeded(journal);
      appendFileSync(journal, encoded + "\\n", { mode: 0o600 });
      if (kind === "session_start") {
        appendFileSync(journal, JSON.stringify({
          eventId: randomUUID(),
          kind: "adapter_handshake",
          origin: "adapter",
          paneId,
          paneIncarnationId,
          sessionId: ctx.sessionManager.getSessionId(),
          adapterVersion: process.env.AUMX_ACTIVITY_ADAPTER_VERSION || "unknown",
          adapterSupport: process.env.AUMX_ACTIVITY_ADAPTER_SUPPORT === "full" || process.env.AUMX_ACTIVITY_ADAPTER_SUPPORT === "partial"
            ? process.env.AUMX_ACTIVITY_ADAPTER_SUPPORT
            : "partial",
          adapterCapabilities: parseAdapterCapabilities(),
          emittedAt: Date.now(),
        }) + "\\n", { mode: 0o600 });
      }
    } catch {
      // Observational extension: never affect Pi's control flow.
    }
  };
  function parseAdapterCapabilities() {
    try {
      const value = JSON.parse(process.env.AUMX_ACTIVITY_ADAPTER_CAPABILITIES || "[]");
      return Array.isArray(value) ? value : [];
    } catch (_) {
      return [];
    }
  }
  function rotateJournalIfNeeded(journal: string) {
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
  pi.on("session_start", (_event, ctx) => write("session_start", ctx));
  pi.on("agent_start", (_event, ctx) => {
    activeTurnId = randomUUID();
    write("turn_started", ctx, activeTurnId);
  });
  pi.on("agent_settled", (_event, ctx) => {
    const turnId = activeTurnId;
    activeTurnId = undefined;
    if (turnId) write("turn_settled", ctx, turnId);
  });
  pi.on("session_shutdown", (_event, ctx) => write("session_end", ctx));
}
`;

export function piActivityExtensionPath(): string {
  return EXTENSION_PATH;
}

/** Installs a globally auto-discovered Pi extension after explicit consent. */
export function ensurePiActivityExtension(): string | null {
  try {
    mkdirSync(EXTENSIONS_DIRECTORY, { recursive: true, mode: 0o700 });
    const existing = readFileSafe(EXTENSION_PATH);
    if (existing !== null && !isOwned(existing)) return null;
    if (existing !== EXTENSION_SOURCE) {
      atomicWriteFileSync(EXTENSION_PATH, EXTENSION_SOURCE);
    }
    chmodSync(EXTENSION_PATH, 0o600);
    atomicWriteFileSync(CONSENT_PATH, 'enabled\n');
    chmodSync(CONSENT_PATH, 0o600);
    return EXTENSION_PATH;
  } catch {
    return null;
  }
}

export function removePiActivityExtension(): boolean {
  removeConsentGate();
  const existing = readFileSafe(EXTENSION_PATH);
  if (existing === null) return true;
  if (!isOwned(existing)) return false;
  try {
    unlinkSync(EXTENSION_PATH);
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
