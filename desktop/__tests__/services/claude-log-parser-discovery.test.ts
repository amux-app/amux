import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AumxPane } from 'aumx/core';
import { ClaudeLogParser } from '../../src/main/services/parsing/ClaudeLogParser';
import {
  listSessionFilesByMtime,
  type SessionFileStat,
} from '../../src/main/services/parsing/session-files';

const homeDirState = vi.hoisted(() => ({ value: '' }));

vi.mock('os', () => ({
  homedir: () => homeDirState.value,
}));

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join('/tmp', prefix));
  tempDirs.push(dir);
  return dir;
}

function makePane(overrides: Partial<AumxPane> = {}): AumxPane {
  return {
    id: 'aumx-1',
    paneId: '%1',
    prompt: 'test prompt',
    slug: 'claude-pane',
    ...overrides,
  };
}

function createTempHome(): string {
  const dir = createTempDir('aumx-claude-home-');
  homeDirState.value = dir;
  return dir;
}

function writeClaudeSession(sessionDir: string, sessionId: string, title: string): string {
  const filePath = join(sessionDir, `${sessionId}.jsonl`);
  const timestamp = new Date().toISOString();
  writeFileSync(filePath, [
    `{"type":"assistant","timestamp":"${timestamp}","message":{"role":"assistant","content":"ok"}}`,
    `{"type":"ai-title","timestamp":"${timestamp}","sessionId":"${sessionId}","aiTitle":"${title}"}`,
    '',
  ].join('\n'));
  return filePath;
}

function fillerLines(byteBudget: number): string {
  const line = `{"type":"user","message":{"role":"user","content":"${'filler '.repeat(20)}"}}`;
  return `${line}\n`.repeat(Math.ceil(byteBudget / (line.length + 1)));
}

function writePaddedClaudeSession(
  sessionDir: string,
  sessionId: string,
  title: string,
  leadingBytes: number,
  trailingBytes: number,
): string {
  const filePath = join(sessionDir, `${sessionId}.jsonl`);
  const timestamp = new Date().toISOString();
  writeFileSync(filePath, [
    fillerLines(leadingBytes),
    `{"type":"ai-title","timestamp":"${timestamp}","sessionId":"${sessionId}","aiTitle":"${title}"}\n`,
    fillerLines(trailingBytes),
  ].join(''));
  return filePath;
}

