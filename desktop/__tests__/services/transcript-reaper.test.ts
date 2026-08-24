import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reapOrphanTranscripts, TRANSCRIPT_RETENTION_MS } from '../../src/main/services/transcript-reaper';

const NOW = new Date('2026-07-12T00:00:00.000Z').getTime();
const OLD = NOW - TRANSCRIPT_RETENTION_MS - 60_000;
const RECENT = NOW - 60_000;

let dir: string | null = null;

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

function writeTranscript(terminalDir: string, name: string, mtimeMs: number): string {
  const path = join(terminalDir, name);
  writeFileSync(path, 'transcript');
  const seconds = mtimeMs / 1000;
  utimesSync(path, seconds, seconds);
  return path;
}

describe('reapOrphanTranscripts', () => {
  it('runs cleanup asynchronously so large transcript directories do not block startup', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aumx-reaper-'));

    const cleanup = reapOrphanTranscripts(dir, new Set(), NOW, TRANSCRIPT_RETENTION_MS);

    expect(cleanup).toBeInstanceOf(Promise);
    await expect(cleanup).resolves.toBe(0);
  });

  it('deletes an orphaned transcript older than the retention cutoff', async () => {
    // Arrange
    dir = mkdtempSync(join(tmpdir(), 'aumx-reaper-'));
    const orphan = writeTranscript(dir, 'tmux-1-claude.ansi', OLD);

    // Act
    const deleted = await reapOrphanTranscripts(dir, new Set(), NOW, TRANSCRIPT_RETENTION_MS);

    // Assert
    expect(deleted).toBe(1);
    expect(existsSync(orphan)).toBe(false);
  });

  it('keeps an orphaned transcript that is still within the retention window', async () => {
    // Arrange
    dir = mkdtempSync(join(tmpdir(), 'aumx-reaper-'));
    const recent = writeTranscript(dir, 'tmux-2-codex.ansi', RECENT);

    // Act
    const deleted = await reapOrphanTranscripts(dir, new Set(), NOW, TRANSCRIPT_RETENTION_MS);

    // Assert
    expect(deleted).toBe(0);
    expect(existsSync(recent)).toBe(true);
  });

  it('keeps an old transcript that a live pane still references', async () => {
    // Arrange
    dir = mkdtempSync(join(tmpdir(), 'aumx-reaper-'));
    const live = writeTranscript(dir, 'tmux-3-claude.ansi', OLD);

    // Act
    const deleted = await reapOrphanTranscripts(dir, new Set([live]), NOW, TRANSCRIPT_RETENTION_MS);

    // Assert
    expect(deleted).toBe(0);
    expect(existsSync(live)).toBe(true);
  });

  it('ignores non-.ansi files', async () => {
    // Arrange
    dir = mkdtempSync(join(tmpdir(), 'aumx-reaper-'));
    const other = writeTranscript(dir, 'aumx-desktop-2026-06-01.log', OLD);

    // Act
    const deleted = await reapOrphanTranscripts(dir, new Set(), NOW, TRANSCRIPT_RETENTION_MS);

    // Assert
    expect(deleted).toBe(0);
    expect(existsSync(other)).toBe(true);
  });

  it('returns 0 without throwing when the directory is missing', async () => {
    // Arrange
    dir = mkdtempSync(join(tmpdir(), 'aumx-reaper-'));
    const missing = join(dir, 'does-not-exist');

    // Act
    const deleted = await reapOrphanTranscripts(missing, new Set(), NOW, TRANSCRIPT_RETENTION_MS);

    // Assert
    expect(deleted).toBe(0);
  });
});
