import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeLogParser } from '../../src/main/services/parsing/ClaudeLogParser';
import { claudeSessionAccumulator } from '../../src/main/services/parsing/ClaudeSessionAccumulator';
import { createIncrementalJsonlParser } from '../../src/main/services/parsing/incrementalSessionParse';
import { fileFingerprint } from '../../src/main/services/parsing/session-files';
import { SessionParseCache } from '../../src/main/services/parsing/SessionParseCache';
import type { NormalizedSession } from '../../src/shared/agent-session-types';
import { createEmptySession } from '../../src/shared/agent-session-types';

const FIXED_MTIME = new Date(1_778_686_270_000);
const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJsonl(filePath: string, lines: Array<Record<string, unknown>>): void {
  writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
}

function claudeFixture(): Array<Record<string, unknown>> {
  return [
    {
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-07-26T10:00:00.000Z',
      message: { role: 'user', content: 'Add caching to the log parsers' },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-07-26T10:00:05.000Z',
      message: {
        id: 'msg_1',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: { description: 'inspect parsers' } }],
        usage: { input_tokens: 12, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 30 },
        stop_reason: 'tool_use',
      },
    },
    {
      type: 'user',
      uuid: 's1',
      isSidechain: true,
      timestamp: '2026-07-26T10:00:06.000Z',
      message: { role: 'user', content: 'inspect parsers' },
    },
    { type: 'ai-title', uuid: 't1', timestamp: '2026-07-26T10:00:07.000Z', aiTitle: 'Parser cache work' },
    {
      type: 'assistant',
      uuid: 'a2',
      timestamp: '2026-07-26T10:00:08.000Z',
      message: {
        id: 'msg_2',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'Done.' }],
        usage: { input_tokens: 3, output_tokens: 11 },
        stop_reason: 'end_turn',
      },
    },
  ];
}

interface CountingParser {
  parse: (filePath: string, key?: string) => Promise<NormalizedSession>;
  readonly calls: () => number;
}

