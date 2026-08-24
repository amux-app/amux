import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { basename, dirname } from 'path';
import type { AumxPane } from 'aumx/core';
import type { AgentLogParser } from './AgentLogParser.js';
import type {
  CompactionEvent,
  MessageTokens,
  NormalizedMessage,
  NormalizedSession,
  NormalizedToolCall,
  NormalizedToolResult,
} from '../../../shared/agent-session-types.js';
import { createEmptyMetrics, createEmptySession } from '../../../shared/agent-session-types.js';
import { log } from '../Logger.js';
import { asRecord, getNumber, getString, type JsonRecord } from './jsonl-values.js';
import {
  isDisplayTextPart,
  loadSessionFromDatabase,
  queryRecentSessions,
  querySessionById,
  readFirstUserMessageText,
  readFirstUserMessageTextFromDb,
  withDatabase,
  type OpenCodeExport,
  type OpenCodeExportMessage,
  type OpencodeSessionRow,
} from './opencode-database.js';
import { fileGroupFingerprint } from './session-files.js';
import { isOwnedByPane, paneCreatedMsFromId } from './session-ownership.js';
import { SessionParseCache } from './SessionParseCache.js';

const OPENCODE_SESSION_LOOKAHEAD_MS = 20 * 60 * 1000;
const OPENCODE_SESSION_LOOKBACK_MS = 15_000;
// SQLite keeps committed-but-uncheckpointed content in the write-ahead log, so
// the main database file alone is not a complete identity for the session data.
const SQLITE_COMPANION_SUFFIXES = ['-wal'];
interface ToolData {
  call: NormalizedToolCall;
  result?: NormalizedToolResult;
}

// One cache for every OpenCode pane: retention is bounded by entries, not by how
// many panes happen to be open.
const parseCache = new SessionParseCache();

export class OpencodeLogParser implements AgentLogParser {
  readonly agent = 'opencode' as const;
  // Every session in the project lives in one SQLite database.
  readonly boundFileIsExclusive = false;

  private sessionIdsByDatabasePath = new Map<string, string>();
  private databaseDirsByRoot = new Map<string, string>();
  private databaseFileNames = new Set<string>();

  getSessionDirectory(_pane: AumxPane, _projectRoot: string): string | null {
    return null;
  }

  // Every session in the project shares one database, so there is no per-pane
  // directory to watch — but a write to that database is the earliest possible
  // signal that this pane's session now exists.
  getDiscoveryWatchDirectory(_pane: AumxPane, projectRoot: string): string | null {
    return this.databaseDirsByRoot.get(projectRoot) ?? null;
  }

  isDiscoveryFileName(fileName: string): boolean {
    for (const name of this.databaseFileNames) {
      if (fileName === name || fileName.startsWith(`${name}-`)) return true;
    }
    return false;
  }

  getSessionWatchPaths(filePath: string): readonly string[] {
    return [filePath, ...SQLITE_COMPANION_SUFFIXES.map((suffix) => `${filePath}${suffix}`)];
  }

  async findSessionFile(
    pane: AumxPane,
    projectRoot: string,
    _excludePaths?: Set<string>,
  ): Promise<string | null> {
    const databasePath = await this.getDatabasePath(projectRoot);
    if (!databasePath || !existsSync(databasePath)) return null;

    const paneCreatedMs = paneCreatedMsFromId(pane.id);
    const persistedSession = pane.agentSessionId
      ? querySessionById(databasePath, pane.agentSessionId)
      : null;
    if (persistedSession) {
      this.bindDatabasePath(databasePath, persistedSession.id);
      return databasePath;
    }

    const rows = queryRecentSessions(databasePath);
    const session = this.selectSession(rows, pane, projectRoot, paneCreatedMs);
    if (!session) return null;

    this.bindDatabasePath(databasePath, session.id);
    return databasePath;
  }

  // Every pane reads the same project database, so the bound session id is part of
  // the cache key: two panes on two sessions cannot serve each other's parse.
  async parseSession(filePath: string): Promise<NormalizedSession> {
    const sessionId = this.resolveSessionId(filePath);
    return parseCache.read(
      {
        filePath,
        fingerprint: fileGroupFingerprint(filePath, SQLITE_COMPANION_SUFFIXES),
        key: `${filePath}#${sessionId}`,
      },
      async () => ({ session: this.parseSessionFile(filePath, sessionId) }),
    );
  }