function createSessionDir(): string {
  const sessionDir = join(homeDirState.value, '.claude', 'projects', '-Users-user-my-repo');
  mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

/**
 * Discovery by pane title, through the public entry point. The pane id carries a
 * creation time far from every fixture file, so the birthtime and mtime fallbacks
 * cannot answer and only the title match can produce a result.
 */
function findByPaneTitle(paneTitle: string): Promise<string | null> {
  return new ClaudeLogParser().findSessionFile(
    makePane({
      agent: 'claude',
      id: 'aumx-1600000000000',
      projectRoot: '/Users/user/my-repo',
      terminalTranscriptPath: writePaneTranscript(paneTitle),
    }),
    '/Users/user/my-repo',
  );
}

function writePaneTranscript(title: string): string {
  const transcriptPath = join(createTempDir('aumx-claude-transcript-'), 'pane.ansi');
  writeFileSync(transcriptPath, `\u001b]0;\u2733 ${title}\u0007`);
  return transcriptPath;
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

interface MtimeMatcher {
  findSessionByPaneMtime: (candidates: SessionFileStat[], paneCreatedAt: number) => Promise<string | null>;
}

/** The mtime fallback is internal; these cases pin the freshness gate it applies. */
function mtimeMatcher(): MtimeMatcher {
  return new ClaudeLogParser() as unknown as MtimeMatcher;
}

describe('ClaudeLogParser session discovery', () => {
  it('does not bind a new pane to an old Claude session whose file was only touched during startup', async () => {
    const parser = mtimeMatcher();
    const projectDir = createTempDir('aumx-claude-session-');
    const filePath = join(projectDir, 'session.jsonl');

    writeFileSync(filePath, `{"type":"assistant","timestamp":"${new Date(Date.now() - 60_000).toISOString()}","message":{"role":"assistant","content":"ok"}}\n`);
    const initialStat = Date.now() - 30_000;
    const paneCreatedAt = initialStat + 20_000;
    utimesSync(filePath, initialStat / 1000, (paneCreatedAt + 500) / 1000);

    const matched = await parser.findSessionByPaneMtime(await listSessionFilesByMtime(projectDir), paneCreatedAt);
    expect(matched).toBeNull();
  });

  it('matches an mtime candidate only when the session contains fresh pane activity', async () => {
    const parser = mtimeMatcher();
    const projectDir = createTempDir('aumx-claude-session-');
    const filePath = join(projectDir, 'session.jsonl');
    const paneCreatedAt = Date.now();

    writeFileSync(filePath, `{"type":"user","timestamp":"${new Date(paneCreatedAt + 500).toISOString()}","message":{"role":"user","content":"new task"}}\n`);
    utimesSync(filePath, (paneCreatedAt - 20_000) / 1000, (paneCreatedAt + 500) / 1000);

    const matched = await parser.findSessionByPaneMtime(await listSessionFilesByMtime(projectDir), paneCreatedAt);
    expect(matched).toBe(filePath);
  });

  it('prefers the persisted Claude session id even when the file predates the pane', async () => {
    const parser = new ClaudeLogParser();
    const home = homeDirState.value;
    const sessionDir = join(home, '.claude', 'projects', '-Users-user-my-repo');
    const filePath = join(sessionDir, 'session-123.jsonl');

    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(filePath, '{"type":"assistant","message":{"role":"assistant","content":"ok"}}\n');

    const found = await parser.findSessionFile(
      makePane({
        agent: 'claude',
        agentSessionId: 'session-123',
        id: `aumx-${Date.now()}`,
        projectRoot: '/Users/user/my-repo',
      }),
      '/Users/user/my-repo',
    );

    expect(found).toBe(filePath);
  });

  it('never returns an excluded file even when the persisted session id points at it', async () => {
    // Arrange: the file the pane is already bound to is excluded during a rebind.
    const parser = new ClaudeLogParser();
    const sessionDir = join(homeDirState.value, '.claude', 'projects', '-Users-user-my-repo');
    mkdirSync(sessionDir, { recursive: true });
    const claimedPath = writeClaudeSession(sessionDir, 'claimed-session', 'Claimed Session');

    // Act
    const found = await parser.findSessionFile(
      makePane({
        agent: 'claude',
        agentSessionId: 'claimed-session',
        id: `aumx-${Date.now()}`,
        projectRoot: '/Users/user/my-repo',
      }),
      '/Users/user/my-repo',
      new Set([claimedPath]),
    );

    // Assert
    expect(found).toBeNull();
  });

  it('uses the pane title to correct a stale persisted Claude session id', async () => {
    const parser = new ClaudeLogParser();
    const sessionDir = join(homeDirState.value, '.claude', 'projects', '-Users-user-my-repo');

    mkdirSync(sessionDir, { recursive: true });
    writeClaudeSession(sessionDir, 'old-session', 'Learn the project deeply');
    const currentFilePath = writeClaudeSession(sessionDir, 'current-session', 'Introduce Claude Code capabilities');

    const found = await parser.findSessionFile(
      makePane({
        agent: 'claude',
        agentSessionId: 'old-session',
        id: `aumx-${Date.now()}`,
        projectRoot: '/Users/user/my-repo',
        terminalTranscriptPath: writePaneTranscript('Introduce Claude Code capabilities'),
      }),
      '/Users/user/my-repo',
    );

    expect(found).toBe(currentFilePath);
  });

  it('keeps the persisted Claude session id while the pane title is generic', async () => {
    const parser = new ClaudeLogParser();
    const sessionDir = join(homeDirState.value, '.claude', 'projects', '-Users-user-my-repo');

    mkdirSync(sessionDir, { recursive: true });
    const persistedFilePath = writeClaudeSession(sessionDir, 'persisted-session', 'Learn the project deeply');
    writeClaudeSession(sessionDir, 'other-session', 'Introduce Claude Code capabilities');

    const found = await parser.findSessionFile(
      makePane({
        agent: 'claude',
        agentSessionId: 'persisted-session',
        id: `aumx-${Date.now()}`,
        projectRoot: '/Users/user/my-repo',
        terminalTranscriptPath: writePaneTranscript('Claude Code'),
      }),
      '/Users/user/my-repo',
    );

    expect(found).toBe(persistedFilePath);
  });

  it('matches an ai-title that sits inside the bounded tail scan of a large session file', async () => {
    // Arrange: 512 KiB of history before the ai-title record, 8 KiB after it.
    const filePath = writePaddedClaudeSession(
      createSessionDir(), 'large-session', 'Bounded Tail Scan', 512 * 1024, 8 * 1024,
    );

    // Act
    const matched = await findByPaneTitle('Bounded Tail Scan');

    // Assert
    expect(statSync(filePath).size).toBeGreaterThan(512 * 1024);
    expect(matched).toBe(filePath);
  });

  it('does not read past the bounded tail scan to find an ai-title', async () => {
    // Arrange: the ai-title record sits 96 KiB from EOF, outside the 64 KiB scan.
    writePaddedClaudeSession(createSessionDir(), 'buried-session', 'Buried Title', 8 * 1024, 96 * 1024);

    // Act
    const matched = await findByPaneTitle('Buried Title');

    // Assert
    expect(matched).toBeNull();
  });

  it('matches an ai-title on a session that many newer sessions have overtaken', async () => {
    // Arrange: the match is the 21st most recent file in a busy project directory.
    const sessionDir = createSessionDir();
    const matchPath = writeClaudeSession(sessionDir, 'stale-match', 'Old Matching Session');
    utimesSync(matchPath, new Date(1_778_000_000_000), new Date(1_778_000_000_000));
    for (let index = 0; index < 20; index++) {
      const decoyPath = writeClaudeSession(sessionDir, `recent-${index}`, `Recent Session ${index}`);
      const recent = new Date(1_778_000_100_000 + index * 1_000);
      utimesSync(decoyPath, recent, recent);
    }

    // Act
    const matched = await findByPaneTitle('Old Matching Session');

    // Assert
    expect(matched).toBe(matchPath);
  });

  it('harvests Claude ai-titles into the parsed session', async () => {
    // Arrange
    const projectDir = createTempDir('aumx-claude-aititle-');
    const filePath = writeClaudeSession(projectDir, 'titled-session', '✳ Introduce Claude Code Capabilities');

    // Act
    const session = await new ClaudeLogParser().parseSession(filePath);

    // Assert: valid Claude ai-title metadata is always harvested best-effort.
    expect(session.aiTitle).toBe('Introduce Claude Code Capabilities');
    expect(session.title).toBe('✳ Introduce Claude Code Capabilities');
  });

  it('uses the parent project root for Claude worktree log directories', () => {
    const parser = new ClaudeLogParser();
    const parentProjectDir = join(homeDirState.value, '.claude', 'projects', '-Users-user-my-repo');
    mkdirSync(parentProjectDir, { recursive: true });

    const sessionDir = parser.getSessionDirectory(
      makePane({
        agent: 'claude',
        projectRoot: '/Users/user/my-repo',
        worktreePath: '/Users/user/my-repo/.aumx/worktrees/fix-123',
      }),
      '/Users/user/my-repo/.aumx/worktrees/fix-123',
    );

    expect(sessionDir).toBe(parentProjectDir);
  });
});

/**
 * Cross-session theft: an external Claude session running in the same project
 * directory outranks the pane's own session on every recency heuristic. Nothing may
 * auto-bind a session born before the pane; explicit binds stay exempt.
 */
describe('ClaudeLogParser session ownership', () => {
  const OWNERSHIP_SKEW_MS = 60_000;

  function paneBornAfterFixtures(overrides: Partial<AumxPane> = {}): AumxPane {
    return makePane({
      agent: 'claude',
      id: `aumx-${Date.now() + OWNERSHIP_SKEW_MS}`,
      projectRoot: '/Users/user/my-repo',
      ...overrides,
    });
  }

  function paneBornBeforeFixtures(overrides: Partial<AumxPane> = {}): AumxPane {
    return makePane({
      agent: 'claude',
      id: `aumx-${Date.now() - OWNERSHIP_SKEW_MS}`,
      projectRoot: '/Users/user/my-repo',
      ...overrides,
    });
  }

  it('never binds a live external session that was born before the pane', async () => {
    // Arrange: the external session is the newest-modified file and its tail carries
    // fresh timestamps — exactly what let the mtime fallback steal it.
    const sessionDir = createSessionDir();
    writeClaudeSession(sessionDir, 'external-session', 'Someone elses work');

    // Act
    const file = await new ClaudeLogParser().findSessionFile(
      paneBornAfterFixtures(),
      '/Users/user/my-repo',
    );

    // Assert
    expect(file).toBeNull();
  });

  it('binds a session born after the pane', async () => {
    // Arrange
    const sessionDir = createSessionDir();
    const ownPath = writeClaudeSession(sessionDir, 'own-session', 'Pane session');

    // Act
    const file = await new ClaudeLogParser().findSessionFile(
      paneBornBeforeFixtures(),
      '/Users/user/my-repo',
    );

    // Assert
    expect(file).toBe(ownPath);
  });

  it('refuses an external session for a replacement hunt too', async () => {
    // Arrange
    const sessionDir = createSessionDir();
    writeClaudeSession(sessionDir, 'external-session', 'Someone elses work');

    // Act
    const file = await new ClaudeLogParser().findSessionFile(
      paneBornAfterFixtures(),
      '/Users/user/my-repo',
      undefined,
      'replacement',
    );

    // Assert
    expect(file).toBeNull();
  });

  it('binds an explicit persisted session id ahead of a newer candidate', async () => {
    // Arrange: the decoy is newer, so only the explicit id short-circuit can win.
    const sessionDir = createSessionDir();
    const persistedPath = writeClaudeSession(sessionDir, 'persisted-session', 'Persisted');
    writeClaudeSession(sessionDir, 'newer-session', 'Newer');
    const older = new Date(Date.now() - 10_000);
    utimesSync(persistedPath, older, older);

    // Act
    const file = await new ClaudeLogParser().findSessionFile(
      paneBornBeforeFixtures({ agentSessionId: 'persisted-session' }),
      '/Users/user/my-repo',
    );

    // Assert
    expect(file).toBe(persistedPath);
  });

  it('resumes a deliberately chosen session that predates the pane by a long way', async () => {
    // Arrange: `--resume` on a week-old session — the pane is new, the session is not.
    const sessionDir = createSessionDir();
    const resumedPath = writeClaudeSession(sessionDir, 'resumed-session', 'Last weeks work');

    // Act
    const file = await new ClaudeLogParser().findSessionFile(
      paneBornAfterFixtures({ agentSessionId: 'resumed-session' }),
      '/Users/user/my-repo',
    );

    // Assert
    expect(file).toBe(resumedPath);
  });

  it('trusts a persisted session id when the pane id carries no creation time', async () => {
    // Arrange: reopened worktree panes use `aumx-<uuid>`, so ownership must fail open.
    const sessionDir = createSessionDir();
    const persistedPath = writeClaudeSession(sessionDir, 'legacy-session', 'Legacy');

    // Act
    const file = await new ClaudeLogParser().findSessionFile(
      makePane({
        agent: 'claude',
        agentSessionId: 'legacy-session',
        id: 'aumx-2f1c7d64-7b0a-4a15-9a2e-1d1f0f0a1b2c',
        projectRoot: '/Users/user/my-repo',
      }),
      '/Users/user/my-repo',
    );

    // Assert
    expect(file).toBe(persistedPath);
  });
});
