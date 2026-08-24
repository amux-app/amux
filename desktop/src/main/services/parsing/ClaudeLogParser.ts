import { existsSync } from 'fs';
import { basename, join } from 'path';
import type { AgentLogParser } from './AgentLogParser.js';
import { getPaneProjectRoot, readRegisteredSession, type AumxPane } from 'aumx/core';
import type { NormalizedSession } from '../../../shared/agent-session-types.js';
import { CLAUDE_TITLE_TAIL_SCAN_BYTES } from './claude-scan-limits.js';
import { claudeProjectsDir, resolveClaudeProjectDir } from './claude-session-dir.js';
import { claudeSessionAccumulator, type ClaudeParseState } from './ClaudeSessionAccumulator.js';
import { findLatestAiTitle, normalizeClaudeTitle } from './claude-titles.js';
import { readFileTailText } from './file-regions.js';
import { createIncrementalJsonlParser, type IncrementalParseState } from './incrementalSessionParse.js';
import { parseIsoTimestamp } from './jsonl-values.js';
import {
  JSONL_EXTENSION,
  fileFingerprint,
  listSessionFilesByMtime,
  type SessionFileStat,
} from './session-files.js';
import { filterOwnedByPane, paneCreatedMsFromId } from './session-ownership.js';
import { SessionParseCache } from './SessionParseCache.js';
import { log } from '../Logger.js';