  private resolveSessionId(databasePath: string): string {
    return this.sessionIdsByDatabasePath.get(databasePath) ?? basename(databasePath, '.db');
  }

  private parseSessionFile(filePath: string, sessionId: string): NormalizedSession {
    const exported = loadSessionFromDatabase(filePath, sessionId);
    return this.convertExport(exported, sessionId);
  }

  // Used by the session picker to rescue rows whose `session.title` still holds
  // OpenCode's placeholder "New session - <ISO>" (the title-generator agent
  // hasn't run yet). Reads the same SQLite the parser uses, scans the user
  // message's text parts, returns the first non-empty, non-system-reminder text.
  async getFirstUserMessageText(cwd: string, sessionId: string): Promise<string | null> {
    const databasePath = await this.getDatabasePath(cwd);
    if (!databasePath || !existsSync(databasePath)) return null;
    return readFirstUserMessageText(databasePath, sessionId);
  }

  // Batch variant: resolves the DB path once, opens the database once, and
  // looks up several sessions sequentially. Cheaper than calling
  // getFirstUserMessageText in a loop because `opencode db path` is a subprocess.
  async getFirstUserMessageTexts(cwd: string, sessionIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!sessionIds.length) return out;
    const databasePath = await this.getDatabasePath(cwd);
    if (!databasePath || !existsSync(databasePath)) return out;

