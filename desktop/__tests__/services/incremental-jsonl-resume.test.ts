import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_FIXTURE_LINES,
  claudeScenario,
} from './incremental-jsonl-harness';

const HEAD_PADDING_BYTES = 6 * 1024;
const MIDDLE_PADDING_BYTES = 6 * 1024;
const STREAM_PRELOADED_BYTES = 1024 * 1024;
const STREAM_APPENDS = 12;
const FIXED_MTIME = new Date(1_778_686_270_000);
const tempDirs: string[] = [];

function createTempFile(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return join(dir, 'session.jsonl');
}

function paddingLines(tag: string, minBytes: number): string[] {
  const lines: string[] = [];
  let bytes = 0;
  for (let index = 0; bytes < minBytes; index++) {
    const line = JSON.stringify({
      type: 'user',
      uuid: `${tag}-${index}`,
      timestamp: new Date(Date.UTC(2026, 6, 26, 9, 0, index)).toISOString(),
      message: { role: 'user', content: `${tag} filler record ${index} ${'x'.repeat(60)}` },
    });
    lines.push(line);
    bytes += Buffer.byteLength(line, 'utf8') + 1;
  }
  return lines;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('incremental JSONL resume safety', () => {
  it('holds back a trailing partial record until it is fully written', async () => {
    // Arrange: cut the final record in half, mid JSON object.
    const scenario = claudeScenario();
    const filePath = createTempFile('muxbase-resume-partial-');
    const referencePath = createTempFile('muxbase-resume-partial-ref-');
    const lastRecordStart = scenario.content.lastIndexOf('\n', scenario.content.length - 2) + 1;
    const cut = lastRecordStart + Math.floor((scenario.content.length - lastRecordStart) / 2);
    const feeder = scenario.createFeeder(filePath);

    // Act
    writeFileSync(filePath, scenario.content.subarray(0, cut));
    const partial = await feeder.parse();
    writeFileSync(filePath, scenario.content);
    const completed = await feeder.parse();

    // Assert
    writeFileSync(referencePath, scenario.content.subarray(0, lastRecordStart));
    expect(partial).toEqual(await scenario.parseOnce(referencePath));
    expect(partial.awaitingUserInput).toBe(false);
    expect(completed).toEqual(await scenario.parseFull(referencePath));
    expect(completed.awaitingUserInput).toBe(true);
  });

  it('consumes a complete final record that has no trailing newline yet', async () => {
    // Arrange
    const scenario = claudeScenario();
    const filePath = createTempFile('muxbase-resume-noeol-');
    const referencePath = createTempFile('muxbase-resume-noeol-ref-');
    const withoutNewline = scenario.content.subarray(0, scenario.content.length - 1);
    const feeder = scenario.createFeeder(filePath);

    // Act
    writeFileSync(filePath, withoutNewline);
    const unterminated = await feeder.parse();
    appendFileSync(filePath, '\n');
    const terminated = await feeder.parse();

    // Assert
    writeFileSync(referencePath, withoutNewline);
    expect(unterminated).toEqual(await scenario.parseOnce(referencePath));
    expect(unterminated.awaitingUserInput).toBe(true);
    expect(terminated).toEqual(await scenario.parseFull(referencePath));
  });

  it('reparses from scratch after the file is truncated', async () => {
    // Arrange
    const scenario = claudeScenario();
    const filePath = createTempFile('muxbase-resume-truncate-');
    const referencePath = createTempFile('muxbase-resume-truncate-ref-');
    const keep = scenario.content.indexOf('\n', Math.floor(scenario.content.length / 2)) + 1;
    const feeder = scenario.createFeeder(filePath);

    // Act
    writeFileSync(filePath, scenario.content);
    await feeder.parse();
    writeFileSync(filePath, scenario.content.subarray(0, keep));
    const afterTruncation = await feeder.parse();

    // Assert
    writeFileSync(referencePath, scenario.content.subarray(0, keep));
    expect(afterTruncation).toEqual(await scenario.parseOnce(referencePath));
  });

  it('reparses from scratch after a compact-style in-place rewrite that keeps the head and grows the file', async () => {
    // Arrange: identical first 6 KiB, different tail, larger total size — only a
    // content hash of the consumed bytes can tell these two files apart.
    const head = paddingLines('head', HEAD_PADDING_BYTES);
    const before = claudeScenario([...head, ...paddingLines('original-tail', 1024)]);
    const after = claudeScenario([...head, ...CLAUDE_FIXTURE_LINES]);
    const filePath = createTempFile('muxbase-resume-compact-');
    const referencePath = createTempFile('muxbase-resume-compact-ref-');
    const feeder = before.createFeeder(filePath);

    // Act
    writeFileSync(filePath, before.content);
    const originalIno = statSync(filePath).ino;
    await feeder.parse();
    writeFileSync(filePath, after.content);
    const rewritten = await feeder.parse();

    // Assert
    expect(statSync(filePath).ino).toBe(originalIno);
    expect(statSync(filePath).size).toBeGreaterThan(before.content.length);
    expect(rewritten).toEqual(await after.parseFull(referencePath));
  });

  it('reparses from scratch when the bytes just before the resume point are rewritten at the same size', async () => {
    // Arrange: same inode, same size, identical head, record boundary intact —
    // the hash of the bytes ending at the resume point is the only signal left.
    const head = paddingLines('head', HEAD_PADDING_BYTES);
    const middle = paddingLines('middle', MIDDLE_PADDING_BYTES);
    const before = claudeScenario([...head, ...middle, ...paddingLines('tail-a', HEAD_PADDING_BYTES)]);
    const after = claudeScenario([...head, ...middle, ...paddingLines('tail-b', HEAD_PADDING_BYTES)]);
    const filePath = createTempFile('muxbase-resume-tailhash-');
    const referencePath = createTempFile('muxbase-resume-tailhash-ref-');
    const feeder = before.createFeeder(filePath);

    // Act
    writeFileSync(filePath, before.content);
    const originalIno = statSync(filePath).ino;
    await feeder.parse();
    writeFileSync(filePath, after.content);
    const rewritten = await feeder.parse();

    // Assert
    expect(before.content.length).toBe(after.content.length);
    expect(statSync(filePath).ino).toBe(originalIno);
    expect(rewritten).toEqual(await after.parseFull(referencePath));
  });

  it('reparses from scratch when only the head of the file is rewritten at the same size', async () => {
    // Arrange: same inode, same size, identical bytes before the resume point —
    // the hash of the file head is the only signal left.
    const tail = paddingLines('tail', HEAD_PADDING_BYTES);
    const before = claudeScenario([...paddingLines('head-a', HEAD_PADDING_BYTES), ...tail]);
    const after = claudeScenario([...paddingLines('head-b', HEAD_PADDING_BYTES), ...tail]);
    const filePath = createTempFile('muxbase-resume-headhash-');
    const referencePath = createTempFile('muxbase-resume-headhash-ref-');
    const feeder = before.createFeeder(filePath);

    // Act
    writeFileSync(filePath, before.content);
    await feeder.parse();
    writeFileSync(filePath, after.content);
    const rewritten = await feeder.parse();

    // Assert
    expect(before.content.length).toBe(after.content.length);
    expect(rewritten).toEqual(await after.parseFull(referencePath));
  });

  it('reparses a same-inode and same-size rewrite confined to the unsampled middle', async () => {
    // Arrange: head and tail samples are byte-identical and mtime is restored,
    // so ctime is the only signal that the consumed middle was rewritten.
    const head = paddingLines('head', HEAD_PADDING_BYTES);
    const tail = paddingLines('tail', HEAD_PADDING_BYTES);
    const before = claudeScenario([...head, ...paddingLines('middle-a', MIDDLE_PADDING_BYTES), ...tail]);
    const after = claudeScenario([...head, ...paddingLines('middle-b', MIDDLE_PADDING_BYTES), ...tail]);
    const filePath = createTempFile('muxbase-resume-ctime-');
    const referencePath = createTempFile('muxbase-resume-ctime-ref-');
    const feeder = before.createFeeder(filePath);
    writeFileSync(filePath, before.content);
    utimesSync(filePath, FIXED_MTIME, FIXED_MTIME);
    const original = statSync(filePath);
    await feeder.parse();

    // Act
    writeFileSync(filePath, after.content);
    utimesSync(filePath, FIXED_MTIME, FIXED_MTIME);
    const rewritten = statSync(filePath);
    const session = await feeder.parse();

    // Assert
    expect(rewritten.ino).toBe(original.ino);
    expect(rewritten.size).toBe(original.size);
    expect(rewritten.mtimeMs).toBe(original.mtimeMs);
    expect(session).toEqual(await after.parseFull(referencePath));
  });

  it('reparses from scratch when the path is replaced by a new inode with the same size, head and tail', async () => {
    // Arrange: only the middle differs, so size, head hash and boundary hash all
    // still match the checkpoint — the inode is the sole remaining signal.
    const head = paddingLines('head', HEAD_PADDING_BYTES);
    const tail = paddingLines('tail', HEAD_PADDING_BYTES);
    const before = claudeScenario([...head, ...paddingLines('middle-a', MIDDLE_PADDING_BYTES), ...tail]);
    const after = claudeScenario([...head, ...paddingLines('middle-b', MIDDLE_PADDING_BYTES), ...tail]);
    const filePath = createTempFile('muxbase-resume-inode-');
    const referencePath = createTempFile('muxbase-resume-inode-ref-');
    const feeder = before.createFeeder(filePath);

    // Act
    writeFileSync(filePath, before.content);
    const originalIno = statSync(filePath).ino;
    await feeder.parse();
    const replacementPath = `${filePath}.replacement`;
    writeFileSync(replacementPath, after.content);
    renameSync(replacementPath, filePath);
    const replaced = await feeder.parse();

    // Assert
    expect(before.content.length).toBe(after.content.length);
    expect(statSync(filePath).ino).not.toBe(originalIno);
    expect(replaced).toEqual(await after.parseFull(referencePath));
  });
});

interface CountedRead {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
}

async function measureBytesRead(filePath: string, run: () => Promise<void>): Promise<number> {
  const handle = await open(filePath, 'r');
  const prototype = Object.getPrototypeOf(handle) as CountedRead;
  await handle.close();

  const original = prototype.read;
  let bytes = 0;
  prototype.read = async function counted(this: CountedRead, buffer, offset, length, position) {
    const result = await original.call(this, buffer, offset, length, position);
    bytes += result.bytesRead;
    return result;
  };

  try {
    await run();
  } finally {
    prototype.read = original;
  }
  return bytes;
}

describe('incremental JSONL streaming cost', () => {
  it('reads a small fraction of the bytes a full reparse per append would read', async () => {
    // Arrange
    const scenario = claudeScenario(paddingLines('base', STREAM_PRELOADED_BYTES));
    const appended = paddingLines('appended', STREAM_APPENDS * 200).slice(0, STREAM_APPENDS);
    const incrementalPath = createTempFile('muxbase-stream-incremental-');
    const fullPath = createTempFile('muxbase-stream-full-');
    writeFileSync(incrementalPath, scenario.content);
    writeFileSync(fullPath, scenario.content);

    const feeder = scenario.createFeeder(incrementalPath);
    await feeder.parse();

    // Act
    const incrementalBytes = await measureBytesRead(incrementalPath, async () => {
      for (const line of appended) {
        appendFileSync(incrementalPath, `${line}\n`);
        await feeder.parse();
      }
    });
    const fullBytes = await measureBytesRead(fullPath, async () => {
      for (const line of appended) {
        appendFileSync(fullPath, `${line}\n`);
        await scenario.parseOnce(fullPath);
      }
    });

    // Assert
    const finalSize = statSync(incrementalPath).size;
    expect(finalSize).toBe(statSync(fullPath).size);
    expect(fullBytes).toBeGreaterThan(finalSize * STREAM_APPENDS * 0.8);
    expect(incrementalBytes).toBeLessThan(fullBytes * 0.05);
  });
});
