import { existsSync } from 'fs';
import { open, readdir, stat, type FileHandle } from 'fs/promises';
import path from 'path';
import { createInterface } from 'readline';
import {
  resolvePiDefaultSessionDirectory,
  resolvePiSessionDirectoryForProject,
} from 'aumx/core';
import type { PastSession } from '../../../shared/ipc-types.js';
import {
  SESSION_UNTITLED,
  applySessionLimit,
  truncateTitle,
  type SessionListing,
} from './session-list-constants.js';
import { asRecord } from '../parsing/jsonl-values.js';
import { piExtractTextContent } from '../parsing/pi-session-parse.js';

interface PiSessionMetadata {
  cwd: string;
  id: string;
  title: string;
}

async function parseMetadata(lines: AsyncIterable<string>): Promise<PiSessionMetadata | null> {
  let cwd: string | null = null;
  let id: string | null = null;
  let firstPrompt: string | null = null;
  let sessionName: string | null = null;

  for await (const line of lines) {
    if (!line.trim()) continue;

    const needsSessionHeader = !cwd || !id;
    const mightBeSessionHeader = needsSessionHeader && /"type"\s*:\s*"session"/.test(line);
    const mightBeSessionName = /"type"\s*:\s*"session_info"/.test(line);
    const mightBeFirstPrompt = !firstPrompt
      && /"type"\s*:\s*"message"/.test(line)
      && /"role"\s*:\s*"user"/.test(line);
    if (!mightBeSessionHeader && !mightBeSessionName && !mightBeFirstPrompt) continue;

    let entry: Record<string, unknown> | undefined;
    try {
      entry = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry) continue;
    if (entry.type === 'session') {
      cwd = typeof entry.cwd === 'string' ? entry.cwd : cwd;
      id = typeof entry.id === 'string' ? entry.id : id;
      continue;
    }
    if (entry.type === 'session_info' && typeof entry.name === 'string') {
      sessionName = entry.name.trim() || sessionName;
      continue;
    }
    if (!firstPrompt && entry.type === 'message') {
      const message = asRecord(entry.message);
      if (message?.role === 'user') firstPrompt = piExtractTextContent(message.content);
    }
  }

  const title = sessionName ?? firstPrompt;
  return cwd && id ? { cwd, id, title: title ? truncateTitle(title) : SESSION_UNTITLED } : null;
}

async function readSession(filePath: string, expectedRoot: string): Promise<PastSession | null> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, 'r');
  } catch {
    return null;
  }

  try {
    const fileStat = await handle.stat();
    const lines = createInterface({
      input: handle.createReadStream({ autoClose: false, encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    const metadata = await parseMetadata(lines);
    if (!metadata || path.resolve(metadata.cwd) !== expectedRoot) return null;
    return { id: metadata.id, title: metadata.title, updatedAt: fileStat.mtimeMs };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

export async function listPiSessions(
  projectRoot: string,
  limit?: number,
  sessionsRoot?: string,
): Promise<SessionListing> {
  const expectedRoot = path.resolve(projectRoot);
  const resolution = sessionsRoot
    ? { path: resolvePiDefaultSessionDirectory(expectedRoot, sessionsRoot), shared: false }
    : await resolvePiSessionDirectoryForProject(expectedRoot);
  const directory = resolution.path;
  if (!existsSync(directory)) return { sessions: [], total: 0 };

  const names = (await readdir(directory))
    .filter((name) => name.endsWith('.jsonl'));
  const candidates = await Promise.all(names.map(async (name) => {
    const filePath = path.join(directory, name);
    try {
      return { filePath, mtimeMs: (await stat(filePath)).mtimeMs };
    } catch {
      return null;
    }
  }));
  const ordered = candidates
    .filter((candidate): candidate is { filePath: string; mtimeMs: number } => candidate !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const candidatesToRead = resolution.shared ? ordered : applySessionLimit(ordered, limit);
  const parsed = await Promise.all(candidatesToRead.map(({ filePath }) => readSession(filePath, expectedRoot)));
  const matching = parsed.filter((session): session is PastSession => session !== null);

  return {
    sessions: resolution.shared ? applySessionLimit(matching, limit) : matching,
    total: resolution.shared || candidatesToRead.length === ordered.length ? matching.length : ordered.length,
  };
}
