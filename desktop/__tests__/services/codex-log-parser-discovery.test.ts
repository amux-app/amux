import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MuxBasePane } from 'muxbase/core';
import { CodexLogParser } from '../../src/main/services/parsing/CodexLogParser';

const homeDirState = vi.hoisted(() => ({ value: '' }));

vi.mock('os', () => ({
  homedir: () => homeDirState.value,
}));

const tempDirs: string[] = [];

function createTempHome(): string {
  const dir = mkdtempSync(join('/tmp', 'muxbase-codex-home-'));
  tempDirs.push(dir);
  homeDirState.value = dir;
  return dir;
}

function makePane(createdAt: number, overrides: Partial<MuxBasePane> = {}): MuxBasePane {
  return {
    id: `muxbase-${createdAt}`,
    paneId: '%1',
    prompt: 'test prompt',
    slug: 'codex-pane',
    agent: 'codex',
    ...overrides,
  };
}

function getCodexSessionDir(timestamp: number): string {
  const date = new Date(timestamp);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return join(homeDirState.value, '.codex', 'sessions', year, month, day);
}

function writeCodexSession(id: string, timestamp: number, cwd: string, mtime = timestamp, fileStem = id): string {
  const dir = getCodexSessionDir(timestamp);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${fileStem}.jsonl`);
  const isoTimestamp = new Date(timestamp).toISOString();
  const lines = [
    JSON.stringify({
      type: 'session_meta',
      timestamp: isoTimestamp,
      payload: { id, timestamp: isoTimestamp, cwd },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: isoTimestamp,
      payload: { type: 'message', role: 'assistant', content: id },
    }),
  ];
  writeFileSync(filePath, `${lines.join('\n')}\n`);
  const fileTime = new Date(mtime);
  utimesSync(filePath, fileTime, fileTime);
  return filePath;
}

function writeCodexSessionWithStartedAtFallback(
  id: string,
  entryTimestamp: number,
  startedAt: number,
  cwd: string,
): string {
  const dir = getCodexSessionDir(startedAt);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${id}.jsonl`);
  const entryIsoTimestamp = new Date(entryTimestamp).toISOString();
  const startedAtIsoTimestamp = new Date(startedAt).toISOString();
  const lines = [
    JSON.stringify({
      type: 'session_meta',
      timestamp: entryIsoTimestamp,
      started_at: startedAtIsoTimestamp,
      payload: { id, cwd },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: startedAtIsoTimestamp,
      payload: { type: 'message', role: 'assistant', content: id },
    }),
  ];
  writeFileSync(filePath, `${lines.join('\n')}\n`);
  const fileTime = new Date(startedAt);
  utimesSync(filePath, fileTime, fileTime);
  return filePath;
}

beforeEach(() => {
  createTempHome();
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  homeDirState.value = '';
});

