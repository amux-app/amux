import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listClaudeSessions } from '../../src/main/services/agent-session/ClaudeSessionLister';

const syncReadSpies = vi.hoisted(() => ({ readFileSync: vi.fn(), readSync: vi.fn() }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  syncReadSpies.readFileSync.mockImplementation(actual.readFileSync);
  syncReadSpies.readSync.mockImplementation(actual.readSync);
  return { ...actual, readFileSync: syncReadSpies.readFileSync, readSync: syncReadSpies.readSync };
});

const PROJECT_ROOT = '/Users/tester/projects/demo';
const ENCODED_PROJECT = PROJECT_ROOT.replace(/[^a-zA-Z0-9]/g, '-');
const SCAN_BYTES = 64 * 1024;
const TIMESTAMP = '2026-07-26T10:00:00.000Z';

const originalHome = process.env.HOME;
let home = '';
let sessionsDir = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aumx-session-lister-'));
  process.env.HOME = home;
  sessionsDir = join(home, '.claude', 'projects', ENCODED_PROJECT);
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

function filler(byteBudget: number): string {
  const line = `{"type":"assistant","timestamp":"${TIMESTAMP}","message":{"role":"assistant","content":"${'x'.repeat(240)}"}}`;
  return `${line}\n`.repeat(Math.ceil(byteBudget / (line.length + 1)));
}

function aiTitleLine(sessionId: string, title: string): string {
  return `{"type":"ai-title","timestamp":"${TIMESTAMP}","sessionId":"${sessionId}","aiTitle":"${title}"}\n`;
}

function lastPromptLine(sessionId: string, prompt: string): string {
  return `{"type":"last-prompt","timestamp":"${TIMESTAMP}","sessionId":"${sessionId}","lastPrompt":"${prompt}"}\n`;
}

function userLine(sessionId: string, text: string): string {
  return `{"type":"user","timestamp":"${TIMESTAMP}","sessionId":"${sessionId}","promptSource":"typed","message":{"role":"user","content":"${text}"}}\n`;
}

function writeSession(fileName: string, body: string, mtimeMs?: number): string {
  const filePath = join(sessionsDir, `${fileName}.jsonl`);
  writeFileSync(filePath, body);
  if (mtimeMs !== undefined) {
    const seconds = mtimeMs / 1000;
    utimesSync(filePath, seconds, seconds);
  }
  return filePath;
}

describe('listClaudeSessions', () => {
  it('resolves the ai-title from the tail of a large session file', async () => {
    // Arrange
    writeSession(
      'big',
      userLine('big', 'kick off the migration') + filler(3 * SCAN_BYTES) + aiTitleLine('big', 'Migrate the tmux bridge'),
    );

    // Act
    const { sessions } = await listClaudeSessions(PROJECT_ROOT);

    // Assert
    expect(sessions).toEqual([
      expect.objectContaining({ id: 'big', title: 'Migrate the tmux bridge' }),
    ]);
  });

  it('never reads the middle of a file, so a stale mid-file ai-title loses to the tail', async () => {
    // Arrange
    writeSession(
      'bounded',
      userLine('bounded', 'first prompt')
      + filler(2 * SCAN_BYTES)
      + aiTitleLine('bounded', 'MID FILE TITLE')
      + filler(2 * SCAN_BYTES)
      + lastPromptLine('bounded', 'tail prompt wins'),
    );

    // Act
    const { sessions } = await listClaudeSessions(PROJECT_ROOT);

    // Assert
    expect(sessions[0].title).toBe('tail prompt wins');
  });

  it('falls back to the head user prompt when a large file carries no title record', async () => {
    // Arrange
    writeSession('untitled-big', userLine('untitled-big', 'explain the resume flow') + filler(3 * SCAN_BYTES));

    // Act
    const { sessions } = await listClaudeSessions(PROJECT_ROOT);

    // Assert
    expect(sessions[0].title).toBe('explain the resume flow');
  });

  it('labels a session with no readable title as untitled instead of blank', async () => {
    // Arrange
    writeSession('blank', `{"type":"assistant","sessionId":"blank","message":{"role":"assistant","content":"hi"}}\n`);

    // Act
    const { sessions } = await listClaudeSessions(PROJECT_ROOT);

    // Assert
    expect(sessions[0].title).toBe('Untitled session');
  });

  it('keeps the recorded session id so resume targets the same conversation', async () => {
    // Arrange
    writeSession('file-name-differs', aiTitleLine('recorded-session-id', 'Forked session'));

    // Act
    const { sessions } = await listClaudeSessions(PROJECT_ROOT);

    // Assert
    expect(sessions[0].id).toBe('recorded-session-id');
  });

  it('orders sessions newest-first and reads only the newest N when limited', async () => {
    // Arrange
    writeSession('oldest', aiTitleLine('oldest', 'Oldest'), 1_000_000);
    writeSession('middle', aiTitleLine('middle', 'Middle'), 2_000_000);
    writeSession('newest', aiTitleLine('newest', 'Newest'), 3_000_000);

    // Act
    const limited = await listClaudeSessions(PROJECT_ROOT, 2);
    const everything = await listClaudeSessions(PROJECT_ROOT);

    // Assert
    expect(limited.sessions.map((s) => s.id)).toEqual(['newest', 'middle']);
    expect(limited.total).toBe(3);
    expect(everything.sessions.map((s) => s.id)).toEqual(['newest', 'middle', 'oldest']);
    expect(everything.total).toBe(3);
  });

  it('returns an empty listing when the project has no claude directory', async () => {
    // Arrange
    const unknownProject = '/Users/tester/projects/never-used';

    // Act
    const listing = await listClaudeSessions(unknownProject);

    // Assert
    expect(listing).toEqual({ sessions: [], total: 0 });
  });

  it('reads session files off the main thread and yields the caller turn', async () => {
    // Arrange
    writeSession('async-a', filler(4 * SCAN_BYTES) + aiTitleLine('async-a', 'A'));
    writeSession('async-b', filler(4 * SCAN_BYTES) + aiTitleLine('async-b', 'B'));
    syncReadSpies.readFileSync.mockClear();
    syncReadSpies.readSync.mockClear();

    // Act
    const pending = listClaudeSessions(PROJECT_ROOT);
    const firstSettled = await Promise.race([
      pending.then(() => 'listing'),
      new Promise<string>((resolve) => { setImmediate(() => resolve('event-loop')); }),
    ]);

    // Assert
    expect(firstSettled).toBe('event-loop');
    await expect(pending).resolves.toMatchObject({ total: 2 });
    expect(syncReadSpies.readFileSync).not.toHaveBeenCalled();
    expect(syncReadSpies.readSync).not.toHaveBeenCalled();
  });
});
