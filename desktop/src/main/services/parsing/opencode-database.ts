import { createRequire } from 'module';
import { log } from '../Logger.js';
import { asRecord, getNumber, getString, type JsonRecord } from './jsonl-values.js';

interface SqliteStatement {
  all: (...values: unknown[]) => unknown[];
  get: (...values: unknown[]) => unknown;
}

export interface SqliteDatabase {
  close: () => void;
  prepare: (sql: string) => SqliteStatement;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean; timeout?: number }) => SqliteDatabase;
}

export interface OpencodeSessionRow {
  id: string;
  directory: string;
  timeCreated: number;
  timeUpdated: number;
}

const require = createRequire(import.meta.url);
let sqliteModule: SqliteModule | null = null;

const OPENCODE_SESSION_LIMIT = 200;
const SESSION_COLUMNS = 'id,directory,title,agent,time_created,time_updated,cost,tokens_input,tokens_output,tokens_reasoning,tokens_cache_read,tokens_cache_write';
const RECENT_SESSIONS_SQL = [
  `select ${SESSION_COLUMNS} from session order by time_updated desc limit `,
  String(OPENCODE_SESSION_LIMIT),
].join('');
const SESSION_BY_ID_SQL = `select ${SESSION_COLUMNS} from session where id = ? limit 1`;
const SYSTEM_REMINDER_PATTERN = /^\s*<system-reminder\b/i;

const FIRST_USER_MESSAGE_SQL = `
  SELECT id FROM message
  WHERE session_id = ? AND role = 'user'
  ORDER BY time_created, id
  LIMIT 1
`;
const MESSAGE_TEXT_PARTS_SQL = `
  SELECT data FROM part
  WHERE message_id = ? AND type = 'text'
  ORDER BY time_created, id
`;

function getSqliteModule(): SqliteModule {
  sqliteModule ??= require('node:sqlite') as SqliteModule;
  return sqliteModule;
}

export function withDatabase<T>(databasePath: string, work: (database: SqliteDatabase) => T): T {
  const { DatabaseSync } = getSqliteModule();
  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 1000 });
  try {
    return work(database);
  } finally {
    database.close();
  }
}

export function queryRecentSessions(databasePath: string): OpencodeSessionRow[] {
  return querySessions(databasePath, RECENT_SESSIONS_SQL);
}

export function querySessionById(databasePath: string, sessionId: string): OpencodeSessionRow | null {
  return querySessions(databasePath, SESSION_BY_ID_SQL, sessionId)[0] ?? null;
}

// The opencode CLI truncates `db <query>` stdout at the 64 KiB pipe buffer, which
// corrupts any result wider than that. Reading the same SQLite directly has no cap.
function querySessions(databasePath: string, sql: string, ...params: string[]): OpencodeSessionRow[] {
  let rows: unknown[];
  try {
    rows = withDatabase(databasePath, (database) => database.prepare(sql).all(...params));
  } catch (err) {
    log.warn('opencode-parser', 'Session query failed', { databasePath, sql, error: String(err) });
    throw err;
  }
  return rows
    .map(toSessionRow)
    .filter((row): row is OpencodeSessionRow => row !== null);
}

function toSessionRow(value: unknown): OpencodeSessionRow | null {
  const row = asRecord(value);
  if (!row) return null;

  const id = getString(row.id);
  const directory = getString(row.directory);
  const timeCreated = getNumber(row.time_created);
  const timeUpdated = getNumber(row.time_updated);
  if (!id || !directory || timeCreated === undefined || timeUpdated === undefined) return null;

  return { id, directory, timeCreated, timeUpdated };
}

export function readFirstUserMessageText(databasePath: string, sessionId: string): string | null {
  return withDatabase(databasePath, (database) => readFirstUserMessageTextFromDb(database, sessionId));
}