describe('CodexLogParser session discovery', () => {
  it('does not bind a pane to an unrelated shared Codex session without a cwd match', async () => {
    // Arrange
    const paneCreatedAt = Date.UTC(2026, 0, 2, 10);
    writeCodexSession('unrelated-session', paneCreatedAt + 1000, '/tmp/other-project');
    const parser = new CodexLogParser();

    // Act
    const found = await parser.findSessionFile(makePane(paneCreatedAt), '/tmp/current-project');

    // Assert
    expect(found).toBeNull();
  });

  it('prefers the cwd-matching Codex session over a newer unrelated session', async () => {
    // Arrange
    const paneCreatedAt = Date.UTC(2026, 0, 2, 10);
    writeCodexSession('unrelated-session', paneCreatedAt + 2000, '/tmp/other-project');
    const expected = writeCodexSession('matching-session', paneCreatedAt + 1000, '/tmp/current-project');
    const parser = new CodexLogParser();

    // Act
    const found = await parser.findSessionFile(makePane(paneCreatedAt), '/tmp/current-project');

    // Assert
    expect(found).toBe(expected);
  });

  it('uses the persisted Codex session id before scanning by recency', async () => {
    // Arrange
    const paneCreatedAt = Date.UTC(2026, 0, 2, 10);
    const oldSessionTimestamp = paneCreatedAt - 3 * 24 * 60 * 60 * 1000;
    const expected = writeCodexSession('persisted-session', oldSessionTimestamp, '/tmp/other-project');
    writeCodexSession('unrelated-session', paneCreatedAt + 1000, '/tmp/other-project');
    const parser = new CodexLogParser();

    // Act
    const found = await parser.findSessionFile(
      makePane(paneCreatedAt, { agentSessionId: 'persisted-session' }),
      '/tmp/current-project',
    );

    // Assert
    expect(found).toBe(expected);
  });

  it('resolves persisted Codex session ids stored in rollout-prefixed filenames', async () => {
    // Arrange
    const paneCreatedAt = Date.UTC(2026, 0, 2, 10);
    const sessionId = '019e4a69-c3fb-7623-8f3c-568f54ad594d';
    const oldSessionTimestamp = paneCreatedAt - 3 * 24 * 60 * 60 * 1000;
    const expected = writeCodexSession(
      sessionId,
      oldSessionTimestamp,
      '/tmp/current-project',
      oldSessionTimestamp,
      `rollout-2026-01-01T10-00-00-${sessionId}`,
    );
    writeCodexSession('newer-matching-session', paneCreatedAt + 1000, '/tmp/current-project');
    const parser = new CodexLogParser();

    // Act
    const found = await parser.findSessionFile(
      makePane(paneCreatedAt, { agentSessionId: sessionId }),
      '/tmp/current-project',
    );

    // Assert
    expect(found).toBe(expected);
  });

  it('resumes a deliberately chosen session that predates the pane by a long way', async () => {
    // Arrange: bare `<sessionId>.jsonl` shape, three days older than the pane that
    // resumed it, with a newer unrelated session present to lose to.
    const paneCreatedAt = Date.UTC(2026, 0, 2, 10);
    const sessionId = 'resumed-session';
    const resumedAt = paneCreatedAt - 3 * 24 * 60 * 60 * 1000;
    const expected = writeCodexSession(sessionId, resumedAt, '/tmp/current-project');
    writeCodexSession('newer-session', paneCreatedAt + 1000, '/tmp/current-project');
    const parser = new CodexLogParser();

    // Act
    const found = await parser.findSessionFile(
      makePane(paneCreatedAt, { agentSessionId: sessionId }),
      '/tmp/current-project',
    );

    // Assert
    expect(found).toBe(expected);
  });

  it('does not bind a timestamped pane to an older same-cwd Codex session before its own log exists', async () => {
    // Arrange
    const paneCreatedAt = Date.UTC(2026, 0, 2, 10);
    const olderSessionStartedAt = paneCreatedAt - 10 * 60 * 1000;
    writeCodexSession(
      'older-same-cwd-session',
      olderSessionStartedAt,
      '/tmp/current-project',
      paneCreatedAt + 1_000,
    );
    const parser = new CodexLogParser();

    // Act
    const found = await parser.findSessionFile(makePane(paneCreatedAt), '/tmp/current-project');

    // Assert
    expect(found).toBeNull();
  });

  it('matches a long-running Codex session by session start time when mtime moved outside the launch window', async () => {
    // Arrange
    const paneCreatedAt = Date.UTC(2026, 0, 2, 10);
    const expected = writeCodexSession(
      'long-running-session',
      paneCreatedAt + 1_000,
      '/tmp/current-project',
      paneCreatedAt + 60 * 60 * 1000,
    );
    const parser = new CodexLogParser();

    // Act
    const found = await parser.findSessionFile(makePane(paneCreatedAt), '/tmp/current-project');

    // Assert
    expect(found).toBe(expected);
  });

  it('rebinding matches a later same-cwd Codex session outside the initial launch window', async () => {
    // Arrange
    const paneCreatedAt = Date.UTC(2026, 0, 2, 10);
    const current = writeCodexSession(
      'current-session',
      paneCreatedAt + 1_000,
      '/tmp/current-project',
      paneCreatedAt + 60_000,
    );
    const expected = writeCodexSession(
      'replacement-session',
      paneCreatedAt + 60 * 60 * 1000,
      '/tmp/current-project',
      paneCreatedAt + 60 * 60 * 1000,
    );
    const parser = new CodexLogParser();

    // Act
    const found = await parser.findSessionFile(
      makePane(paneCreatedAt),
      '/tmp/current-project',
      new Set([current]),
      'replacement',
    );

    // Assert
    expect(found).toBe(expected);
  });

  it('does not let a persisted current session id block replacement discovery', async () => {
    // Arrange
    const paneCreatedAt = Date.UTC(2026, 0, 2, 10);
    const current = writeCodexSession(
      'current-session',
      paneCreatedAt + 1_000,
      '/tmp/current-project',
      paneCreatedAt + 60_000,
    );
    const expected = writeCodexSession(
      'replacement-session',
      paneCreatedAt + 60 * 60 * 1000,
      '/tmp/current-project',
      paneCreatedAt + 60 * 60 * 1000,
    );
    const parser = new CodexLogParser();

    // Act
    const found = await parser.findSessionFile(
      makePane(paneCreatedAt, { agentSessionId: 'current-session' }),
      '/tmp/current-project',
      new Set([current]),
      'replacement',
    );

    // Assert
    expect(found).toBe(expected);
  });

  it('rebinding rejects an older same-cwd Codex session even when its mtime is newer', async () => {
    // Arrange
    const paneCreatedAt = Date.UTC(2026, 0, 2, 10);
    const current = writeCodexSession(
      'current-session',
      paneCreatedAt + 1_000,
      '/tmp/current-project',
      paneCreatedAt + 60_000,
    );
    writeCodexSession(
      'older-session',
      paneCreatedAt - 10 * 60 * 1000,
      '/tmp/current-project',
      paneCreatedAt + 60 * 60 * 1000,
    );
    const parser = new CodexLogParser();

    // Act
    const found = await parser.findSessionFile(
      makePane(paneCreatedAt),
      '/tmp/current-project',
      new Set([current]),
      'replacement',
    );

    // Assert
    expect(found).toBeNull();
  });

  it('uses started_at as the session start fallback when payload timestamp is missing', async () => {
    // Arrange
    const paneCreatedAt = Date.UTC(2026, 0, 2, 10);
    const expected = writeCodexSessionWithStartedAtFallback(
      'started-at-session',
      paneCreatedAt - 10 * 60 * 1000,
      paneCreatedAt + 1_000,
      '/tmp/current-project',
    );
    const parser = new CodexLogParser();

    // Act
    const found = await parser.findSessionFile(makePane(paneCreatedAt), '/tmp/current-project');

    // Assert
    expect(found).toBe(expected);
  });

  it('does not rebind to another pane session after that file is claimed', async () => {
    // Arrange
    const paneCreatedAt = Date.UTC(2026, 0, 2, 10);
    const current = writeCodexSession(
      'current-session',
      paneCreatedAt + 1_000,
      '/tmp/current-project',
      paneCreatedAt + 60_000,
    );
    const claimedByAnotherPane = writeCodexSession(
      'other-pane-session',
      paneCreatedAt + 60 * 60 * 1000,
      '/tmp/current-project',
      paneCreatedAt + 60 * 60 * 1000,
    );
    const parser = new CodexLogParser();

    // Act
    const found = await parser.findSessionFile(
      makePane(paneCreatedAt),
      '/tmp/current-project',
      new Set([current, claimedByAnotherPane]),
      'replacement',
    );

    // Assert
    expect(found).toBeNull();
  });
});
