import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { PiLogParser } from '../../src/main/services/parsing/PiLogParser';

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJsonl(filePath: string, lines: Array<Record<string, unknown>>): void {
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

async function createSessionFile(
  sessionDir: string,
  options: { id: string; cwd: string; prompt?: string; updatedAt?: number },
): Promise<string> {
  await mkdir(sessionDir, { recursive: true });
  const filePath = join(sessionDir, `${options.id}.jsonl`);
  const lines: Array<Record<string, unknown>> = [
    { type: 'session', version: 3, id: options.id, cwd: options.cwd, timestamp: '2026-01-01T00:00:00.000Z' },
  ];
  if (options.prompt) {
    lines.push({
      type: 'message',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: options.prompt }], timestamp: 1000 },
    });
  }
  await writeFile(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  if (options.updatedAt !== undefined) {
    const date = new Date(options.updatedAt);
    await utimes(filePath, date, date);
  }
  return filePath;
}

function makePane(overrides: { id?: string; agentSessionId?: string } = {}): Parameters<PiLogParser['findSessionFile']>[0] {
  return { id: overrides.id ?? 'muxbase-1', slug: 'test', paneId: '%1', agentSessionId: overrides.agentSessionId } as Parameters<PiLogParser['findSessionFile']>[0];
}

afterEach(async () => {
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('PiLogParser — parseSession', () => {
  it('uses the first user message text as the session title', async () => {
    // Arrange
    const dir = createTempDir('pi-parser-');
    const file = join(dir, 'session.jsonl');
    writeJsonl(file, [
      { type: 'session', version: 3, id: 'test-id', cwd: '/repo', timestamp: '2026-01-01T00:00:00.000Z' },
      {
        type: 'message',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'who are you?' }],
          timestamp: 1000,
        },
      },
    ]);

    // Act
    const session = await new PiLogParser().parseSession(file);

    // Assert
    expect(session.title).toBe('who are you?');
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]?.type).toBe('user');
    expect(session.messages[0]?.content).toBe('who are you?');
  });

  it('handles string content in user messages', async () => {
    // Arrange
    const dir = createTempDir('pi-parser-str-');
    const file = join(dir, 'session.jsonl');
    writeJsonl(file, [
      { type: 'session', version: 3, id: 'test-id', cwd: '/repo', timestamp: '2026-01-01T00:00:00.000Z' },
      {
        type: 'message',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'explain recursion', timestamp: 1000 },
      },
    ]);

    // Act
    const session = await new PiLogParser().parseSession(file);

    // Assert
    expect(session.title).toBe('explain recursion');
    expect(session.messages[0]?.content).toBe('explain recursion');
  });

  it('marks a newly submitted user prompt as an ongoing turn', async () => {
    const dir = createTempDir('pi-parser-ongoing-');
    const file = join(dir, 'session.jsonl');
    writeJsonl(file, [
      { type: 'session', version: 3, id: 'test-id', cwd: '/repo', timestamp: '2026-01-01T00:00:00.000Z' },
      {
        type: 'message',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'implement the feature', timestamp: 1000 },
      },
    ]);

    const session = await new PiLogParser().parseSession(file);

    expect(session.isOngoing).toBe(true);
    expect(session.turnCompleted).toBe(false);
  });

  it('marks Pi assistant stop as turn completion', async () => {
    const dir = createTempDir('pi-parser-completed-');
    const file = join(dir, 'session.jsonl');
    writeJsonl(file, [
      { type: 'session', version: 3, id: 'test-id', cwd: '/repo', timestamp: '2026-01-01T00:00:00.000Z' },
      {
        type: 'message',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'implement the feature', timestamp: 1000 },
      },
      {
        type: 'message',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Done.' }],
          timestamp: 2000,
        },
      },
    ]);

    const session = await new PiLogParser().parseSession(file);

    expect(session.isOngoing).toBe(false);
    expect(session.turnCompleted).toBe(true);
  });

  it.each(['length', 'aborted'])('marks Pi assistant %s as turn completion', async (stopReason) => {
    const dir = createTempDir('pi-parser-terminal-');
    const file = join(dir, 'session.jsonl');
    writeJsonl(file, [
      { type: 'session', version: 3, id: 'test-id', cwd: '/repo', timestamp: '2026-01-01T00:00:00.000Z' },
      {
        type: 'message',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'implement the feature', timestamp: 1000 },
      },
      {
        type: 'message',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          role: 'assistant',
          stopReason,
          content: [{ type: 'text', text: 'Turn ended.' }],
          timestamp: 2000,
        },
      },
    ]);

    const session = await new PiLogParser().parseSession(file);

    expect(session.isOngoing).toBe(false);
    expect(session.turnCompleted).toBe(true);
  });

  it.each(['toolUse', 'error'])('keeps Pi assistant %s entries ongoing', async (stopReason) => {
    const dir = createTempDir('pi-parser-intermediate-');
    const file = join(dir, 'session.jsonl');
    writeJsonl(file, [
      { type: 'session', version: 3, id: 'test-id', cwd: '/repo', timestamp: '2026-01-01T00:00:00.000Z' },
      {
        type: 'message',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'implement the feature', timestamp: 1000 },
      },
      {
        type: 'message',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          role: 'assistant',
          stopReason,
          content: [{ type: 'text', text: 'Still working.' }],
          timestamp: 2000,
        },
      },
    ]);

    const session = await new PiLogParser().parseSession(file);

    expect(session.isOngoing).toBe(true);
    expect(session.turnCompleted).toBe(false);
  });

  it('extracts thinking content from assistant messages', async () => {
    // Arrange
    const dir = createTempDir('pi-parser-think-');
    const file = join(dir, 'session.jsonl');
    writeJsonl(file, [
      { type: 'session', version: 3, id: 'test-id', cwd: '/repo', timestamp: '2026-01-01T00:00:00.000Z' },
      {
        type: 'message',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'hello', timestamp: 1000 },
      },
      {
        type: 'message',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'user said hello' },
            { type: 'text', text: 'Hello there!' },
          ],
          timestamp: 2000,
        },
      },
    ]);

    // Act
    const session = await new PiLogParser().parseSession(file);

    // Assert
    expect(session.messages).toHaveLength(2);
    const assistantMsg = session.messages[1];
    expect(assistantMsg?.type).toBe('assistant');
    expect(assistantMsg?.content).toBe('Hello there!');
    expect(assistantMsg?.thinkingContent).toBe('user said hello');
  });

  it('skips unrecognised line types gracefully', async () => {
    // Arrange
    const dir = createTempDir('pi-parser-skip-');
    const file = join(dir, 'session.jsonl');
    writeJsonl(file, [
      { type: 'session', version: 3, id: 'test-id', cwd: '/repo', timestamp: '2026-01-01T00:00:00.000Z' },
      { type: 'model_change', provider: 'anthropic', modelId: 'claude-opus' },
      { type: 'thinking_level_change', thinkingLevel: 'high' },
      {
        type: 'message',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'what is pi?', timestamp: 1000 },
      },
    ]);

    // Act
    const session = await new PiLogParser().parseSession(file);

    // Assert
    expect(session.title).toBe('what is pi?');
    expect(session.messages).toHaveLength(1);
  });
});

