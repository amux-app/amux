import { existsSync } from 'fs';
import { open } from 'fs/promises';
import { resolve } from 'path';
import { resolvePiSessionDirectoryForProject, resolvePiSessionDirectorySync, type AumxPane } from 'aumx/core';
import type { NormalizedSession } from '../../../shared/agent-session-types.js';
import type { AgentLogParser } from './AgentLogParser.js';
import { createIncrementalJsonlParser, type IncrementalParseState } from './incrementalSessionParse.js';
import { parseJsonRecord } from './jsonl-values.js';
import { piSessionAccumulator, type PiParseState } from './PiSessionAccumulator.js';
import { fileFingerprint, listSessionFilesByMtime } from './session-files.js';
import { filterOwnedByPane, paneCreatedMsFromId } from './session-ownership.js';
import { SessionParseCache } from './SessionParseCache.js';

const PI_SESSION_LOOKAHEAD_MS = 20 * 60 * 1000;
const PI_SESSION_LOOKBACK_MS = 15_000;
const PI_HEADER_SCAN_BYTES = 8 * 1024;

const parseCache = new SessionParseCache<IncrementalParseState<PiParseState>>();
const parseIncrementally = createIncrementalJsonlParser(piSessionAccumulator);

interface PiSessionHeader {
  cwd: string;
  id: string;
}

export class PiLogParser implements AgentLogParser {
  readonly agent = 'pi' as const;
  readonly boundFileIsExclusive = true;

  getSessionDirectory(_pane: AumxPane, projectRoot: string): string | null {
    return resolvePiSessionDirectorySync(projectRoot).path;
  }

  async findSessionFile(
    pane: AumxPane,
    projectRoot: string,
    excludePaths?: Set<string>,
  ): Promise<string | null> {
    const resolvedRoot = resolve(projectRoot);
    const resolution = await resolvePiSessionDirectoryForProject(resolvedRoot);
    const sessionDir = resolution.path;
    if (!existsSync(sessionDir)) return null;

    const paneTimestamp = paneCreatedMsFromId(pane.id);
    const allFiles = await listSessionFilesByMtime(sessionDir, excludePaths);
    const candidates = filterOwnedByPane(allFiles, paneTimestamp, PI_SESSION_LOOKBACK_MS);

    for (const candidate of candidates) {
      const header = await readPiSessionHeader(candidate.path);
      if (!header || resolve(header.cwd) !== resolvedRoot) continue;
      if (pane.agentSessionId && header.id !== pane.agentSessionId) continue;
      if (paneTimestamp && !isWithinPaneWindow(candidate.mtimeMs, paneTimestamp)) continue;
      return candidate.path;
    }

    return null;
  }

  async parseSession(filePath: string): Promise<NormalizedSession> {
    return parseCache.read({ filePath, fingerprint: fileFingerprint(filePath) }, parseIncrementally);
  }
}

async function readPiSessionHeader(filePath: string): Promise<PiSessionHeader | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(PI_HEADER_SCAN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const entry = parseJsonRecord(line);
      if (!entry) continue;
      if (entry.type !== 'session') continue;
      return typeof entry.cwd === 'string' && typeof entry.id === 'string'
        ? { cwd: entry.cwd, id: entry.id }
        : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function isWithinPaneWindow(timeMs: number, paneCreatedAt: number): boolean {
  return timeMs >= paneCreatedAt - PI_SESSION_LOOKBACK_MS
    && timeMs <= paneCreatedAt + PI_SESSION_LOOKAHEAD_MS;
}
