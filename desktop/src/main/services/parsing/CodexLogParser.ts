import { createReadStream, existsSync, readdirSync, statSync, type Dirent } from 'fs';
import { createInterface } from 'readline';
import { basename, join } from 'path';
import { homedir } from 'os';
import type { AgentLogParser, SessionDiscoveryMode } from './AgentLogParser.js';
import type { MuxBasePane } from 'muxbase/core';
import type { NormalizedSession } from '../../../shared/agent-session-types.js';
import { BoundedCache } from '../boundedCache.js';
import {
  codexSessionAccumulator,
  getSessionStartedAt,
  type CodexParseState,
  type RawCodexEntry,
} from './CodexSessionAccumulator.js';
import { createIncrementalJsonlParser, type IncrementalParseState } from './incrementalSessionParse.js';
import { asRecord, getString, parseIsoTimestamp } from './jsonl-values.js';
import { JSONL_EXTENSION, fileFingerprint } from './session-files.js';
import { filterOwnedByPane, paneCreatedMsFromId } from './session-ownership.js';
import { SessionParseCache } from './SessionParseCache.js';

const CODEX_RECENT_CWD_CANDIDATE_LIMIT = 24;
const CODEX_SESSION_LOOKAHEAD_MS = 20 * 60 * 1000;
const CODEX_SESSION_LOOKBACK_MS = 15_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_METADATA_CACHE_ENTRIES = 256;

interface CodexCandidate {
  birthtimeMs: number;
  mtimeMs: number;
  path: string;
}

interface CodexSessionMetadata {
  cwd: string | null;
  startedAtMs: number | null;
}

// One cache for every Codex pane: retention is bounded by entries, not by how many
// panes happen to be open, and each pane's incremental state survives here.
const parseCache = new SessionParseCache<IncrementalParseState<CodexParseState>>();
const parseIncrementally = createIncrementalJsonlParser(codexSessionAccumulator);
const metadataCache = new BoundedCache<CodexSessionMetadata>(MAX_METADATA_CACHE_ENTRIES);

export class CodexLogParser implements AgentLogParser {
  readonly agent = 'codex' as const;
  // One `rollout-<timestamp>-<uuid>.jsonl` per session, in a shared date tree.
  readonly boundFileIsExclusive = true;

  getSessionDirectory(_pane: MuxBasePane, _projectRoot: string): string | null {
    return null; // Codex uses a shared sessions tree
  }

  async findSessionFile(
    pane: MuxBasePane,
    projectRoot: string,
    excludePaths?: Set<string>,
    mode: SessionDiscoveryMode = 'initial',
  ): Promise<string | null> {
    const codexSessionsDir = join(homedir(), '.codex', 'sessions');
    if (!existsSync(codexSessionsDir)) return null;
    const paneTimestamp = paneCreatedMsFromId(pane.id);
    const bySessionId = this.findSessionById(
      codexSessionsDir,
      pane.agentSessionId,
      paneTimestamp,
      excludePaths,
    );
    if (bySessionId) return bySessionId;

    // Gate once, so every heuristic below inherits pane ownership.
    const candidates = filterOwnedByPane(
      this.collectSessionCandidates(codexSessionsDir, paneTimestamp, excludePaths),
      paneTimestamp,
    );
    if (candidates.length === 0) return null;

    const normalizedProjectRoot = this.normalizePath(projectRoot);
    if (paneTimestamp) {
      const byLaunchWindowAndCwd = await this.findCandidateByCwdAndLaunchWindow(
        candidates,
        normalizedProjectRoot,
        paneTimestamp,
      );
      if (byLaunchWindowAndCwd) return byLaunchWindowAndCwd.path;

      if (mode === 'replacement' && normalizedProjectRoot) {
        return (await this.findCandidateByCwdAfterPaneStart(
          candidates,
          normalizedProjectRoot,
          paneTimestamp,
        ))?.path ?? null;
      }

      if (normalizedProjectRoot) return null;
      return this.findCandidateByMtimeLaunchWindow(candidates, paneTimestamp)?.path ?? null;
    }

    const byRecentCwd = await this.findCandidateByCwd(
      candidates.slice(0, CODEX_RECENT_CWD_CANDIDATE_LIMIT),
      normalizedProjectRoot,
    );
    if (byRecentCwd) return byRecentCwd.path;

    if (normalizedProjectRoot) return null;
    return candidates[0]?.path ?? null;
  }

  async parseSession(filePath: string): Promise<NormalizedSession> {
    return parseCache.read({ filePath, fingerprint: fileFingerprint(filePath) }, parseIncrementally);
  }

