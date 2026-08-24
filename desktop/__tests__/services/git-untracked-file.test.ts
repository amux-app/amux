import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../../src/main/services/Logger';
import { collectWorkingTreeDiffFromStatus } from '../../src/main/services/git/gitDiffCollector';
import {
  MAX_UNTRACKED_SCAN_FILES,
  readUntrackedFileContent,
  selectScannableUntracked,
  UntrackedScanCache,
} from '../../src/main/services/git/gitUntrackedFile';
import type { ParsedStatusEntry } from '../../src/main/services/git/gitDiffParser';

const OVERSIZED_BYTES = 300 * 1024;
const FIXED_MTIME_SECONDS = 1_700_000_000;
const SCANNED_FILE = 'file.txt';

describe('untracked file content', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aumx-untracked-'));
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it.each([
    ['trailing newline', 'a\nb\nc\n', 3],
    ['no trailing newline', 'a\nb\nc', 3],
    ['single blank line', '\n', 1],
    ['empty file', '', 0],
    ['crlf endings', 'a\r\nb\r\n', 2],
  ])('counts %s identically with and without patch generation', async (_label, content, expected) => {
    // Arrange
    writeFileSync(join(dir, 'file.txt'), content);

    // Act
    const summary = await readUntrackedFileContent(dir, 'file.txt', false);
    const withPatch = await readUntrackedFileContent(dir, 'file.txt', true);

    // Assert
    expect(summary.additions).toBe(expected);
    expect(withPatch.additions).toBe(expected);
    expect(summary.patch).toBeUndefined();
  });

  it('counts an oversized file without emitting a patch', async () => {
    // Arrange: 300 KB of one-character lines exceeds the inline patch budget.
    const lines = OVERSIZED_BYTES / 2;
    writeFileSync(join(dir, 'big.txt'), 'x\n'.repeat(lines));

    // Act
    const content = await readUntrackedFileContent(dir, 'big.txt', true);

    // Assert
    expect(content.additions).toBe(lines);
    expect(content.tooLarge).toBe(true);
    expect(content.patch).toBeUndefined();
  });

  it('detects a binary file on both the summary and the patch path', async () => {
    // Arrange
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0x41, 0x00, 0x42, 0x0a]));

    // Act
    const summary = await readUntrackedFileContent(dir, 'blob.bin', false);
    const withPatch = await readUntrackedFileContent(dir, 'blob.bin', true);

    // Assert
    expect(summary.isBinary).toBe(true);
    expect(summary.additions).toBe(0);
    expect(withPatch.isBinary).toBe(true);
    expect(withPatch.patch).toContain('Binary files /dev/null and b/blob.bin differ');
  });

  it('returns no content for a path that is not a file', async () => {
    // Act
    const content = await readUntrackedFileContent(dir, 'missing.txt', true);

    // Assert
    expect(content).toEqual({ additions: 0, isBinary: false });
  });

  it('caps how many untracked files a single collection may open', () => {
    // Arrange
    const entries = Array.from({ length: 2500 }, (_, index) => untracked(`file-${index}.txt`));

    // Act
    const scannable = selectScannableUntracked(entries);

    // Assert
    expect(scannable.size).toBe(2000);
    expect(scannable.has('file-0.txt')).toBe(true);
    expect(scannable.has('file-2499.txt')).toBe(false);
  });

  it('reports an untracked file past the scan cap as an omitted preview', async () => {
    // Arrange: every file holds one line, and one of them sits past the cap.
    const entries = Array.from({ length: 2001 }, (_, index) => {
      const path = `file-${String(index).padStart(4, '0')}.txt`;
      writeFileSync(join(dir, path), 'a\n');
      return untracked(path);
    });

    // Act
    const collected = await collectWorkingTreeDiffFromStatus(dir, entries, false, true, true);

    // Assert
    const scanned = collected.files.filter((file) => file.additions === 1);
    const skipped = collected.files.filter((file) => file.tooLarge);
    expect(scanned).toHaveLength(2000);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.additions).toBe(0);
    expect(skipped[0]?.patch).toBeUndefined();
  }, 15_000);

  it('reports the scan cap once per capped stretch rather than once per refresh', () => {
    // Arrange: one worktree polling a capped repository, dropping below the cap
    // and coming back.
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const cache = new UntrackedScanCache();
    const capped = Array.from({ length: MAX_UNTRACKED_SCAN_FILES + 1 }, (_, index) => untracked(`file-${index}.txt`));

    // Act
    selectScannableUntracked(capped, cache);
    selectScannableUntracked(capped, cache);
    selectScannableUntracked([untracked('one.txt')], cache);
    selectScannableUntracked(capped, cache);

    // Assert: the refresh that entered the capped state reports, the repeats do not.
    expect(warn).toHaveBeenCalledTimes(2);

    warn.mockRestore();
  });

  it('answers a repeat read from the memo while the stat is unchanged', async () => {
    // Arrange: the count a refresh took for a file it stat-ed once.
    const path = join(dir, SCANNED_FILE);
    writeFileSync(path, 'a\nb\nc\n');
    const cache = new UntrackedScanCache();
    const unchanged = statSync(path);
    const first = await cache.read(dir, SCANNED_FILE, false, unchanged);

    // Act: the file's content moves, but the caller presents the same stat.
    writeFileSync(path, 'x\n');
    const second = await cache.read(dir, SCANNED_FILE, false, unchanged);

    // Assert: the second read never opened the file.
    expect(first.additions).toBe(3);
    expect(second.additions).toBe(3);
  });

  it('recounts a file rewritten in place at the same size and mtime', async () => {
    // Arrange: a rewrite that only the change time records.
    const path = join(dir, SCANNED_FILE);
    writeFileSync(path, 'a\nb\nc\n');
    utimesSync(path, FIXED_MTIME_SECONDS, FIXED_MTIME_SECONDS);
    const cache = new UntrackedScanCache();
    const before = statSync(path);
    const first = await cache.read(dir, SCANNED_FILE, false, before);

    // Act
    writeFileSync(path, 'abcde\n');
    utimesSync(path, FIXED_MTIME_SECONDS, FIXED_MTIME_SECONDS);
    const after = statSync(path);
    const second = await cache.read(dir, SCANNED_FILE, false, after);

    // Assert: inode, size and mtime all held, so only the change time could
    // have told the memo to read the file again.
    expect([after.ino, after.size, after.mtimeMs]).toEqual([before.ino, before.size, before.mtimeMs]);
    expect(first.additions).toBe(3);
    expect(second.additions).toBe(1);
  });

  it('leaves tracked entries out of the scannable set', () => {
    // Arrange
    const entries: ParsedStatusEntry[] = [untracked('new.txt'), modified('old.txt')];

    // Act
    const scannable = selectScannableUntracked(entries);

    // Assert
    expect([...scannable]).toEqual(['new.txt']);
  });
});

function untracked(path: string): ParsedStatusEntry {
  return { path, staged: false, status: 'untracked', unstaged: true };
}

function modified(path: string): ParsedStatusEntry {
  return { path, staged: false, status: 'modified', unstaged: true };
}