    withDatabase(databasePath, (database) => {
      for (const id of sessionIds) {
        const text = readFirstUserMessageTextFromDb(database, id);
        if (text) out.set(id, text);
      }
    });
    return out;
  }

  private async getDatabasePath(cwd: string): Promise<string | null> {
    const stdout = await this.execOpencode(['db', 'path'], cwd);
    const databasePath = stdout.trim().split(/\r?\n/)[0]?.trim();
    if (!databasePath) return null;
    this.databaseDirsByRoot.set(cwd, dirname(databasePath));
    this.databaseFileNames.add(basename(databasePath));
    return databasePath;
  }

  private bindDatabasePath(databasePath: string, sessionId: string): void {
    this.sessionIdsByDatabasePath.set(databasePath, sessionId);
  }

  private async execOpencode(args: string[], cwd: string | undefined): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('opencode', args, {
        cwd,
        encoding: 'utf-8',
        env: {
          ...process.env,
          OPENCODE_DISABLE_AUTOUPDATE: '1',
        },
        maxBuffer: 50 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error) {
          log.warn('opencode-parser', 'opencode CLI failed', {
            command: args.slice(0, 2).join(' '),
            error: error.message,
            stderr: stderr?.slice(0, 200),
          });
          reject(error);
          return;
        }
        resolve(stdout);
      });
    });
  }

  private selectSession(
    rows: OpencodeSessionRow[],
    pane: AumxPane,
    projectRoot: string,
    paneCreatedMs: number | null,
  ): OpencodeSessionRow | null {
    // The persisted id is resolved (and ownership-checked) before this runs, so a
    // second id shortcut here could only re-adopt a session already rejected.
    // Gate once, so no heuristic below can adopt a session older than the pane.
    const ownedRows = rows.filter((row) => this.isOwnedRow(row, paneCreatedMs));
    const relatedRows = ownedRows.filter((row) => this.arePathsRelated(row.directory, projectRoot));
    if (relatedRows.length === 0) return null;

    const paneTimestamp = paneCreatedMs;
    if (!paneTimestamp) return relatedRows[0] ?? null;

    const windowRows = relatedRows
      .filter((row) =>
        row.timeCreated >= paneTimestamp - OPENCODE_SESSION_LOOKBACK_MS
        && row.timeCreated <= paneTimestamp + OPENCODE_SESSION_LOOKAHEAD_MS,
      )
      .sort((a, b) => a.timeCreated - b.timeCreated);

    return windowRows[0] ?? null;
  }

  private convertExport(exported: OpenCodeExport, fallbackSessionId: string): NormalizedSession {
    const info = asRecord(exported.info);
    const sessionId = getString(info?.id) ?? fallbackSessionId;
    const session = createEmptySession('opencode', sessionId);
    session.title = getString(info?.title);
    session.startTime = this.getNestedNumber(info, ['time', 'created']);
    session.lastUpdateTime = this.getNestedNumber(info, ['time', 'updated']);

    const messages = Array.isArray(exported.messages) ? exported.messages : [];
    session.providerId = this.resolveProviderId(info, messages);
    session.modelId = this.resolveModelId(info, messages);
    session.messages = messages
      .map((message, index) => this.convertMessage(message, index))
      .filter((message): message is NormalizedMessage => message !== null);

    session.metrics = this.buildMetrics(info, session.messages);
    session.compactionEvents = this.detectCompactionEvents(messages);
    session.pendingUserQuestion = this.findPendingUserQuestion(messages);
    session.awaitingUserInput = session.pendingUserQuestion !== undefined;
    session.turnCompleted = this.isTurnCompleted(messages);
    session.isOngoing = session.awaitingUserInput ? false : !session.turnCompleted;
    return session;
  }

  private resolveProviderId(info: JsonRecord | undefined, messages: OpenCodeExportMessage[]): string | undefined {
    const fromInfo = getString(asRecord(info?.model)?.providerID);
    if (fromInfo) return fromInfo.toLowerCase();

    for (const message of messages) {
      const messageInfo = asRecord(message.info);
      if (getString(messageInfo?.role) !== 'assistant') continue;
      const providerId = getString(messageInfo?.providerID);
      if (providerId) return providerId.toLowerCase();
    }
    return undefined;
  }

  private resolveModelId(info: JsonRecord | undefined, messages: OpenCodeExportMessage[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const messageInfo = asRecord(messages[i].info);
      if (getString(messageInfo?.role) !== 'assistant') continue;
      const modelId = getString(messageInfo?.modelID);
      if (modelId) return modelId;
    }
    return getString(asRecord(info?.model)?.modelID);
  }

  private convertMessage(message: OpenCodeExportMessage, index: number): NormalizedMessage | null {
    const info = asRecord(message.info);
    if (!info) return null;

    const role = getString(info.role);
    const type = this.toMessageType(role);
    if (!type) return null;

    const parts = Array.isArray(message.parts) ? message.parts : [];
    const textParts = parts.filter((part) => isDisplayTextPart(part));
    const reasoningParts = parts.filter((part) => getString(part.type) === 'reasoning');
    const toolData = parts
      .filter((part) => getString(part.type) === 'tool')
      .map((part) => this.convertToolPart(part))
      .filter((tool): tool is ToolData => tool !== null);

    return {
      id: getString(info.id) ?? `opencode-${index}`,
      type,
      timestamp: this.getNestedNumber(info, ['time', 'created']),
      content: this.joinPartText(textParts, 'text'),
      thinkingContent: this.joinPartText(reasoningParts, 'text') || undefined,
      tokens: this.extractTokens(asRecord(info.tokens)),
      toolCalls: toolData.map((tool) => tool.call),
      toolResults: toolData.map((tool) => tool.result).filter((result): result is NormalizedToolResult => result !== undefined),
    };
  }

  private convertToolPart(part: JsonRecord): ToolData | null {
    const name = getString(part.tool);
    if (!name) return null;

    const state = asRecord(part.state);
    const input = asRecord(state?.input) ?? {};
    const callId = getString(part.callID) ?? getString(part.id) ?? name;
    const startedAt = this.getNestedNumber(state, ['time', 'start']);
    const endedAt = this.getNestedNumber(state, ['time', 'end']);
    const status = getString(state?.status);
    const result = this.convertToolResult(callId, state, status, startedAt, endedAt);

    return {
      call: {
        id: callId,
        input,
        name,
        timestamp: startedAt,
      },
      result,
    };
  }

  private convertToolResult(
    callId: string,
    state: JsonRecord | undefined,
    status: string | undefined,
    startedAt: number | undefined,
    endedAt: number | undefined,
  ): NormalizedToolResult | undefined {
    if (status !== 'completed' && status !== 'error') return undefined;

    const output = status === 'error'
      ? getString(state?.error) ?? ''
      : getString(state?.output) ?? '';

    return {
      content: output,
      durationMs: startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : undefined,
      isError: status === 'error',
      toolCallId: callId,
    };
  }

  private buildMetrics(info: JsonRecord | undefined, messages: NormalizedMessage[]): NormalizedSession['metrics'] {
    const metrics = createEmptyMetrics();
    const tokens = this.extractTokens(asRecord(info?.tokens));

    if (tokens) {
      metrics.inputTokens = tokens.inputTokens;
      metrics.outputTokens = tokens.outputTokens;
      metrics.cacheReadTokens = tokens.cacheReadTokens ?? 0;
      metrics.cacheCreationTokens = tokens.cacheCreationTokens ?? 0;
    } else {
      for (const message of messages) {
        metrics.inputTokens += message.tokens?.inputTokens ?? 0;
        metrics.outputTokens += message.tokens?.outputTokens ?? 0;
        metrics.cacheReadTokens += message.tokens?.cacheReadTokens ?? 0;
        metrics.cacheCreationTokens += message.tokens?.cacheCreationTokens ?? 0;
      }
    }

    metrics.messageCount = messages.length;
    metrics.toolCallCount = messages.reduce((total, message) => total + message.toolCalls.length, 0);
    metrics.totalTokens =
      metrics.inputTokens + metrics.outputTokens + metrics.cacheReadTokens + metrics.cacheCreationTokens;
    return metrics;
  }

  private extractTokens(tokens: JsonRecord | undefined): MessageTokens | undefined {
    const inputTokens = getNumber(tokens?.input);
    const outputTokens = getNumber(tokens?.output);
    if (inputTokens === undefined && outputTokens === undefined) return undefined;

    return {
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      cacheReadTokens: this.getNestedNumber(tokens, ['cache', 'read']) ?? 0,
      cacheCreationTokens: this.getNestedNumber(tokens, ['cache', 'write']) ?? 0,
    };
  }

  private detectCompactionEvents(messages: OpenCodeExportMessage[]): CompactionEvent[] {
    const events: CompactionEvent[] = [];
    messages.forEach((message, index) => {
      const parts = Array.isArray(message.parts) ? message.parts : [];
      if (parts.some((part) => getString(part.type) === 'compaction')) {
        events.push({
          timestamp: this.getNestedNumber(asRecord(message.info), ['time', 'created']),
          tokensAfter: 0,
          tokensBefore: 0,
          turnIndex: index,
        });
      }
    });
    return events;
  }

  private isTurnCompleted(messages: OpenCodeExportMessage[]): boolean {
    const last = messages[messages.length - 1];
    const info = asRecord(last?.info);
    return this.getNestedNumber(info, ['time', 'completed']) !== undefined;
  }

  private findPendingUserQuestion(messages: OpenCodeExportMessage[]): string | undefined {
    const pendingToolPart = messages
      .flatMap((message) => Array.isArray(message.parts) ? message.parts : [])
      .find((part) => this.isPendingUserInputPart(part));
    const state = asRecord(pendingToolPart?.state);
    const input = asRecord(state?.input);
    const prompt = input?.prompt ?? input?.question ?? input?.message;
    return typeof prompt === 'string' ? prompt : undefined;
  }

  private isPendingUserInputPart(part: JsonRecord): boolean {
    const state = asRecord(part.state);
    return getString(part.type) === 'tool'
      && getString(state?.status) === 'pending'
      && this.isPendingUserInputTool(getString(part.tool) ?? '');
  }

  private isPendingUserInputTool(name: string): boolean {
    return name === 'question' || name === 'ask' || name === 'input';
  }

  private toMessageType(role: string | undefined): NormalizedMessage['type'] | null {
    if (role === 'user' || role === 'assistant' || role === 'system') return role;
    return null;
  }

  private joinPartText(parts: JsonRecord[], key: string): string {
    return parts
      .map((part) => getString(part[key]))
      .filter((text): text is string => !!text)
      .join('\n');
  }

  private isOwnedRow(row: OpencodeSessionRow, paneCreatedMs: number | null): boolean {
    return isOwnedByPane({ mtimeMs: row.timeCreated }, paneCreatedMs);
  }

  private arePathsRelated(a: string, b: string): boolean {
    const left = this.normalizePath(a);
    const right = this.normalizePath(b);
    if (!left || !right) return false;
    if (left === right) return true;
    return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
  }

  private normalizePath(value: string): string {
    return value.replace(/\\/g, '/').replace(/\/+$/, '');
  }

  private getNestedNumber(record: JsonRecord | undefined, path: string[]): number | undefined {
    let value: unknown = record;
    for (const key of path) {
      const current = asRecord(value);
      if (!current) return undefined;
      value = current[key];
    }
    return getNumber(value);
  }
}