describe('PiLogParser — findSessionFile', () => {
  it('rejects a session file whose header cwd does not match the discovery root', async () => {
    // Arrange
    const sessionDir = await mkdtemp(join(tmpdir(), 'pi-find-cwd-'));
    tempDirs.push(sessionDir);
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    const projectRoot = resolve(join(tmpdir(), 'pi-project-root'));
    await createSessionFile(sessionDir, { id: 'other-proj', cwd: '/other/project', prompt: 'hello' });

    // Act
    const result = await new PiLogParser().findSessionFile(makePane(), projectRoot);

    // Assert
    expect(result).toBeNull();
  });

  it('picks the file whose header id matches pane.agentSessionId and skips others', async () => {
    // Arrange
    const sessionDir = await mkdtemp(join(tmpdir(), 'pi-find-id-'));
    tempDirs.push(sessionDir);
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    const projectRoot = await mkdtemp(join(tmpdir(), 'pi-proj-'));
    tempDirs.push(projectRoot);
    const wrongFile = await createSessionFile(sessionDir, {
      id: 'wrong-id',
      cwd: projectRoot,
      prompt: 'wrong',
      updatedAt: Date.now() + 10_000,
    });
    const rightFile = await createSessionFile(sessionDir, {
      id: 'right-id',
      cwd: projectRoot,
      prompt: 'right',
      updatedAt: Date.now(),
    });

    // Act
    const result = await new PiLogParser().findSessionFile(
      makePane({ agentSessionId: 'right-id' }),
      projectRoot,
    );

    // Assert
    expect(result).toBe(rightFile);
    expect(result).not.toBe(wrongFile);
  });

  it('honors excludePaths and skips the excluded file', async () => {
    // Arrange
    const sessionDir = await mkdtemp(join(tmpdir(), 'pi-find-excl-'));
    tempDirs.push(sessionDir);
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    const projectRoot = await mkdtemp(join(tmpdir(), 'pi-proj-excl-'));
    tempDirs.push(projectRoot);
    const excludedFile = await createSessionFile(sessionDir, {
      id: 'excluded',
      cwd: projectRoot,
      prompt: 'excluded',
      updatedAt: Date.now() + 5_000,
    });
    const keptFile = await createSessionFile(sessionDir, {
      id: 'kept',
      cwd: projectRoot,
      prompt: 'kept',
      updatedAt: Date.now(),
    });

    // Act
    const result = await new PiLogParser().findSessionFile(
      makePane(),
      projectRoot,
      new Set([excludedFile]),
    );

    // Assert
    expect(result).toBe(keptFile);
  });

  it('falls back to newest-by-mtime when paneTimestamp is null (legacy pane id)', async () => {
    // Arrange
    const sessionDir = await mkdtemp(join(tmpdir(), 'pi-find-mtime-'));
    tempDirs.push(sessionDir);
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    const projectRoot = await mkdtemp(join(tmpdir(), 'pi-proj-mtime-'));
    tempDirs.push(projectRoot);
    await createSessionFile(sessionDir, {
      id: 'older',
      cwd: projectRoot,
      prompt: 'older',
      updatedAt: 1_000,
    });
    const newerFile = await createSessionFile(sessionDir, {
      id: 'newer',
      cwd: projectRoot,
      prompt: 'newer',
      updatedAt: 2_000,
    });

    // Act — pane id 'muxbase-1' has no embedded timestamp so paneCreatedMsFromId returns null
    const result = await new PiLogParser().findSessionFile(makePane({ id: 'muxbase-1' }), projectRoot);

    // Assert
    expect(result).toBe(newerFile);
  });
});
