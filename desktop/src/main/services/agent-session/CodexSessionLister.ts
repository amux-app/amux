import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { PastSession } from '../../../shared/ipc-types.js';
import { extractCodexRolloutPreview } from './CodexRolloutPreview.js';
import {
  SESSION_UNTITLED,
  applySessionLimit,
  truncateTitle,
  type SessionListing,
} from './session-list-constants.js';

const CODEX_INDEX = join(homedir(), '.codex', 'session_index.jsonl');

interface CodexIndexEntry {
  id: string;
  threadName: string;
  updatedAt: number;
}

function parseIndexEntry(line: string): CodexIndexEntry | null {
  try {
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (typeof entry.id !== 'string') return null;
    if (typeof entry.updated_at !== 'string') return null;
    const threadName = typeof entry.thread_name === 'string' ? entry.thread_name.trim() : '';
    return {
      id: entry.id,
      threadName,
      updatedAt: Date.parse(entry.updated_at) || 0,
    };
  } catch {
    return null;
  }
}

function toPastSession(entry: CodexIndexEntry): PastSession {
  if (entry.threadName) {
    return { id: entry.id, title: truncateTitle(entry.threadName), updatedAt: entry.updatedAt };
  }
  const preview = extractCodexRolloutPreview(entry.id, entry.updatedAt);
  return {
    id: entry.id,
    title: preview ? truncateTitle(preview) : SESSION_UNTITLED,
    updatedAt: entry.updatedAt,
  };
}

/**
 * Lists Codex sessions newest-first. `limit` bounds how many rollout previews are
 * read back, which is the only per-session file access here.
 */
export function listCodexSessions(limit?: number): SessionListing {
  if (!existsSync(CODEX_INDEX)) return { sessions: [], total: 0 };

  const indexEntries = readFileSync(CODEX_INDEX, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(parseIndexEntry)
    .filter((e): e is CodexIndexEntry => e !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return {
    sessions: applySessionLimit(indexEntries, limit).map(toPastSession),
    total: indexEntries.length,
  };
}
