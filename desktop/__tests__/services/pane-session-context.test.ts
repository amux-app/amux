import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { basename, join } from 'node:path';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import type { FSWatcher, PathLike, WatchListener } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AumxPane } from 'aumx/core';
import { createParser, type AgentLogParser } from '../../src/main/services/parsing/AgentLogParser';
import type { AgentType, NormalizedSession } from '../../src/shared/agent-session-types';
import { createEmptySession } from '../../src/shared/agent-session-types';
import { PaneSessionContext } from '../../src/main/services/agent-session/PaneSessionContext';

/**
 * Watching still happens for real; recording each listener only lets a test deliver a
 * directory event itself, instead of asking the OS for a burst it is free to coalesce.
 */
const watchListeners = vi.hoisted(() => new Map<string, WatchListener<string>>());

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();

  const watch = (target: PathLike, listener: WatchListener<string>): FSWatcher => {
    watchListeners.set(String(target), listener);
    return actual.watch(target, listener);
  };

  return { ...actual, watch };
});

const tempDirs: string[] = [];

// PaneSessionContext coalesces directory events over 1500ms before running a
// discovery pass; these give the single coalesced run room to land.
const REPLACEMENT_DEBOUNCE_MS = 1_500;
const REPLACEMENT_WINDOW_MS = 2_200;
const REBIND_TIMEOUT_MS = 6_000;
const DISCOVERY_ROOT_RECHECK_MS = 30_000;
// A per-session file in a shared tree keeps the responsive poll: the liveness gate,
// not the timer, is what removes the discovery work there.
const EXCLUSIVE_TREE_POLL_MS = 1_500;
const EXCLUSIVE_TREE_DISCOVERY_MS = 5_000;
// Covers several polls of either replacement interval (1.5s exclusive, 5s shared).
const WRITE_WINDOW_MS = 12_000;
const WRITE_STEP_MS = 500;
const SLOW_TEST_TIMEOUT_MS = 15_000;
const BURST_LINES = 30;
const BURST_INTERVAL_MS = 10;
// Ten events spread over less than one debounce window: every one of them belongs to
// the same burst, and each is late enough that an unwindowed check would run again.
const BURST_EVENT_COUNT = 10;
const BURST_EVENT_STEP_MS = 100;
const BURST_EVENT_FILENAME = 'sibling-session.jsonl';
// Mirrors PaneSessionContext's own discovery constants.
const FAST_DISCOVERY_WINDOW_MS = 30_000;
const DISCOVERY_DEBOUNCE_MS = 200;

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makePane(overrides: Partial<AumxPane> = {}): AumxPane {
  return {
    id: 'aumx-1',
    paneId: '%1',
    prompt: 'test prompt',
    slug: 'test-pane',
    agent: 'claude',
    ...overrides,
  };
}

function makeParser(sessionDir: string): AgentLogParser {
  return {
    agent: 'claude',
    boundFileIsExclusive: true,
    findSessionFile: async (_pane, _projectRoot, excludePaths) => {
      const files = readdirSync(sessionDir)
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => {
          const path = join(sessionDir, name);
          return { path, mtime: statSync(path).mtimeMs };
        })
        .filter((file) => !excludePaths?.has(file.path))
        .sort((a, b) => b.mtime - a.mtime);

      return files[0]?.path ?? null;
    },
    getSessionDirectory: () => sessionDir,
    parseSession: async (filePath) => {
      const stat = statSync(filePath);
      const session = createEmptySession('claude', basename(filePath, '.jsonl'));
      session.startTime = stat.mtimeMs;
      session.lastUpdateTime = stat.mtimeMs;
      session.messages.push({
        content: readFileSync(filePath, 'utf-8').trim(),
        id: session.sessionId,
        timestamp: stat.mtimeMs,
        toolCalls: [],
        toolResults: [],
        type: 'user',
      });
      session.metrics.messageCount = session.messages.length;
      return session;
    },
  };
}

