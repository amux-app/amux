import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MuxBasePane } from 'muxbase/core';
import { createParser } from '../../src/main/services/parsing/AgentLogParser';
import { OpencodeLogParser } from '../../src/main/services/parsing/OpencodeLogParser';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

const tempDirs: string[] = [];
const mockedExecFile = vi.mocked(execFile);
const require = createRequire(import.meta.url);

interface SqliteStatement {
  run: (...values: unknown[]) => void;
}

interface SqliteDatabase {
  close: () => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

interface OpenCodeExportFixture {
  info?: Record<string, unknown>;
  messages?: Array<{
    info?: Record<string, unknown>;
    parts?: Record<string, unknown>[];
  }>;
}

const { DatabaseSync } = require('node:sqlite') as SqliteModule;

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makePane(overrides: Partial<MuxBasePane> = {}): MuxBasePane {
  return {
    id: 'muxbase-1778686269000',
    paneId: '%1',
    prompt: 'fix tests',
    slug: 'fix-tests',
    agent: 'opencode',
    ...overrides,
  };
}

function outputFor(args: readonly string[], values: Record<string, string>): string {
  if (args[0] === 'db' && args[1] === 'path') return values.dbPath;
  if (args[0] === 'export') return values.exported;
  throw new Error(`Unexpected opencode args: ${args.join(' ')}`);
}

function mockOpencode(values: Record<string, string>): void {
  mockedExecFile.mockImplementation(((file: string, args: readonly string[] | undefined, _options: unknown, callback: ExecFileCallback) => {
    if (file !== 'opencode' || !args) throw new Error('Unexpected command');
    callback(null, outputFor(args, values), '');
    return undefined as unknown as ReturnType<typeof execFile>;
  }) as typeof execFile);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function getString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function getNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function getNestedNumber(record: Record<string, unknown>, path: string[], fallback: number): number {
  let value: unknown = record;
  for (const key of path) {
    value = asRecord(value)[key];
  }
  return getNumber(value, fallback);
}

const SCHEMA_SQL = `
  CREATE TABLE session (
    id text PRIMARY KEY,
    directory text NOT NULL,
    title text NOT NULL,
    agent text,
    model text,
    cost real DEFAULT 0 NOT NULL,
    time_created integer NOT NULL,
    time_updated integer NOT NULL,
    tokens_input integer DEFAULT 0 NOT NULL,
    tokens_output integer DEFAULT 0 NOT NULL,
    tokens_reasoning integer DEFAULT 0 NOT NULL,
    tokens_cache_read integer DEFAULT 0 NOT NULL,
    tokens_cache_write integer DEFAULT 0 NOT NULL
  );
  CREATE TABLE message (
    id text PRIMARY KEY,
    session_id text NOT NULL,
    time_created integer NOT NULL,
    time_updated integer NOT NULL,
    data text NOT NULL
  );
  CREATE TABLE part (
    id text PRIMARY KEY,
    message_id text NOT NULL,
    session_id text NOT NULL,
    time_created integer NOT NULL,
    time_updated integer NOT NULL,
    data text NOT NULL
  );
`;

const INSERT_SESSION_SQL = `
  INSERT INTO session (
    id, directory, title, agent, model, time_created, time_updated,
    tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

interface SessionFixture {
  agent?: string;
  directory: string;
  id: string;
  modelJson?: string | null;
  timeCreated: number;
  timeUpdated: number;
  title?: string;
  tokens?: { cacheRead: number; cacheWrite: number; input: number; output: number; reasoning: number };
}

function insertSessionFixture(database: SqliteDatabase, session: SessionFixture): void {
  const tokens = session.tokens ?? { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, reasoning: 0 };
  database.prepare(INSERT_SESSION_SQL).run(
    session.id,
    session.directory,
    session.title ?? 'Test session',
    session.agent ?? 'build',
    session.modelJson ?? null,
    session.timeCreated,
    session.timeUpdated,
    tokens.input,
    tokens.output,
    tokens.reasoning,
    tokens.cacheRead,
    tokens.cacheWrite,
  );
}

/** Session rows only — for discovery tests that never parse message content. */
function createSessionListDatabase(dbPath: string, sessions: SessionFixture[]): void {
  const database = new DatabaseSync(dbPath);
  database.exec(SCHEMA_SQL);
  for (const session of sessions) insertSessionFixture(database, session);
  database.close();
}

function createOpencodeDatabase(
  dbPath: string,
  directory: string,
  exported: OpenCodeExportFixture,
): void {
  const database = new DatabaseSync(dbPath);
  const info = asRecord(exported.info);
  const sessionId = getString(info.id, 'ses_expected');
  const tokens = asRecord(info.tokens);
  const cache = asRecord(tokens.cache);
  const model = asRecord(info.model);
  database.exec(SCHEMA_SQL);
  insertSessionFixture(database, {
    agent: getString(info.agent, 'build'),
    directory,
    id: sessionId,
    modelJson: Object.keys(model).length > 0 ? JSON.stringify(model) : null,
    timeCreated: getNestedNumber(info, ['time', 'created'], 1778686270000),
    timeUpdated: getNestedNumber(info, ['time', 'updated'], 1778686275000),
    title: getString(info.title, 'Test session'),
    tokens: {
      cacheRead: getNumber(cache.read, 0),
      cacheWrite: getNumber(cache.write, 0),
      input: getNumber(tokens.input, 0),
      output: getNumber(tokens.output, 0),
      reasoning: getNumber(tokens.reasoning, 0),
    },
  });

  const insertMessage = database.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
  const insertPart = database.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)');
  (exported.messages ?? []).forEach((message, messageIndex) => {
    const messageInfo = asRecord(message.info);
    const messageId = getString(messageInfo.id, `msg_${messageIndex}`);
    const messageCreated = getNestedNumber(messageInfo, ['time', 'created'], 1778686271000 + messageIndex);
    const messageUpdated = getNestedNumber(messageInfo, ['time', 'completed'], messageCreated);
    insertMessage.run(messageId, sessionId, messageCreated, messageUpdated, JSON.stringify(messageInfo));

    (message.parts ?? []).forEach((part, partIndex) => {
      const partId = getString(part.id, `part_${messageIndex}_${partIndex}`);
      const partCreated = getNestedNumber(part, ['time', 'start'], messageCreated + partIndex);
      const partUpdated = getNestedNumber(part, ['time', 'end'], partCreated);
      insertPart.run(partId, messageId, sessionId, partCreated, partUpdated, JSON.stringify(part));
    });
  });
  database.close();
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('OpencodeLogParser', () => {
  it('is available through the agent parser factory', () => {
    // Arrange / Act
    const parser = createParser('opencode');

    // Assert
    expect(parser.agent).toBe('opencode');
  });

  it('matches the recent opencode session for the pane project root', async () => {
    // Arrange
    const root = createTempDir('muxbase-opencode-project-');
    const dbPath = join(root, 'opencode.db');
    createSessionListDatabase(dbPath, [
      {
        directory: '/tmp/other-project',
        id: 'ses_unrelated',
        timeCreated: 1778686269500,
        timeUpdated: 1778686269600,
        title: 'Unrelated',
      },
      {
        directory: join(root, 'packages/app'),
        id: 'ses_expected',
        timeCreated: 1778686270000,
        timeUpdated: 1778686271000,
        title: 'Fix tests',
      },
    ]);
    mockOpencode({ dbPath, exported: '{}' });
    const parser = new OpencodeLogParser();

    // Act
    const file = await parser.findSessionFile(makePane(), root);

    // Assert
    expect(file).toBe(dbPath);
  });

  it('parses exported opencode messages into a normalized session', async () => {
    // Arrange
    const root = createTempDir('muxbase-opencode-project-');
    const dbPath = join(root, 'opencode.db');
    const exported = {
      info: {
        id: 'ses_expected',
        model: { id: 'claude-opus-4-6', providerID: 'anthropic', variant: 'default' },
        time: { created: 1778686270000, updated: 1778686275000 },
        title: 'Fix tests',
        tokens: {
          input: 10,
          output: 5,
          reasoning: 2,
          cache: { read: 3, write: 4 },
        },
      },
      messages: [
        {
          info: { id: 'msg_user', role: 'user', time: { created: 1778686270100 } },
          parts: [
            {
              id: 'part_editor_context',
              metadata: { kind: 'editor_context' },
              synthetic: true,
              text: '<system-reminder>Note: file opened</system-reminder>',
              type: 'text',
            },
            { id: 'part_user', type: 'text', text: 'Fix the failing tests' },
          ],
        },
        {
          info: {
            id: 'msg_assistant',
            role: 'assistant',
            time: { created: 1778686271000, completed: 1778686274000 },
            tokens: {
              input: 4,
              output: 3,
              reasoning: 2,
              cache: { read: 1, write: 0 },
            },
          },
          parts: [
            { id: 'part_reasoning', type: 'reasoning', text: 'Checking tests', time: { start: 1778686271100, end: 1778686271300 } },
            { id: 'part_text', type: 'text', text: 'Done.' },
            {
              id: 'part_tool',
              type: 'tool',
              callID: 'call_test',
              tool: 'bash',
              state: {
                status: 'completed',
                input: { command: 'pnpm test' },
                output: 'passed',
                title: 'pnpm test',
                metadata: {},
                time: { start: 1778686271500, end: 1778686273500 },
              },
            },
          ],
        },
      ],
    };
    createOpencodeDatabase(dbPath, root, exported);
    mockOpencode({
      dbPath,
      exported: `Exporting session: ses_expected\n${JSON.stringify(exported)}`,
    });
    const parser = new OpencodeLogParser();
    const file = await parser.findSessionFile(makePane(), root);

    // Act
    const session = await parser.parseSession(file ?? dbPath);

    // Assert
    expect(session.agent).toBe('opencode');
    expect(session.sessionId).toBe('ses_expected');
    expect(session.title).toBe('Fix tests');
    expect(session.providerId).toBe('anthropic');
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]?.content).toBe('Fix the failing tests');
    expect(session.messages[1]?.content).toBe('Done.');
    expect(session.messages[1]?.thinkingContent).toBe('Checking tests');
    expect(session.messages[1]?.toolCalls[0]).toMatchObject({
      id: 'call_test',
      name: 'bash',
      input: { command: 'pnpm test' },
    });
    expect(session.messages[1]?.toolResults[0]).toMatchObject({
      content: 'passed',
      durationMs: 2000,
      isError: false,
      toolCallId: 'call_test',
    });
    expect(session.metrics).toMatchObject({
      cacheCreationTokens: 4,
      cacheReadTokens: 3,
      inputTokens: 10,
      messageCount: 2,
      outputTokens: 5,
      toolCallCount: 1,
      totalTokens: 22,
    });
    expect(session.isOngoing).toBe(false);
    expect(session.turnCompleted).toBe(true);
  });

  it('resolves providerId from the assistant message when session info has no model', async () => {
    // Arrange
    const root = createTempDir('muxbase-opencode-project-');
    const dbPath = join(root, 'opencode.db');
    const exported = {
      info: { id: 'ses_expected', time: { created: 1778686270000, updated: 1778686275000 } },
      messages: [
        {
          info: { id: 'msg_user', role: 'user', time: { created: 1778686270100 } },
          parts: [{ id: 'part_user', type: 'text', text: 'Hello' }],
        },
        {
          info: { id: 'msg_assistant', role: 'assistant', providerID: 'OpenAI', modelID: 'gpt-5.4', time: { created: 1778686271000, completed: 1778686274000 } },
          parts: [{ id: 'part_text', type: 'text', text: 'Hi.' }],
        },
      ],
    };
    createOpencodeDatabase(dbPath, root, exported);
    mockOpencode({
      dbPath,
      exported: JSON.stringify(exported),
    });
    const parser = new OpencodeLogParser();
    const file = await parser.findSessionFile(makePane(), root);

    // Act
    const session = await parser.parseSession(file ?? dbPath);

    // Assert
    expect(session.providerId).toBe('openai');
  });

  it('parses long opencode sessions from SQLite when CLI export is truncated', async () => {
    // Arrange
    const root = createTempDir('muxbase-opencode-project-');
    const dbPath = join(root, 'opencode.db');
    const sessionId = 'ses_long_export';
    const longText = `full message ${'x'.repeat(80_000)} tail`;
    const exported = {
      info: {
        id: sessionId,
        model: { id: 'gpt-5.5-fast', providerID: 'openai', variant: 'xhigh' },
        time: { created: 1778686270000, updated: 1778686275000 },
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 3, write: 4 } },
      },
      messages: [
        {
          info: { id: 'msg_assistant', role: 'assistant', time: { created: 1778686271000, completed: 1778686274000 } },
          parts: [{ id: 'part_text', type: 'text', text: longText }],
        },
      ],
    };
    createOpencodeDatabase(dbPath, root, exported);
    mockOpencode({
      dbPath,
      exported: `Exporting session: ${sessionId}\n{"messages":[{"parts":[{"type":"text","text":"${'x'.repeat(70_000)}`,
    });
    const parser = new OpencodeLogParser();
    const file = await parser.findSessionFile(makePane(), root);

    // Act
    const session = await parser.parseSession(file ?? dbPath);

    // Assert
    expect(session.sessionId).toBe(sessionId);
    expect(session.providerId).toBe('openai');
    expect(session.messages[0]?.content).toBe(longText);
    expect(session.metrics).toMatchObject({
      cacheCreationTokens: 4,
      cacheReadTokens: 3,
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 10,
    });
  });
  it('reads the whole recent-session window from SQLite, past the size the CLI could return', async () => {
    // Arrange — a result set far wider than the 64 KiB the `opencode db` CLI can pipe,
    // with the matching session ranked 150th so a truncated read would never reach it.
    const root = createTempDir('muxbase-opencode-project-');
    const dbPath = join(root, 'opencode.db');
    const padding = 'x'.repeat(800);
    const sessions: SessionFixture[] = [];
    for (let index = 0; index < 149; index++) {
      sessions.push({
        directory: `/tmp/other-project-${index}/${padding}`,
        id: `ses_newer_${index}`,
        timeCreated: 2_000_000_000_000 + index,
        timeUpdated: 2_000_000_000_000 + index,
        title: `Newer session ${index} ${padding}`,
      });
    }
    sessions.push({
      directory: root,
      id: 'ses_expected',
      timeCreated: 1778686270000,
      timeUpdated: 1_500_000_000_000,
      title: `Matching session ${padding}`,
    });
    for (let index = 0; index < 100; index++) {
      sessions.push({
        directory: `/tmp/older-project-${index}/${padding}`,
        id: `ses_older_${index}`,
        timeCreated: 1_000_000_000_000 + index,
        timeUpdated: 1_000_000_000_000 + index,
        title: `Older session ${index} ${padding}`,
      });
    }
    createSessionListDatabase(dbPath, sessions);
    mockOpencode({ dbPath, exported: '{}' });
    const parser = new OpencodeLogParser();

    // Act
    const file = await parser.findSessionFile(makePane(), root);
    const session = await parser.parseSession(file ?? dbPath);

    // Assert
    expect(file).toBe(dbPath);
    expect(session.sessionId).toBe('ses_expected');
  });

  it('finds a persisted session id through a bound parameter, outside the directory and time window', async () => {
    // Arrange — the persisted session is unrelated by directory and an hour past the
    // launch window, so only the by-id lookup can reach it.
    const root = createTempDir('muxbase-opencode-project-');
    const dbPath = join(root, 'opencode.db');
    createSessionListDatabase(dbPath, [
      {
        directory: root,
        id: 'ses_recent',
        timeCreated: 1778686270000,
        timeUpdated: 1778686275000,
        title: 'Recent session',
      },
      {
        directory: "/tmp/o'brien-project",
        id: "ses_persisted'quote",
        timeCreated: 1778689869000,
        timeUpdated: 1778689869000,
        title: 'Persisted session',
      },
    ]);
    mockOpencode({ dbPath, exported: '{}' });
    const parser = new OpencodeLogParser();

    // Act
    const file = await parser.findSessionFile(makePane({ agentSessionId: "ses_persisted'quote" }), root);
    const session = await parser.parseSession(file ?? dbPath);

    // Assert
    expect(file).toBe(dbPath);
    expect(session.sessionId).toBe("ses_persisted'quote");
  });
  it('never selects a session created before the pane, even as the only related row', async () => {
    // Arrange: an external OpenCode session running in the same directory.
    const root = createTempDir('muxbase-opencode-project-');
    const dbPath = join(root, 'opencode.db');
    createSessionListDatabase(dbPath, [
      {
        directory: root,
        id: 'ses_external',
        timeCreated: 1778600000000,
        timeUpdated: 1778686279000,
        title: 'Someone elses work',
      },
    ]);
    mockOpencode({ dbPath, exported: '{}' });
    const parser = new OpencodeLogParser();

    // Act
    const file = await parser.findSessionFile(makePane(), root);

    // Assert
    expect(file).toBeNull();
  });

  it('resumes a deliberately chosen session that predates the pane by a long way', async () => {
    // Arrange: `opencode --session <id>` continues the SAME row, so its time_created
    // is older than the pane that resumed it.
    const root = createTempDir('muxbase-opencode-project-');
    const dbPath = join(root, 'opencode.db');
    createSessionListDatabase(dbPath, [
      {
        directory: root,
        id: 'ses_resumed',
        timeCreated: 1778600000000,
        timeUpdated: 1778686279000,
        title: 'Last weeks work',
      },
    ]);
    mockOpencode({ dbPath, exported: '{}' });
    const parser = new OpencodeLogParser();

    // Act
    const file = await parser.findSessionFile(makePane({ agentSessionId: 'ses_resumed' }), root);
    const session = await parser.parseSession(file ?? dbPath);

    // Assert
    expect(file).toBe(dbPath);
    expect(session.sessionId).toBe('ses_resumed');
    expect(session.title).toBe('Last weeks work');
  });

  it('exposes the database directory and its sidecars for event-driven discovery', async () => {
    // Arrange
    const root = createTempDir('muxbase-opencode-project-');
    const dbPath = join(root, 'opencode.db');
    createSessionListDatabase(dbPath, [
      { directory: root, id: 'ses_expected', timeCreated: 1778686270000, timeUpdated: 1778686275000 },
    ]);
    mockOpencode({ dbPath, exported: '{}' });
    const parser = new OpencodeLogParser();

    // Act
    await parser.findSessionFile(makePane(), root);

    // Assert
    expect(parser.getDiscoveryWatchDirectory(makePane(), root)).toBe(root);
    expect(parser.isDiscoveryFileName('opencode.db-wal')).toBe(true);
    expect(parser.isDiscoveryFileName('unrelated.db')).toBe(false);
  });
});