  private collectSessionCandidates(
    rootDir: string,
    paneTimestamp: number | null,
    excludePaths?: Set<string>,
  ): CodexCandidate[] {
    const candidatesByPath = new Map<string, CodexCandidate>();
    for (const dir of this.buildCandidateDirectories(rootDir, paneTimestamp)) {
      for (const candidate of this.listJsonlCandidates(dir, excludePaths)) {
        const existing = candidatesByPath.get(candidate.path);
        if (!existing || candidate.mtimeMs > existing.mtimeMs) {
          candidatesByPath.set(candidate.path, candidate);
        }
      }
    }

    const candidates = Array.from(candidatesByPath.values()).sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (candidates.length > 0) return candidates;

    const fallbackLatest = this.findLatestJsonlRecursive(rootDir, excludePaths);
    if (!fallbackLatest) return [];
    const fallbackStats = statSync(fallbackLatest);
    return [{
      path: fallbackLatest,
      birthtimeMs: fallbackStats.birthtimeMs,
      mtimeMs: fallbackStats.mtimeMs,
    }];
  }

  private buildCandidateDirectories(rootDir: string, paneTimestamp: number | null): string[] {
    const timestamps = [Date.now()];
    if (paneTimestamp) {
      timestamps.push(paneTimestamp - MS_PER_DAY, paneTimestamp, paneTimestamp + MS_PER_DAY);
    }

    const dirs = new Set<string>();
    for (const timestamp of timestamps) {
      const date = new Date(timestamp);
      const year = String(date.getFullYear());
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const candidateDir = join(rootDir, year, month, day);
      if (existsSync(candidateDir)) {
        dirs.add(candidateDir);
      }
    }

    return Array.from(dirs);
  }

  private findSessionById(
    rootDir: string,
    sessionId: string | undefined,
    paneTimestamp: number | null,
    excludePaths?: Set<string>,
  ): string | null {
    const fileName = this.getSessionFileName(sessionId);
    if (!fileName) return null;

    for (const dir of this.buildCandidateDirectories(rootDir, paneTimestamp)) {
      const candidatePath = join(dir, fileName);
      if (this.isAvailableSessionFile(candidatePath, excludePaths)) {
        return candidatePath;
      }

      const rolloutPath = this.findMatchingJsonlInDirectory(
        dir,
        (name) => this.isRolloutSessionFileName(name, fileName),
        excludePaths,
      );
      if (rolloutPath) return rolloutPath;
    }

    return this.findMatchingJsonlRecursive(rootDir, (name) => name === fileName, excludePaths)
      ?? this.findMatchingJsonlRecursive(
        rootDir,
        (name) => this.isRolloutSessionFileName(name, fileName),
        excludePaths,
      );
  }

  private getSessionFileName(sessionId: string | undefined): string | null {
    const trimmed = sessionId?.trim();
    if (!trimmed) return null;
    const safeName = basename(trimmed);
    return safeName.endsWith(JSONL_EXTENSION) ? safeName : `${safeName}${JSONL_EXTENSION}`;
  }

  private listJsonlCandidates(
    dir: string,
    excludePaths?: Set<string>,
  ): CodexCandidate[] {
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      return [];
    }