function countingParser(cache: SessionParseCache): CountingParser {
  let calls = 0;
  return {
    calls: () => calls,
    parse: (filePath: string, key?: string) =>
      cache.read({ filePath, fingerprint: fileFingerprint(filePath), key }, async () => {
        calls += 1;
        const session = createEmptySession('claude', `parse-${calls}`);
        session.title = statSync(filePath).size.toString();
        return { session };
      }),
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('SessionParseCache', () => {
  it('returns the memoized session without invoking the parser when the file identity is unchanged', async () => {
    // Arrange
    const dir = createTempDir('aumx-parse-cache-hit-');
    const filePath = join(dir, 'session.jsonl');
    writeFileSync(filePath, 'line one\n');
    const parser = countingParser(new SessionParseCache());

    // Act
    const first = await parser.parse(filePath);
    const second = await parser.parse(filePath);

    // Assert
    expect(parser.calls()).toBe(1);
    expect(second).toBe(first);
  });

  it('re-parses when only the size changed', async () => {
    // Arrange
    const dir = createTempDir('aumx-parse-cache-size-');
    const filePath = join(dir, 'session.jsonl');
    writeFileSync(filePath, 'line one\n');
    utimesSync(filePath, FIXED_MTIME, FIXED_MTIME);
    const parser = countingParser(new SessionParseCache());
    await parser.parse(filePath);

    // Act: append, then restore the original mtime so size is the only difference.
    appendFileSync(filePath, 'line two\n');
    utimesSync(filePath, FIXED_MTIME, FIXED_MTIME);
    const session = await parser.parse(filePath);

    // Assert
    expect(parser.calls()).toBe(2);
    expect(session.title).toBe('18');
  });

  it('re-parses when only the mtime changed', async () => {
    // Arrange
    const dir = createTempDir('aumx-parse-cache-mtime-');
    const filePath = join(dir, 'session.jsonl');
    writeFileSync(filePath, 'line one\n');
    utimesSync(filePath, FIXED_MTIME, FIXED_MTIME);
    const parser = countingParser(new SessionParseCache());
    await parser.parse(filePath);

    // Act
    const laterMtime = new Date(FIXED_MTIME.getTime() + 5_000);
    utimesSync(filePath, laterMtime, laterMtime);
    await parser.parse(filePath);

    // Assert
    expect(parser.calls()).toBe(2);
  });

  it('re-parses when the file was replaced at the same path, size and mtime', async () => {
    // Arrange
    const dir = createTempDir('aumx-parse-cache-ino-');
    const filePath = join(dir, 'session.jsonl');
    writeFileSync(filePath, 'line one\n');
    utimesSync(filePath, FIXED_MTIME, FIXED_MTIME);
    const parser = countingParser(new SessionParseCache());
    await parser.parse(filePath);
    const originalIno = statSync(filePath).ino;

    // Act: build the replacement while the original inode is still allocated,
    // then publish it atomically at the same path.
    const replacementPath = join(dir, 'replacement.jsonl');
    writeFileSync(replacementPath, 'line ONE\n');
    utimesSync(replacementPath, FIXED_MTIME, FIXED_MTIME);
    renameSync(replacementPath, filePath);

    // Assert
    expect(statSync(filePath).ino).not.toBe(originalIno);
    expect(statSync(filePath).size).toBe(9);
    expect(statSync(filePath).mtimeMs).toBe(FIXED_MTIME.getTime());
    await parser.parse(filePath);
    expect(parser.calls()).toBe(2);
  });

  it('re-parses an in-place rewrite with the same inode, size and mtime', async () => {
    // Arrange
    const dir = createTempDir('aumx-parse-cache-ctime-');
    const filePath = join(dir, 'session.jsonl');
    writeFileSync(filePath, 'line one\n');
    utimesSync(filePath, FIXED_MTIME, FIXED_MTIME);
    const parser = countingParser(new SessionParseCache());
    await parser.parse(filePath);
    const original = statSync(filePath);

    // Act: rewrite the bytes in place and restore mtime. ctime is the only
    // remaining stat-level signal that the cached content is stale.
    writeFileSync(filePath, 'line TWO\n');
    utimesSync(filePath, FIXED_MTIME, FIXED_MTIME);
    const rewritten = statSync(filePath);
    await parser.parse(filePath);

    // Assert
    expect(rewritten.ino).toBe(original.ino);
    expect(rewritten.size).toBe(original.size);
    expect(rewritten.mtimeMs).toBe(original.mtimeMs);
    expect(parser.calls()).toBe(2);
  });

  it('serves fresh content for an appended file instead of a stale session', async () => {
    // Arrange
    const dir = createTempDir('aumx-parse-cache-floor-');
    const filePath = join(dir, 'session.jsonl');
    writeFileSync(filePath, 'line one\n');
    const parser = countingParser(new SessionParseCache());
    await parser.parse(filePath);

    // Act
    appendFileSync(filePath, 'line two\n');
    const session = await parser.parse(filePath);

    // Assert
    expect(parser.calls()).toBe(2);
    expect(session.title).toBe('18');
  });

  it('keeps parses of one file apart when the callers use different keys', async () => {
    // Arrange: two panes read the same OpenCode database bound to different sessions.
    const dir = createTempDir('aumx-parse-cache-key-');
    const filePath = join(dir, 'shared.db');
    writeFileSync(filePath, 'line one\n');
    const parser = countingParser(new SessionParseCache());

    // Act
    const first = await parser.parse(filePath, `${filePath}#session-a`);
    const second = await parser.parse(filePath, `${filePath}#session-b`);
    const firstAgain = await parser.parse(filePath, `${filePath}#session-a`);

    // Assert
    expect(parser.calls()).toBe(2);
    expect(second).not.toBe(first);
    expect(firstAgain).toBe(first);
  });

  it('bounds retained entries to maxEntries', async () => {
    // Arrange
    const dir = createTempDir('aumx-parse-cache-bound-');
    const paths = ['a', 'b', 'c'].map((name) => join(dir, `${name}.jsonl`));
    for (const path of paths) writeFileSync(path, 'line one\n');
    const parser = countingParser(new SessionParseCache(2));

    // Act
    for (const path of paths) await parser.parse(path);
    await parser.parse(paths[2]);
    await parser.parse(paths[0]);

    // Assert: c is still cached, a was evicted by c.
    expect(parser.calls()).toBe(4);
  });

  it('drops the entry for a removed file', async () => {
    // Arrange
    const dir = createTempDir('aumx-parse-cache-removed-');
    const filePath = join(dir, 'session.jsonl');
    writeFileSync(filePath, 'line one\n');
    const parser = countingParser(new SessionParseCache());
    await parser.parse(filePath);

    // Act
    unlinkSync(filePath);
    await expect(parser.parse(filePath)).rejects.toThrow();
    writeFileSync(filePath, 'line one\n');
    utimesSync(filePath, FIXED_MTIME, FIXED_MTIME);
    await parser.parse(filePath);

    // Assert: the missing-file read still called the parser, and so did the recreated one.
    expect(parser.calls()).toBe(3);
  });
});

describe('ClaudeLogParser parse memoization', () => {
  it('produces output identical to an uncached parse and reuses it for an unchanged file', async () => {
    // Arrange
    const dir = createTempDir('aumx-claude-cache-');
    const filePath = join(dir, 'cached-session.jsonl');
    writeJsonl(filePath, claudeFixture());
    const cachedParser = new ClaudeLogParser();
    const parseUncached = createIncrementalJsonlParser(claudeSessionAccumulator);

    // Act
    const first = await cachedParser.parseSession(filePath);
    const second = await cachedParser.parseSession(filePath);
    const { session: uncached } = await parseUncached({ filePath, previous: null });

    // Assert
    expect(second).toBe(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(uncached));
    expect(second.messages).toHaveLength(3);
    expect(second.title).toBe('Parser cache work');
    expect(second.subagents?.[0]?.messages).toHaveLength(1);
    expect(second.metrics.totalTokens).toBe(996);
  });

  it('reflects appended entries on the next parse', async () => {
    // Arrange
    const dir = createTempDir('aumx-claude-cache-append-');
    const filePath = join(dir, 'growing-session.jsonl');
    writeJsonl(filePath, claudeFixture());
    const parser = new ClaudeLogParser();
    const before = await parser.parseSession(filePath);

    // Act
    appendFileSync(
      filePath,
      `${JSON.stringify({
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-07-26T10:01:00.000Z',
        message: { role: 'user', content: 'One more thing' },
      })}\n`,
    );
    const after = await parser.parseSession(filePath);

    // Assert
    expect(before.messages).toHaveLength(3);
    expect(after.messages).toHaveLength(4);
    expect(after.messages.at(-1)?.content).toBe('One more thing');
  });
});