function makeRootTrackingParser(): AgentLogParser {
  const parser = makeParser('');
  parser.getSessionDirectory = (_pane, projectRoot) => projectRoot;
  parser.findSessionFile = async (_pane, projectRoot, excludePaths) => {
    const files = readdirSync(projectRoot)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => join(projectRoot, name))
      .filter((path) => !excludePaths?.has(path))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return files[0] ?? null;
  };
  return parser;
}

function makeSharedTreeParser(
  agent: AgentType,
  boundFileIsExclusive: boolean,
  getFilePath: () => string,
): AgentLogParser {
  return {
    agent,
    boundFileIsExclusive,
    findSessionFile: async () => getFilePath(),
    getSessionDirectory: () => null,
    parseSession: async (filePath) => {
      const stat = statSync(filePath);
      const session = createEmptySession(agent, basename(filePath, '.jsonl'));
      session.startTime = stat.mtimeMs;
      session.lastUpdateTime = stat.mtimeMs;
      session.messages.push({
        content: readFileSync(filePath, 'utf-8').trim(),
        id: session.sessionId,
        timestamp: stat.mtimeMs,
        toolCalls: [],
        toolResults: [],
        type: 'user',
      });
      session.metrics.messageCount = session.messages.length;
      return session;
    },
  };
}

function countReplacementLookups(spy: MockInstance): number {
  return spy.mock.calls.filter((call) => call[3] === 'replacement').length;
}

function emitDirectoryEvent(dir: string, filename: string): void {
  const listener = watchListeners.get(dir);
  if (!listener) throw new Error(`no directory watcher registered for ${dir}`);
  listener('rename', filename);
}