    const candidates: CodexCandidate[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(JSONL_EXTENSION)) continue;
      const fullPath = join(dir, entry.name);
      if (excludePaths?.has(fullPath)) continue;
      try {
        const stats = statSync(fullPath);
        candidates.push({ path: fullPath, birthtimeMs: stats.birthtimeMs, mtimeMs: stats.mtimeMs });
      } catch {
        // ignore unreadable file
      }
    }
    return candidates;
  }

  private async findCandidateByCwd(
    candidates: Array<{ path: string; mtimeMs: number }>,
    normalizedProjectRoot: string,
  ): Promise<{ path: string; mtimeMs: number } | null> {
    if (!normalizedProjectRoot) return null;
    for (const candidate of candidates) {
      const metadata = await this.readSessionMetadata(candidate.path);
      if (this.isMatchingProjectRoot(metadata.cwd, normalizedProjectRoot)) {
        return candidate;
      }
    }
    return null;
  }

  private async findCandidateByCwdAndLaunchWindow(
    candidates: Array<{ path: string; mtimeMs: number }>,
    normalizedProjectRoot: string,
    paneTimestamp: number,
  ): Promise<{ path: string; mtimeMs: number } | null> {
    if (!normalizedProjectRoot) return null;
    for (const candidate of candidates) {
      const metadata = await this.readSessionMetadata(candidate.path);
      if (!this.isMatchingProjectRoot(metadata.cwd, normalizedProjectRoot)) continue;
      if (metadata.startedAtMs !== null) {
        if (this.isWithinLaunchWindow(metadata.startedAtMs, paneTimestamp)) return candidate;
        continue;
      }
      if (this.isWithinLaunchWindow(candidate.mtimeMs, paneTimestamp)) return candidate;
    }
    return null;
  }

  private async findCandidateByCwdAfterPaneStart(
    candidates: Array<{ path: string; mtimeMs: number }>,
    normalizedProjectRoot: string,
    paneTimestamp: number,
  ): Promise<{ path: string; mtimeMs: number } | null> {
    if (!normalizedProjectRoot) return null;
    for (const candidate of candidates) {
      const metadata = await this.readSessionMetadata(candidate.path);
      if (!this.isMatchingProjectRoot(metadata.cwd, normalizedProjectRoot)) continue;
      const sessionTimestamp = metadata.startedAtMs ?? candidate.mtimeMs;
      if (sessionTimestamp >= paneTimestamp - CODEX_SESSION_LOOKBACK_MS) return candidate;
    }
    return null;
  }

  private findCandidateByMtimeLaunchWindow(
    candidates: Array<{ path: string; mtimeMs: number }>,
    paneTimestamp: number,
  ): { path: string; mtimeMs: number } | null {
    return candidates.find((candidate) => this.isWithinLaunchWindow(candidate.mtimeMs, paneTimestamp)) ?? null;
  }

  private async readSessionMetadata(filePath: string): Promise<CodexSessionMetadata> {
    const fingerprint = fileFingerprint(filePath);
    const cacheKey = fingerprint ? `${filePath}\0${fingerprint}` : null;
    const cached = cacheKey ? metadataCache.get(cacheKey) : undefined;
    if (cached) return cached;

    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let parsedLines = 0;
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        parsedLines += 1;

        let entry: RawCodexEntry;
        try {
          entry = JSON.parse(line) as RawCodexEntry;
        } catch {
          if (parsedLines >= 8) break;
          continue;
        }

        if (entry.type === 'session_meta') {
          const payload = asRecord(entry.payload);
          const cwd = getString(payload?.cwd);
          const startedAt = getSessionStartedAt(entry, payload);
          const metadata = {
            cwd: cwd ? this.normalizePath(cwd) : null,
            startedAtMs: parseIsoTimestamp(startedAt) ?? null,
          };
          if (cacheKey) metadataCache.set(cacheKey, metadata);
          return metadata;
        }

        if (parsedLines >= 8) break;
      }
    } finally {
      rl.close();
      stream.destroy();
    }

    const metadata = { cwd: null, startedAtMs: null };
    if (cacheKey) metadataCache.set(cacheKey, metadata);
    return metadata;
  }

  private isMatchingProjectRoot(cwd: string | null, normalizedProjectRoot: string): boolean {
    if (!cwd) return false;
    if (cwd === normalizedProjectRoot) return true;
    return cwd.startsWith(`${normalizedProjectRoot}/`) || normalizedProjectRoot.startsWith(`${cwd}/`);
  }

  private isWithinLaunchWindow(timestamp: number, paneTimestamp: number): boolean {
    return timestamp >= paneTimestamp - CODEX_SESSION_LOOKBACK_MS
      && timestamp <= paneTimestamp + CODEX_SESSION_LOOKAHEAD_MS;
  }

  private normalizePath(value: string): string {
    if (!value.trim()) return '';
    return value.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  }

  private isAvailableSessionFile(filePath: string, excludePaths?: Set<string>): boolean {
    if (excludePaths?.has(filePath)) return false;
    try {
      return statSync(filePath).isFile();
    } catch {
      return false;
    }
  }

  private isRolloutSessionFileName(candidateName: string, fileName: string): boolean {
    return candidateName.endsWith(`-${fileName}`);
  }

  private findMatchingJsonlInDirectory(
    dir: string,
    matchesFileName: (name: string) => boolean,
    excludePaths?: Set<string>,
  ): string | null {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      return null;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !matchesFileName(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (this.isAvailableSessionFile(fullPath, excludePaths)) return fullPath;
    }

    return null;
  }

  private findMatchingJsonlRecursive(
    rootDir: string,
    matchesFileName: (name: string) => boolean,
    excludePaths?: Set<string>,
  ): string | null {
    let matchedPath: string | null = null;

    const walk = (dir: string): boolean => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
      } catch {
        return false;
      }

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (walk(fullPath)) return true;
          continue;
        }
        if (!entry.isFile() || !matchesFileName(entry.name)) continue;
        if (!this.isAvailableSessionFile(fullPath, excludePaths)) continue;
        matchedPath = fullPath;
        return true;
      }

      return false;
    };

    walk(rootDir);
    return matchedPath;
  }

  private findLatestJsonlRecursive(rootDir: string, excludePaths?: Set<string>): string | null {
    let latestPath: string | null = null;
    let latestMtimeMs = -Infinity;

    const walk = (dir: string): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(JSONL_EXTENSION)) continue;
        if (excludePaths?.has(fullPath)) continue;
        try {
          const mtimeMs = statSync(fullPath).mtimeMs;
          if (mtimeMs > latestMtimeMs) {
            latestMtimeMs = mtimeMs;
            latestPath = fullPath;
          }
        } catch {
          // ignore unreadable files
        }
      }
    };

    walk(rootDir);
    return latestPath;
  }
}
