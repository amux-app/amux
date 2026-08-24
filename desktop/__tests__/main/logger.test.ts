import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import type { PathLike } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_LOG_DIR_BYTES, log } from '../../src/main/services/Logger';

vi.mock('electron', () => ({
  app: {},
}));

/**
 * Two app instances share one daily log file, so the failures worth testing all happen
 * inside a single synchronous flush. These faults reproduce them at the exact step the
 * second instance would interleave at.
 */
const fsFaults = vi.hoisted(() => ({
  rotationFault: null as { kind: 'stolen' | 'failed'; path: string } | null,
  failWrites: null as 'once' | 'always' | null,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();

  const renameSync = (from: PathLike, to: PathLike): void => {
    const fault = fsFaults.rotationFault;
    if (fault?.path === String(from)) {
      fsFaults.rotationFault = null;
      if (fault.kind === 'failed') throw new Error('simulated rotation failure');
      actual.renameSync(from, `${fault.path}.1`);
    }
    actual.renameSync(from, to);
  };

  const writeSync = (fd: number, data: string): number => {
    if (fsFaults.failWrites) {
      if (fsFaults.failWrites === 'once') fsFaults.failWrites = null;
      throw new Error('simulated write failure');
    }
    return actual.writeSync(fd, data);
  };

  return { ...actual, renameSync, writeSync };
});

const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 64 * 1024;
const OVERFLOW_PREFIX = 'overflow-';
const OVERFLOW_RECORDS = 2_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_LOG_PREFIX = 'aumx-desktop-';

let root: string | null = null;

function currentLogFile(): string {
  const logFile = log.getLogFile();
  if (!logFile) throw new Error('logger not initialized');
  return logFile;
}

function dailyLogPath(logDir: string, daysAgo: number): string {
  const date = new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
  return join(logDir, `${DAILY_LOG_PREFIX}${date}.log`);
}

/** Sparse so a directory over the 100MB cap costs no real disk. */
function writeSizedFile(path: string, bytes: number, mtimeSeconds: number): void {
  writeFileSync(path, '');
  truncateSync(path, bytes);
  utimesSync(path, mtimeSeconds, mtimeSeconds);
}

function totalDailyLogBytes(logDir: string): number {
  return readdirSync(logDir)
    .filter((fileName) => fileName.startsWith(DAILY_LOG_PREFIX))
    .reduce((sum, fileName) => sum + statSync(join(logDir, fileName)).size, 0);
}

function readMessages(): string[] {
  return readFileSync(currentLogFile(), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).msg);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fsFaults.rotationFault = null;
  fsFaults.failWrites = null;
  log.shutdown();
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
});