const CLAUDE_SESSION_LOOKAHEAD_MS = 20 * 60 * 1000;
const CLAUDE_SESSION_LOOKBACK_MS = 15_000;
// Largest observed project directory holds 58 session files, so this covers every
// real directory while still bounding a pathological one.
const CLAUDE_TITLE_CANDIDATE_LIMIT = 64;
const CLAUDE_TRANSCRIPT_TITLE_SCAN_BYTES = 256 * 1024;
const CLAUDE_TIMESTAMP_SCAN_BYTES = 512 * 1024;
// Candidate tails are independent reads, so they run in batches; the batch is
// small enough that an early match still skips most of the directory.
const CANDIDATE_BATCH_SIZE = 8;
const OSC_TITLE_PATTERN = /\u001b\](?:0|2);([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;

// One cache for every Claude pane: retention is bounded by entries, not by how
// many panes happen to be open, and each pane's incremental state survives here.
const parseCache = new SessionParseCache<IncrementalParseState<ClaudeParseState>>();
const parseIncrementally = createIncrementalJsonlParser(claudeSessionAccumulator);

export class ClaudeLogParser implements AgentLogParser {
  readonly agent = 'claude' as const;
  // One `<sessionId>.jsonl` per session.
  readonly boundFileIsExclusive = true;

  getSessionDirectory(pane: AumxPane, projectRoot: string): string | null {
    return resolveClaudeProjectDir(this.resolveClaudeProjectRoot(pane, projectRoot));
  }

  async findSessionFile(pane: AumxPane, projectRoot: string, excludePaths?: Set<string>): Promise<string | null> {
    if (!existsSync(claudeProjectsDir())) return null;

    const registered = readRegisteredSession(pane.id);
    if (registered && existsSync(registered.transcriptPath) && !excludePaths?.has(registered.transcriptPath)) {
      return registered.transcriptPath;
    }

    const sessionDir = this.getSessionDirectory(pane, projectRoot);
    if (!sessionDir || !existsSync(sessionDir)) return null;

    const paneTimestamp = paneCreatedMsFromId(pane.id);
    // Gate the candidate list once, so every heuristic below — title match, launch
    // window, mtime fallback, legacy fallback — inherits pane ownership.
    const candidates = filterOwnedByPane(
      await listSessionFilesByMtime(sessionDir, excludePaths),
      paneTimestamp,
      CLAUDE_SESSION_LOOKBACK_MS,
    );

    const byPaneTitle = await this.findSessionByPaneTitle(candidates, pane);
    if (byPaneTitle) return byPaneTitle;

    const bySessionId = this.findSessionById(sessionDir, pane.agentSessionId, excludePaths);
    if (bySessionId) return bySessionId;

    if (paneTimestamp) return this.findSessionByPaneTimestamp(candidates, paneTimestamp, sessionDir, pane.id);

    // Legacy panes without timestamps: best-effort fallback
    return candidates[0]?.path ?? null;
  }

  async parseSession(filePath: string): Promise<NormalizedSession> {
    return parseCache.read({ filePath, fingerprint: fileFingerprint(filePath) }, parseIncrementally);
  }

  private async findSessionByPaneTimestamp(
    candidates: SessionFileStat[],
    paneTimestamp: number,
    sessionDir: string,
    paneId: string,
  ): Promise<string | null> {
    const byBirthtime = this.findSessionByPaneTime(candidates, paneTimestamp);
    if (byBirthtime) return byBirthtime;

    const byMtime = await this.findSessionByPaneMtime(candidates, paneTimestamp);
    if (byMtime) {
      log.info('agent-session', 'Claude session discovery fell back to mtime match', {
        paneId,
        sessionDir,
        file: byMtime,
      });
      return byMtime;
    }

    // Time-bounded search found nothing — file hasn't been created yet.
    // Let watcher/poll discover it when it appears rather than grabbing a stale file.
    return null;
  }

  private resolveClaudeProjectRoot(pane: AumxPane, discoveryRoot: string): string {
    if (!pane.worktreePath) return discoveryRoot;
    return getPaneProjectRoot(pane, discoveryRoot);
  }

  private findSessionById(
    projectDir: string,
    sessionId: string | undefined,
    excludePaths?: Set<string>,
  ): string | null {
    const trimmed = sessionId?.trim();
    if (!trimmed) return null;

    const safeName = basename(trimmed);
    const fileName = safeName.endsWith(JSONL_EXTENSION) ? safeName : `${safeName}${JSONL_EXTENSION}`;
    const filePath = join(projectDir, fileName);
    if (!existsSync(filePath) || excludePaths?.has(filePath)) return null;
    return filePath;
  }

  private async findSessionByPaneTitle(candidates: SessionFileStat[], pane: AumxPane): Promise<string | null> {
    const paneTitle = await this.readPaneTitle(pane.terminalTranscriptPath);
    if (!paneTitle) return null;

    const match = await firstMatchingCandidate(
      candidates.slice(0, CLAUDE_TITLE_CANDIDATE_LIMIT),
      async (candidate) => await this.readSessionAiTitle(candidate.path) === paneTitle,
    );
    if (match) {
      log.info('agent-session', 'Claude session matched pane title', {
        paneId: pane.id,
        paneTitle,
        file: match,
      });
    }
    return match;
  }

  private async readPaneTitle(transcriptPath: string | undefined): Promise<string | null> {
    if (!transcriptPath || !existsSync(transcriptPath)) return null;

    try {
      const content = await readFileTailText(transcriptPath, CLAUDE_TRANSCRIPT_TITLE_SCAN_BYTES);
      let latestTitle: string | null = null;
      for (const match of content.matchAll(OSC_TITLE_PATTERN)) {
        latestTitle = match[1] ?? null;
      }
      return latestTitle ? normalizeClaudeTitle(latestTitle) : null;
    } catch {
      return null;
    }
  }

  private async readSessionAiTitle(filePath: string): Promise<string | null> {
    try {
      const content = await readFileTailText(filePath, CLAUDE_TITLE_TAIL_SCAN_BYTES);
      const title = findLatestAiTitle(content.split('\n'));
      return title ? normalizeClaudeTitle(title) : null;
    } catch {
      return null;
    }
  }

  private findSessionByPaneTime(candidates: SessionFileStat[], paneCreatedAt: number): string | null {
    return candidates
      .filter((file) => isWithinPaneWindow(file.birthtimeMs, paneCreatedAt))
      .sort((a, b) => a.birthtimeMs - b.birthtimeMs)[0]?.path ?? null;
  }

  private async findSessionByPaneMtime(
    candidates: SessionFileStat[],
    paneCreatedAt: number,
  ): Promise<string | null> {
    return firstMatchingCandidate(
      candidates.filter((file) => isWithinPaneWindow(file.mtimeMs, paneCreatedAt)),
      (candidate) => this.sessionFileHasFreshTimestamp(candidate.path, paneCreatedAt),
    );
  }

  private async sessionFileHasFreshTimestamp(filePath: string, paneCreatedAt: number): Promise<boolean> {
    try {
      const content = await readFileTailText(filePath, CLAUDE_TIMESTAMP_SCAN_BYTES);
      for (const match of content.matchAll(/"timestamp"\s*:\s*"([^"]+)"/g)) {
        const timestamp = parseIsoTimestamp(match[1]);
        if (timestamp && isWithinPaneWindow(timestamp, paneCreatedAt)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}

function isWithinPaneWindow(timeMs: number, paneCreatedAt: number): boolean {
  return timeMs >= paneCreatedAt - CLAUDE_SESSION_LOOKBACK_MS
    && timeMs <= paneCreatedAt + CLAUDE_SESSION_LOOKAHEAD_MS;
}

/**
 * Newest-first scan whose per-candidate reads run in batches. Batching keeps the
 * result identical to a sequential scan — the earliest match in a batch wins — while
 * paying one round trip per batch instead of one per candidate.
 */
async function firstMatchingCandidate(
  candidates: SessionFileStat[],
  matches: (candidate: SessionFileStat) => Promise<boolean>,
): Promise<string | null> {
  for (let start = 0; start < candidates.length; start += CANDIDATE_BATCH_SIZE) {
    const batch = candidates.slice(start, start + CANDIDATE_BATCH_SIZE);
    const results = await Promise.all(batch.map(matches));
    const index = results.indexOf(true);
    if (index !== -1) return batch[index].path;
  }
  return null;
}