export function readFirstUserMessageTextFromDb(database: SqliteDatabase, sessionId: string): string | null {
  const firstUser = database.prepare(FIRST_USER_MESSAGE_SQL).get(sessionId) as { id?: string } | undefined;
  if (!firstUser?.id) return null;

  const parts = database.prepare(MESSAGE_TEXT_PARTS_SQL).all(firstUser.id) as Array<{ data: string }>;
  for (const row of parts) {
    const part = parseDatabaseRecord(row.data);
    if (!isDisplayTextPart(part)) continue;
    const text = getString(part.text)?.trim();
    if (text) return text;
  }
  return null;
}

function parseDatabaseRecord(raw: string): JsonRecord {
  return asRecord(JSON.parse(raw) as unknown) ?? {};
}

export function isDisplayTextPart(part: JsonRecord): boolean {
  if (getString(part.type) !== 'text') return false;
  const metadata = asRecord(part.metadata);
  const text = getString(part.text) ?? '';
  return part.synthetic !== true
    && getString(metadata?.kind) !== 'editor_context'
    && !SYSTEM_REMINDER_PATTERN.test(text);
}

interface DatabaseSessionRow {
  agent: string | null;
  id: string;
  model: string | null;
  time_created: number;
  time_updated: number;
  title: string;
  tokens_cache_read: number;
  tokens_cache_write: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
}

interface DatabaseMessageRow {
  data: string;
  id: string;
  time_created: number;
  time_updated: number;
}

interface DatabasePartRow {
  data: string;
  id: string;
  message_id: string;
  time_created: number;
  time_updated: number;
}

export interface OpenCodeExport {
  info?: JsonRecord;
  messages?: OpenCodeExportMessage[];
}

export interface OpenCodeExportMessage {
  info?: JsonRecord;
  parts?: JsonRecord[];
}

export function loadSessionFromDatabase(databasePath: string, sessionId: string): OpenCodeExport {
  return withDatabase(databasePath, (database) => {
    const sessionRow = database.prepare(`
      SELECT id, title, agent, model, time_created, time_updated,
        tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
      FROM session
      WHERE id = ?
      LIMIT 1
    `).get(sessionId) as DatabaseSessionRow | undefined;
    if (!sessionRow) return { messages: [] };

    const messageRows = database.prepare(`
      SELECT id, data, time_created, time_updated
      FROM message
      WHERE session_id = ?
      ORDER BY time_created, id
    `).all(sessionId) as DatabaseMessageRow[];
    const partRows = database.prepare(`
      SELECT id, message_id, data, time_created, time_updated
      FROM part
      WHERE session_id = ?
      ORDER BY time_created, id
    `).all(sessionId) as DatabasePartRow[];

    return {
      info: convertSessionRow(sessionRow),
      messages: convertDatabaseMessages(messageRows, partRows),
    };
  });
}

function convertSessionRow(row: DatabaseSessionRow): JsonRecord {
  const info: JsonRecord = {
    agent: row.agent ?? undefined,
    id: row.id,
    time: { created: row.time_created, updated: row.time_updated },
    title: row.title,
    tokens: {
      cache: { read: row.tokens_cache_read, write: row.tokens_cache_write },
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
    },
  };
  const model = row.model ? asRecord(JSON.parse(row.model) as unknown) : null;
  if (model) info.model = model;
  return info;
}

function convertDatabaseMessages(
  messageRows: DatabaseMessageRow[],
  partRows: DatabasePartRow[],
): OpenCodeExportMessage[] {
  const partsByMessageId = new Map<string, JsonRecord[]>();
  for (const row of partRows) {
    const part = parseDatabaseRecord(row.data);
    part.id ??= row.id;
    part.time ??= { created: row.time_created, updated: row.time_updated };
    const parts = partsByMessageId.get(row.message_id) ?? [];
    parts.push(part);
    partsByMessageId.set(row.message_id, parts);
  }

  return messageRows.map((row) => {
    const info = parseDatabaseRecord(row.data);
    info.id ??= row.id;
    info.time ??= { created: row.time_created, updated: row.time_updated };
    return {
      info,
      parts: partsByMessageId.get(row.id) ?? [],
    };
  });
}