describe('DesktopLogger', () => {
  it('preserves existing log files when initialized', () => {
    // Arrange
    root = mkdtempSync(join(tmpdir(), 'aumx-logger-'));
    const logDir = join(root, '.log');
    mkdirSync(logDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(logDir, `aumx-desktop-${today}.log`);
    writeFileSync(logFile, '{"msg":"before restart"}\n');

    // Act
    log.initialize(root);

    // Assert
    expect(existsSync(logFile)).toBe(true);
    expect(readFileSync(logFile, 'utf8')).toContain('before restart');
  });

  it('exposes the current log file path after initialization', () => {
    // Arrange
    root = mkdtempSync(join(tmpdir(), 'aumx-logger-'));
    const today = new Date().toISOString().slice(0, 10);
    const expectedLogFile = join(root, '.log', `aumx-desktop-${today}.log`);

    // Act
    log.initialize(root);

    // Assert
    expect(log.getLogFile()).toBe(expectedLogFile);
  });

  it('rotates an oversized current log file before appending', () => {
    // Arrange
    root = mkdtempSync(join(tmpdir(), 'aumx-logger-'));
    const logDir = join(root, '.log');
    mkdirSync(logDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(logDir, `aumx-desktop-${today}.log`);
    writeFileSync(logFile, `${'x'.repeat(10 * 1024 * 1024 + 1)}oversized-before-rotate`);

    // Act
    log.initialize(root);

    // Assert
    expect(readFileSync(`${logFile}.1`, 'utf8')).toContain('oversized-before-rotate');
    const current = readFileSync(logFile, 'utf8');
    expect(current).toContain('Logger initialized');
    expect(current).not.toContain('oversized-before-rotate');
  });

  it('rotates on the on-disk size a second instance also appended to', () => {
    // Arrange
    root = mkdtempSync(join(tmpdir(), 'aumx-logger-'));
    log.initialize(root);
    const logFile = currentLogFile();

    // Act: a second app instance fills the shared daily file, then this one writes.
    appendFileSync(logFile, `${'x'.repeat(10 * 1024 * 1024)}other-instance-bytes`);
    log.error('test', 'after-shared-growth');

    // Assert
    expect(readFileSync(`${logFile}.1`, 'utf8')).toContain('other-instance-bytes');
    expect(readFileSync(logFile, 'utf8')).toContain('after-shared-growth');
  });

  it('follows the current daily log after another instance rotated it away', () => {
    // Arrange
    root = mkdtempSync(join(tmpdir(), 'aumx-logger-'));
    log.initialize(root);
    const logFile = currentLogFile();

    // Act: a second app instance rotates the file out from under this descriptor.
    renameSync(logFile, `${logFile}.1`);
    writeFileSync(logFile, '');
    log.error('test', 'after-external-rotate');

    // Assert
    expect(readFileSync(logFile, 'utf8')).toContain('after-external-rotate');
    expect(readFileSync(`${logFile}.1`, 'utf8')).not.toContain('after-external-rotate');
  });

  it('keeps writing after another instance wins the rotation race', () => {
    // Arrange
    root = mkdtempSync(join(tmpdir(), 'aumx-logger-'));
    log.initialize(root);
    const logFile = currentLogFile();
    appendFileSync(logFile, 'x'.repeat(MAX_LOG_FILE_BYTES));

    // Act: the other instance renames the shared file away first, so this rotation
    // finds nothing to rename and must recover instead of losing its descriptor.
    fsFaults.rotationFault = { kind: 'stolen', path: logFile };
    log.error('test', 'during-rotation-race');
    log.error('test', 'after-rotation-race');

    // Assert
    expect(fsFaults.rotationFault).toBeNull();
    const current = readFileSync(logFile, 'utf8');
    expect(current).toContain('during-rotation-race');
    expect(current).toContain('after-rotation-race');
    expect(readFileSync(`${logFile}.1`, 'utf8')).not.toContain('during-rotation-race');
  });

  it('keeps writing after a rotation fails outright', () => {
    // Arrange
    root = mkdtempSync(join(tmpdir(), 'aumx-logger-'));
    log.initialize(root);
    const logFile = currentLogFile();
    appendFileSync(logFile, 'x'.repeat(MAX_LOG_FILE_BYTES));

    // Act
    fsFaults.rotationFault = { kind: 'failed', path: logFile };
    log.error('test', 'during-failed-rotation');
    log.error('test', 'after-failed-rotation');

    // Assert
    const current = readFileSync(logFile, 'utf8');
    expect(current).toContain('during-failed-rotation');
    expect(current).toContain('after-failed-rotation');
  });

  it('retains buffered records when a write fails and emits them on the next flush', () => {
    // Arrange
    root = mkdtempSync(join(tmpdir(), 'aumx-logger-'));
    log.initialize(root);

    // Act
    fsFaults.failWrites = 'once';
    log.error('test', 'failed-write');
    const afterFailure = readMessages();
    log.error('test', 'later-write');

    // Assert
    expect(afterFailure).not.toContain('failed-write');
    expect(readMessages()).toEqual(['Logger initialized', 'failed-write', 'later-write']);
  });

  it('caps the retained buffer at the newest records while every write keeps failing', () => {
    // Arrange
    root = mkdtempSync(join(tmpdir(), 'aumx-logger-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    log.initialize(root);

    // Act
    fsFaults.failWrites = 'always';
    for (let index = 0; index < OVERFLOW_RECORDS; index += 1) {
      log.info('test', `${OVERFLOW_PREFIX}${index}`);
    }
    fsFaults.failWrites = null;
    log.error('test', 'recovered');

    // Assert: a full buffer's worth of the newest records survived, and no more
    const retained = readFileSync(currentLogFile(), 'utf8')
      .split('\n')
      .filter((line) => line.includes(`"${OVERFLOW_PREFIX}`));
    const retainedIndexes = retained.map((line) => Number(JSON.parse(line).msg.slice(OVERFLOW_PREFIX.length)));
    const retainedBytes = Buffer.byteLength(`${retained.join('\n')}\n`, 'utf8');

    expect(retainedBytes).toBeLessThanOrEqual(MAX_BUFFERED_BYTES);
    expect(retainedBytes).toBeGreaterThan(MAX_BUFFERED_BYTES / 2);
    expect(retainedIndexes.at(-1)).toBe(OVERFLOW_RECORDS - 1);
    expect(retainedIndexes).toEqual(
      Array.from({ length: retained.length }, (_, offset) => retainedIndexes[0] + offset),
    );
    expect(readMessages().at(-1)).toBe('recovered');
  });

  it('removes expired daily log files on initialize', () => {
    // Arrange
    root = mkdtempSync(join(tmpdir(), 'aumx-logger-'));
    const logDir = join(root, '.log');
    mkdirSync(logDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const currentLog = join(logDir, `aumx-desktop-${today}.log`);
    const expiredLog = join(logDir, 'aumx-desktop-2000-01-01.log');
    const expiredRotatedLog = `${expiredLog}.1`;
    const unrelatedFile = join(logDir, 'notes.txt');
    writeFileSync(currentLog, '{"msg":"current"}\n');
    writeFileSync(expiredLog, '{"msg":"expired"}\n');
    writeFileSync(expiredRotatedLog, '{"msg":"expired rotated"}\n');
    writeFileSync(unrelatedFile, 'keep me');

    // Act
    log.initialize(root);

    // Assert
    expect(existsSync(currentLog)).toBe(true);
    expect(existsSync(expiredLog)).toBe(false);
    expect(existsSync(expiredRotatedLog)).toBe(false);
    expect(existsSync(unrelatedFile)).toBe(true);
  });

  it('deletes the oldest daily logs when the directory exceeds the size cap', () => {
    // Arrange: unexpired logs that together overflow the cap, current log oldest by mtime
    root = mkdtempSync(join(tmpdir(), 'aumx-logger-'));
    const logDir = join(root, '.log');
    mkdirSync(logDir, { recursive: true });
    const currentLog = dailyLogPath(logDir, 0);
    const oldest = dailyLogPath(logDir, 3);
    const middle = dailyLogPath(logDir, 2);
    const newest = dailyLogPath(logDir, 1);
    writeSizedFile(currentLog, MAX_LOG_DIR_BYTES / 2 - 1024 * 1024, 1_000);
    writeSizedFile(oldest, MAX_LOG_DIR_BYTES / 4, 2_000);
    writeSizedFile(middle, MAX_LOG_DIR_BYTES / 4, 3_000);
    writeSizedFile(newest, MAX_LOG_DIR_BYTES / 4, 4_000);

    // Act
    log.initialize(root);

    // Assert
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(true);
    expect(existsSync(newest)).toBe(true);
    expect(existsSync(currentLog)).toBe(true);
    expect(totalDailyLogBytes(logDir)).toBeLessThanOrEqual(MAX_LOG_DIR_BYTES);
  });

  it('leaves unrelated files untouched while enforcing the size cap', () => {
    // Arrange: the unrelated file is both the largest and the oldest in the directory
    root = mkdtempSync(join(tmpdir(), 'aumx-logger-'));
    const logDir = join(root, '.log');
    mkdirSync(logDir, { recursive: true });
    const unrelatedFile = join(logDir, 'notes.txt');
    const oldest = dailyLogPath(logDir, 2);
    const newest = dailyLogPath(logDir, 1);
    writeSizedFile(unrelatedFile, MAX_LOG_DIR_BYTES, 1_000);
    writeSizedFile(oldest, MAX_LOG_DIR_BYTES / 2 + 1024, 2_000);
    writeSizedFile(newest, MAX_LOG_DIR_BYTES / 2 + 1024, 3_000);

    // Act
    log.initialize(root);

    // Assert
    expect(statSync(unrelatedFile).size).toBe(MAX_LOG_DIR_BYTES);
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(newest)).toBe(true);
  });

  it('buffers info records and flushes them on shutdown', () => {
    // Arrange
    root = mkdtempSync(join(tmpdir(), 'aumx-logger-'));
    log.initialize(root);

    // Act
    log.info('test', 'buffered-one');
    log.info('test', 'buffered-two');

    // Assert
    expect(readMessages()).not.toContain('buffered-one');
    const logFile = currentLogFile();
    log.shutdown();
    const flushed = readFileSync(logFile, 'utf8');
    expect(flushed).toContain('buffered-one');
    expect(flushed).toContain('buffered-two');
  });

  it('flushes error records immediately without dropping earlier buffered records', () => {
    // Arrange
    root = mkdtempSync(join(tmpdir(), 'aumx-logger-'));
    log.initialize(root);

    // Act
    log.info('test', 'before-error');
    log.error('test', 'boom');
    log.info('test', 'after-error');

    // Assert
    const messages = readMessages();
    expect(messages).toContain('before-error');
    expect(messages).toContain('boom');
    expect(messages).not.toContain('after-error');
  });

  it('preserves record order across buffered and immediate flushes', () => {
    // Arrange
    root = mkdtempSync(join(tmpdir(), 'aumx-logger-'));
    log.initialize(root);

    // Act
    const logFile = currentLogFile();
    log.info('test', 'first');
    log.info('test', 'second');
    log.error('test', 'third');
    log.info('test', 'fourth');
    log.shutdown();

    // Assert
    const messages = readFileSync(logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line).msg);
    expect(messages).toEqual([
      'Logger initialized',
      'first',
      'second',
      'third',
      'fourth',
      'Logger shutting down',
    ]);
  });

  it('flushes buffered records from the process exit hook', () => {
    // Arrange
    root = mkdtempSync(join(tmpdir(), 'aumx-logger-'));
    const before = new Set(process.listeners('exit'));

    // Act
    log.initialize(root);
    log.info('test', 'pending-on-exit');
    const added = process.listeners('exit').filter((listener) => !before.has(listener));

    // Assert
    expect(added).toHaveLength(1);
    expect(readMessages()).not.toContain('pending-on-exit');
    (added[0] as () => void)();
    expect(readMessages()).toContain('pending-on-exit');
  });

  it('coalesces repeated throttled records and reports the suppressed count', () => {
    // Arrange
    root = mkdtempSync(join(tmpdir(), 'aumx-logger-'));
    vi.useFakeTimers({ toFake: ['Date'] });
    log.initialize(root);

    // Act
    const logFile = currentLogFile();
    for (let index = 0; index < 5; index += 1) {
      log.infoThrottled('test', 'repeating');
    }
    vi.advanceTimersByTime(6000);
    log.infoThrottled('test', 'repeating');
    log.shutdown();

    // Assert
    const repeated = readFileSync(logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.msg === 'repeating');
    expect(repeated).toHaveLength(2);
    expect(repeated[0].suppressed).toBeUndefined();
    expect(repeated[1].suppressed).toBe(4);
  });
});