function setModifiedTime(path: string, timeMs: number): void {
  utimesSync(path, new Date(timeMs), new Date(timeMs));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function appendBurst(path: string, lines: number, intervalMs = BURST_INTERVAL_MS): Promise<void> {
  for (let i = 0; i < lines; i++) {
    appendFileSync(path, `burst line ${i}\n`);
    if (intervalMs > 0) await delay(intervalMs);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
}

afterEach(() => {
  vi.useRealTimers();
  watchListeners.clear();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('PaneSessionContext', () => {
  it('backs off unwatchable session discovery after the startup window', async () => {
    vi.useFakeTimers();
    const parser = makeSharedTreeParser('codex', true, () => '');
    parser.findSessionFile = vi.fn().mockResolvedValue(null);
    const context = new PaneSessionContext(
      makePane({ agent: 'codex' }),
      parser,
      '/project',
      () => {},
    );

    try {
      await context.start();

      await vi.advanceTimersByTimeAsync(30_000);
      const startupLookups = vi.mocked(parser.findSessionFile).mock.calls.length;
      expect(startupLookups).toBeGreaterThan(1);

      await vi.advanceTimersByTimeAsync(29_999);
      expect(parser.findSessionFile).toHaveBeenCalledTimes(startupLookups);

      await vi.advanceTimersByTimeAsync(1);
      expect(parser.findSessionFile).toHaveBeenCalledTimes(startupLookups + 1);
    } finally {
      context.stop();
    }
  });

  it('keeps polling after a discovery failure and binds on the retry', async () => {
    // Arrange: the first discovery pass throws the way a truncated OpenCode query does.
    vi.useFakeTimers();
    const sessionDir = createTempDir('aumx-pane-session-');
    const file = join(sessionDir, 'recovered-session.jsonl');
    writeFileSync(file, 'conversation\n');
    const parser = makeSharedTreeParser('opencode', false, () => file);
    const findSessionFile = vi.fn()
      .mockRejectedValueOnce(new SyntaxError('Unterminated string in JSON at position 65536'))
      .mockResolvedValue(file);
    parser.findSessionFile = findSessionFile;
    const context = new PaneSessionContext(
      makePane({ agent: 'opencode' }),
      parser,
      sessionDir,
      () => {},
    );

    try {
      // Act
      await context.start();
      await vi.advanceTimersByTimeAsync(EXCLUSIVE_TREE_POLL_MS);

      // Assert
      expect(findSessionFile.mock.calls.length).toBeGreaterThan(1);
      expect(context.getFilePath()).toBe(file);
    } finally {
      context.stop();
    }
  });

  it('binds a file created after the fast discovery window from the directory watcher', async () => {
    // Arrange: past the fast window the poll drops to 30s, so only the still-armed
    // directory watcher can bind a session the user starts late.
    vi.useFakeTimers();
    const sessionDir = createTempDir('aumx-pane-session-');
    const parser = makeParser(sessionDir);
    const context = new PaneSessionContext(makePane(), parser, sessionDir, () => {});

    try {
      await context.start();
      await vi.advanceTimersByTimeAsync(FAST_DISCOVERY_WINDOW_MS + 1_000);
      expect(context.getFilePath()).toBeNull();

      // Act
      const file = join(sessionDir, 'late-session.jsonl');
      writeFileSync(file, 'first prompt\n');
      emitDirectoryEvent(sessionDir, 'late-session.jsonl');
      await vi.advanceTimersByTimeAsync(DISCOVERY_DEBOUNCE_MS);

      // Assert
      expect(context.getFilePath()).toBe(file);
    } finally {
      context.stop();
    }
  });

  it('binds from a discovery-directory event when the parser has no session directory', async () => {
    // Arrange: OpenCode's shape — one shared database, no watchable session dir.
    vi.useFakeTimers();
    const databaseDir = createTempDir('aumx-pane-session-db-');
    const databasePath = join(databaseDir, 'opencode.db');
    writeFileSync(databasePath, 'db\n');
    let sessionExists = false;
    const parser = makeSharedTreeParser('opencode', false, () => databasePath);
    parser.findSessionFile = vi.fn(async () => (sessionExists ? databasePath : null));
    parser.getDiscoveryWatchDirectory = () => databaseDir;
    parser.isDiscoveryFileName = (name: string) => name.startsWith('opencode.db');
    const context = new PaneSessionContext(
      makePane({ agent: 'opencode' }),
      parser,
      databaseDir,
      () => {},
    );

    try {
      await context.start();
      expect(context.getFilePath()).toBeNull();

      // Act: the agent writes its first turn, which lands on the -wal sidecar.
      sessionExists = true;
      emitDirectoryEvent(databaseDir, 'opencode.db-wal');
      await vi.advanceTimersByTimeAsync(DISCOVERY_DEBOUNCE_MS);

      // Assert
      expect(context.getFilePath()).toBe(databasePath);
    } finally {
      context.stop();
    }
  });

  it('reparses a bound OpenCode session when SQLite writes only to the WAL sidecar', async () => {
    vi.useFakeTimers();
    const databaseDir = createTempDir('aumx-pane-session-wal-');
    const databasePath = join(databaseDir, 'opencode.db');
    const walPath = `${databasePath}-wal`;
    writeFileSync(databasePath, 'main database\n');

    let generation = 1;
    const updates: number[] = [];
    const parser = makeSharedTreeParser('opencode', false, () => databasePath) as AgentLogParser & {
      getSessionWatchPaths: (filePath: string) => string[];
    };
    parser.getSessionWatchPaths = (filePath) => [filePath, `${filePath}-wal`];
    parser.parseSession = async () => {
      const session = createEmptySession('opencode', 'session-1');
      session.metrics.messageCount = generation;
      return session;
    };
    const context = new PaneSessionContext(
      makePane({ agent: 'opencode' }),
      parser,
      databaseDir,
      (_paneId, session) => updates.push(session.metrics.messageCount),
    );

    try {
      await context.start();
      expect(updates).toEqual([1]);

      generation = 2;
      // SQLite can create a fresh WAL after the watcher has already bound to
      // the main database (for example after a checkpoint removed the old one).
      writeFileSync(walPath, 'wal generation 2\n');
      await vi.advanceTimersByTimeAsync(350);

      expect(updates).toEqual([1, 2]);
    } finally {
      context.stop();
    }
  });

  it('rebinds to a newer Claude session file created after the pane was already tracked', async () => {
    // Arrange
    const sessionDir = createTempDir('aumx-pane-session-');
    const oldFile = join(sessionDir, 'old-session.jsonl');
    const oldTime = Date.now() - 10_000;
    writeFileSync(oldFile, 'old conversation\n');
    utimesSync(oldFile, oldTime / 1000, oldTime / 1000);

    const updates: NormalizedSession[] = [];
    const context = new PaneSessionContext(
      makePane(),
      makeParser(sessionDir),
      sessionDir,
      (_paneId, session) => updates.push(session),
      undefined,
      new Set<string>(),
    );

    try {
      await context.start();
      expect(updates.at(-1)?.sessionId).toBe('old-session');

      // Act
      const newFile = join(sessionDir, 'new-session.jsonl');
      const newTime = Date.now() + 1000;
      writeFileSync(newFile, 'new conversation\n');
      utimesSync(newFile, newTime / 1000, newTime / 1000);

      // Assert
      await waitFor(() => updates.some((session) => session.sessionId === 'new-session'), REBIND_TIMEOUT_MS);
      expect(updates.at(-1)?.messages[0]?.content).toBe('new conversation');
    } finally {
      context.stop();
    }
  }, SLOW_TEST_TIMEOUT_MS);

  it('runs no discovery pass while the bound session file is still the newest one', async () => {
    // Arrange
    const sessionDir = createTempDir('aumx-pane-session-live-');
    const boundFile = join(sessionDir, 'bound-session.jsonl');
    writeFileSync(boundFile, 'bound conversation\n');

    const parser = makeParser(sessionDir);
    const findSessionFile = vi.spyOn(parser, 'findSessionFile');
    const resolveDiscoveryRoot = vi.fn(async () => sessionDir);
    const context = new PaneSessionContext(
      makePane(),
      parser,
      sessionDir,
      () => {},
      resolveDiscoveryRoot,
      new Set<string>(),
    );

    try {
      await context.start();
      resolveDiscoveryRoot.mockClear();

      // Act: a normal agent turn appends repeatedly to the already bound file
      await appendBurst(boundFile, BURST_LINES);
      await delay(REPLACEMENT_WINDOW_MS);

      // Assert: no directory scan and no discovery-root round trip
      expect(countReplacementLookups(findSessionFile)).toBe(0);
      expect(resolveDiscoveryRoot).not.toHaveBeenCalled();
    } finally {
      context.stop();
    }
  }, SLOW_TEST_TIMEOUT_MS);

  it('rebinds after the pane moves to another project, which the rebind gate cannot see', async () => {
    // Arrange: the bound file stays the newest in the original directory, so only a
    // re-resolved discovery root can reveal the session in the pane's new project.
    vi.useFakeTimers({ toFake: ['Date'] });
    const originalRoot = createTempDir('aumx-pane-session-root-a-');
    const movedRoot = createTempDir('aumx-pane-session-root-b-');
    const boundFile = join(originalRoot, 'bound-session.jsonl');
    writeFileSync(boundFile, 'bound conversation\n');

    let discoveryRoot = originalRoot;
    const updates: NormalizedSession[] = [];
    const context = new PaneSessionContext(
      makePane(),
      makeRootTrackingParser(),
      discoveryRoot,
      (_paneId, session) => updates.push(session),
      async () => discoveryRoot,
      new Set<string>(),
    );

    try {
      await context.start();
      expect(updates.at(-1)?.sessionId).toBe('bound-session');

      // Act: the pane moved, its new session file lives in another project directory
      const movedFile = join(movedRoot, 'moved-session.jsonl');
      writeFileSync(movedFile, 'moved conversation\n');
      setModifiedTime(movedFile, Date.now() + 1_000);
      discoveryRoot = movedRoot;
      vi.setSystemTime(Date.now() + DISCOVERY_ROOT_RECHECK_MS + 1_000);
      appendFileSync(boundFile, 'still appending\n');

      // Assert
      await waitFor(() => updates.some((session) => session.sessionId === 'moved-session'), REBIND_TIMEOUT_MS);
      expect(updates.at(-1)?.messages[0]?.content).toBe('moved conversation');
    } finally {
      context.stop();
    }
  }, SLOW_TEST_TIMEOUT_MS);

  it('coalesces a burst of session directory events into a single discovery pass', async () => {
    // Arrange: the watched directory stays empty and every event is delivered by the
    // test, so the burst size is the test's and not the OS event coalescer's. Removing
    // the bound file opens the rebind gate for good, which leaves the debounce window
    // as the only thing that can keep the discovery count down.
    vi.useFakeTimers();
    const watchedDir = createTempDir('aumx-pane-session-burst-watched-');
    const sessionDir = createTempDir('aumx-pane-session-burst-');
    const boundFile = join(sessionDir, 'bound-session.jsonl');
    writeFileSync(boundFile, 'bound conversation\n');

    const parser = makeParser(watchedDir);
    parser.findSessionFile = async (_pane, _projectRoot, _excludePaths, mode) =>
      (mode === 'replacement' ? null : boundFile);
    parser.parseSession = async () => createEmptySession('claude', basename(boundFile, '.jsonl'));
    const findSessionFile = vi.spyOn(parser, 'findSessionFile');
    const context = new PaneSessionContext(
      makePane(),
      parser,
      watchedDir,
      () => {},
      undefined,
      new Set<string>(),
    );

    try {
      await context.start();
      unlinkSync(boundFile);

      // Act
      for (let event = 0; event < BURST_EVENT_COUNT; event += 1) {
        emitDirectoryEvent(watchedDir, BURST_EVENT_FILENAME);
        await vi.advanceTimersByTimeAsync(BURST_EVENT_STEP_MS);
      }
      await vi.advanceTimersByTimeAsync(REPLACEMENT_DEBOUNCE_MS);

      // Assert
      expect(countReplacementLookups(findSessionFile)).toBe(1);
    } finally {
      context.stop();
    }
  }, SLOW_TEST_TIMEOUT_MS);

  it('runs a discovery pass once the bound session file disappears', async () => {
    // Arrange
    const sessionDir = createTempDir('aumx-pane-session-missing-');
    const boundFile = join(sessionDir, 'bound-session.jsonl');
    writeFileSync(boundFile, 'bound conversation\n');

    const parser = makeParser(sessionDir);
    const findSessionFile = vi.spyOn(parser, 'findSessionFile');
    const context = new PaneSessionContext(
      makePane(),
      parser,
      sessionDir,
      () => {},
      undefined,
      new Set<string>(),
    );

    try {
      await context.start();

      // Act
      unlinkSync(boundFile);
      await delay(REPLACEMENT_WINDOW_MS);

      // Assert
      expect(countReplacementLookups(findSessionFile)).toBeGreaterThan(0);
    } finally {
      context.stop();
    }
  }, SLOW_TEST_TIMEOUT_MS);

  it('rebinds when an existing sibling session file is replaced in place', async () => {
    // Arrange: sibling already exists but is stale, so the bound file stays selected.
    // Rewriting it later emits no create/rename — on Linux it is a plain `change`.
    const sessionDir = createTempDir('aumx-pane-session-inplace-');
    const siblingFile = join(sessionDir, 'sibling-session.jsonl');
    writeFileSync(siblingFile, 'stale conversation\n');
    setModifiedTime(siblingFile, Date.now() - 20_000);

    const boundFile = join(sessionDir, 'bound-session.jsonl');
    writeFileSync(boundFile, 'bound conversation\n');

    const updates: NormalizedSession[] = [];
    const context = new PaneSessionContext(
      makePane(),
      makeParser(sessionDir),
      sessionDir,
      (_paneId, session) => updates.push(session),
      undefined,
      new Set<string>(),
    );

    try {
      await context.start();
      expect(updates.at(-1)?.sessionId).toBe('bound-session');

      // Act
      writeFileSync(siblingFile, 'resumed conversation\n');
      setModifiedTime(siblingFile, Date.now() + 1_000);

      // Assert
      await waitFor(() => updates.some((session) => session.sessionId === 'sibling-session'), REBIND_TIMEOUT_MS);
      expect(updates.at(-1)?.messages[0]?.content).toBe('resumed conversation');
    } finally {
      context.stop();
    }
  }, SLOW_TEST_TIMEOUT_MS);

  it('polls for a replacement Codex session after an initial shared file is found', async () => {
    // Arrange
    vi.useFakeTimers();
    const sessionDir = createTempDir('aumx-pane-session-codex-');
    const staleFile = join(sessionDir, 'stale-session.jsonl');
    const freshFile = join(sessionDir, 'fresh-session.jsonl');
    const now = Date.now();
    writeFileSync(staleFile, 'stale conversation\n');
    writeFileSync(freshFile, 'fresh conversation\n');
    utimesSync(staleFile, new Date(now), new Date(now));
    utimesSync(freshFile, new Date(now + 1000), new Date(now + 1000));

    let selectedFile = staleFile;
    const parser = makeSharedTreeParser('codex', true, () => selectedFile);
    const findSessionFile = vi.spyOn(parser, 'findSessionFile');
    const updates: NormalizedSession[] = [];
    const context = new PaneSessionContext(
      makePane({ agent: 'codex' }),
      parser,
      sessionDir,
      (_paneId, session) => updates.push(session),
      undefined,
      new Set<string>(),
    );

    try {
      await context.start();
      expect(updates.at(-1)?.sessionId).toBe('stale-session');

      // Act
      selectedFile = freshFile;
      await vi.advanceTimersByTimeAsync(EXCLUSIVE_TREE_DISCOVERY_MS + EXCLUSIVE_TREE_POLL_MS);

      // Assert
      expect(updates.at(-1)?.sessionId).toBe('fresh-session');
      expect(updates.at(-1)?.messages[0]?.content).toBe('fresh conversation');
      expect(findSessionFile).toHaveBeenLastCalledWith(
        expect.any(Object),
        sessionDir,
        expect.any(Set),
        'replacement',
      );
    } finally {
      context.stop();
    }
  });

  it('does not rebind a Codex session to an older shared file', async () => {
    // Arrange
    vi.useFakeTimers();
    const sessionDir = createTempDir('aumx-pane-session-codex-');
    const olderFile = join(sessionDir, 'older-session.jsonl');
    const currentFile = join(sessionDir, 'current-session.jsonl');
    const now = Date.now();
    writeFileSync(olderFile, 'older conversation\n');
    utimesSync(olderFile, new Date(now - 1000), new Date(now - 1000));
    writeFileSync(currentFile, 'current conversation\n');
    utimesSync(currentFile, new Date(now), new Date(now));

    let selectedFile = currentFile;
    const updates: NormalizedSession[] = [];
    const context = new PaneSessionContext(
      makePane({ agent: 'codex' }),
      makeSharedTreeParser('codex', true, () => selectedFile),
      sessionDir,
      (_paneId, session) => updates.push(session),
      undefined,
      new Set<string>(),
    );

    try {
      await context.start();
      expect(updates.at(-1)?.sessionId).toBe('current-session');

      // Act
      selectedFile = olderFile;
      await vi.advanceTimersByTimeAsync(EXCLUSIVE_TREE_DISCOVERY_MS + EXCLUSIVE_TREE_POLL_MS);

      // Assert
      expect(updates.at(-1)?.sessionId).toBe('current-session');
      expect(updates.at(-1)?.messages[0]?.content).toBe('current conversation');
    } finally {
      context.stop();
    }
  });

  it('does not start a watcher when stopped while findSessionFile is in flight', async () => {
    // Arrange: gate findSessionFile so we can stop() mid-start(), and spy on
    // parseSession — onFileFound starts the watcher and kicks a parse, so a
    // parseSession call after stop() means a watcher leaked.
    const sessionDir = createTempDir('aumx-pane-session-');
    const file = join(sessionDir, 'live-session.jsonl');
    writeFileSync(file, 'conversation\n');

    let releaseFind: (path: string) => void = () => {};
    const findGate = new Promise<string>((resolve) => { releaseFind = resolve; });
    const parser = makeParser(sessionDir);
    parser.findSessionFile = () => findGate;
    const parseSpy = vi.spyOn(parser, 'parseSession');

    const context = new PaneSessionContext(
      makePane(),
      parser,
      sessionDir,
      () => {},
      undefined,
      new Set<string>(),
    );

    // Act: begin start(), stop() before findSessionFile resolves, then resolve.
    const started = context.start();
    context.stop();
    releaseFind(file);
    await started;
    await Promise.resolve();

    // Assert: onFileFound bailed out, so no parse (and no watcher) ever ran.
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it('does not claim a replacement found after the context is stopped', async () => {
    // Arrange
    vi.useFakeTimers();
    const sessionDir = createTempDir('aumx-pane-session-stop-replacement-');
    const currentFile = join(sessionDir, 'current-session.jsonl');
    const replacementFile = join(sessionDir, 'replacement-session.jsonl');
    const now = Date.now();
    writeFileSync(currentFile, 'current conversation\n');
    writeFileSync(replacementFile, 'replacement conversation\n');
    setModifiedTime(currentFile, now);
    setModifiedTime(replacementFile, now + 1_000);

    let releaseReplacement: ((path: string) => void) | undefined;
    let markReplacementStarted: (() => void) | undefined;
    const replacementStarted = new Promise<void>((resolve) => {
      markReplacementStarted = resolve;
    });
    const replacementResult = new Promise<string>((resolve) => {
      releaseReplacement = resolve;
    });
    const parser = makeSharedTreeParser('codex', true, () => currentFile);
    parser.findSessionFile = async (_pane, _root, _claimed, mode) => {
      if (mode !== 'replacement') return currentFile;
      markReplacementStarted?.();
      return replacementResult;
    };
    const claimedFiles = new Set<string>();
    const context = new PaneSessionContext(
      makePane({ agent: 'codex' }),
      parser,
      sessionDir,
      () => {},
      undefined,
      claimedFiles,
    );

    // Act
    await context.start();
    vi.setSystemTime(Date.now() + EXCLUSIVE_TREE_DISCOVERY_MS);
    vi.advanceTimersByTime(EXCLUSIVE_TREE_POLL_MS + 100);
    await replacementStarted;
    context.stop();
    releaseReplacement?.(replacementFile);
    await Promise.resolve();
    await Promise.resolve();

    // Assert
    expect(claimedFiles).toEqual(new Set());
    expect(context.getFilePath()).toBe(currentFile);
  });

  it('does not emit an old parse that finishes after a replacement is bound', async () => {
    // Arrange
    vi.useFakeTimers();
    const sessionDir = createTempDir('aumx-pane-session-stale-parse-');
    const currentFile = join(sessionDir, 'current-session.jsonl');
    const replacementFile = join(sessionDir, 'replacement-session.jsonl');
    const now = Date.now();
    writeFileSync(currentFile, 'current conversation\n');
    writeFileSync(replacementFile, 'replacement conversation\n');
    setModifiedTime(currentFile, now);
    setModifiedTime(replacementFile, now + 1_000);

    let selectedFile = currentFile;
    let releaseCurrentParse: (() => void) | undefined;
    let markCurrentParseStarted: (() => void) | undefined;
    const currentParseStarted = new Promise<void>((resolve) => {
      markCurrentParseStarted = resolve;
    });
    const currentParseGate = new Promise<void>((resolve) => {
      releaseCurrentParse = resolve;
    });
    let markReplacementUpdated: (() => void) | undefined;
    const replacementUpdated = new Promise<void>((resolve) => {
      markReplacementUpdated = resolve;
    });
    const parser = makeSharedTreeParser('codex', true, () => selectedFile);
    const parseSession = parser.parseSession.bind(parser);
    parser.parseSession = async (filePath) => {
      if (filePath === currentFile) {
        markCurrentParseStarted?.();
        await currentParseGate;
      }
      return parseSession(filePath);
    };
    const updates: string[] = [];
    const context = new PaneSessionContext(
      makePane({ agent: 'codex' }),
      parser,
      sessionDir,
      (_paneId, session) => {
        updates.push(session.sessionId);
        if (session.sessionId === 'replacement-session') markReplacementUpdated?.();
      },
      undefined,
      new Set<string>(),
    );

    try {
      await context.start();
      await currentParseStarted;
      selectedFile = replacementFile;
      await vi.advanceTimersByTimeAsync(EXCLUSIVE_TREE_DISCOVERY_MS + EXCLUSIVE_TREE_POLL_MS);

      // Act
      releaseCurrentParse?.();
      await replacementUpdated;

      // Assert
      expect(updates).toEqual(['replacement-session']);
    } finally {
      context.stop();
    }
  });
});

/**
 * Without a watchable directory the liveness gate is the only thing standing between
 * an idle pane and a full discovery pass, and it is only sound for a parser whose
 * session file holds exactly one session. These pin both halves of that contract.
 */
describe('bound session file exclusivity', () => {
  async function countLookupsWhileBoundFileChanges(boundFileIsExclusive: boolean): Promise<number> {
    const sessionDir = createTempDir('aumx-pane-session-exclusivity-');
    const boundFile = join(sessionDir, 'bound-session.jsonl');
    writeFileSync(boundFile, 'bound conversation\n');

    const parser = makeSharedTreeParser('codex', boundFileIsExclusive, () => boundFile);
    const findSessionFile = vi.spyOn(parser, 'findSessionFile');
    const context = new PaneSessionContext(
      makePane({ agent: 'codex' }),
      parser,
      sessionDir,
      () => {},
      undefined,
      new Set<string>(),
    );

    try {
      await context.start();
      // Appending on every step keeps the file freshly written whichever interval the
      // context picked, so the count reflects the gate and not the timer.
      for (let elapsed = 0; elapsed < WRITE_WINDOW_MS; elapsed += WRITE_STEP_MS) {
        appendFileSync(boundFile, `turn line ${elapsed}\n`);
        await vi.advanceTimersByTimeAsync(WRITE_STEP_MS);
      }
      return countReplacementLookups(findSessionFile);
    } finally {
      context.stop();
    }
  }

  it('marks a parser exclusive only when one session file holds one session', () => {
    // Arrange / Act
    const exclusivity = {
      claude: createParser('claude').boundFileIsExclusive,
      codex: createParser('codex').boundFileIsExclusive,
      opencode: createParser('opencode').boundFileIsExclusive,
    };

    // Assert: OpenCode keeps every session of a project in one SQLite database, so a
    // write to it says nothing about the session a pane is bound to.
    expect(exclusivity).toEqual({ claude: true, codex: true, opencode: false });
  });

  it('skips the discovery pass while an exclusive bound session file keeps growing', async () => {
    // Arrange
    vi.useFakeTimers();

    // Act
    const lookups = await countLookupsWhileBoundFileChanges(true);

    // Assert
    expect(lookups).toBe(0);
  });

  it('rate-limits discovery after an exclusive bound session file becomes idle', async () => {
    // Arrange
    vi.useFakeTimers();
    const sessionDir = createTempDir('aumx-pane-session-exclusive-idle-');
    const boundFile = join(sessionDir, 'bound-session.jsonl');
    writeFileSync(boundFile, 'bound conversation\n');
    const parser = makeSharedTreeParser('codex', true, () => boundFile);
    const findSessionFile = vi.spyOn(parser, 'findSessionFile');
    const context = new PaneSessionContext(
      makePane({ agent: 'codex' }),
      parser,
      sessionDir,
      () => {},
      undefined,
      new Set<string>(),
    );

    try {
      await context.start();

      // Act
      await vi.advanceTimersByTimeAsync(WRITE_WINDOW_MS);

      // Assert: cheap stat polls stay responsive at 1.5s, but an idle pane no
      // longer pays for shared-tree discovery on every one of those ticks.
      expect(countReplacementLookups(findSessionFile)).toBeGreaterThan(0);
      expect(countReplacementLookups(findSessionFile)).toBeLessThanOrEqual(2);
    } finally {
      context.stop();
    }
  });

  it('keeps discovering while a shared bound session store keeps changing', async () => {
    // Arrange: this is the OpenCode shape, so it reads the real parser's answer —
    // marking OpenCode exclusive would silence its session-switch detection.
    vi.useFakeTimers();
    const opencodeExclusive = createParser('opencode').boundFileIsExclusive;

    // Act
    const lookups = await countLookupsWhileBoundFileChanges(opencodeExclusive);

    // Assert
    expect(lookups).toBeGreaterThan(0);
  });
});
