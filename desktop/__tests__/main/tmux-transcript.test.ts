import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupTmuxTranscript, startTmuxTranscript, type TmuxTranscriptRunner } from '../../src/main/utils/tmux-transcript';

describe('tmux transcript helpers', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
    roots.length = 0;
  });

  it('starts pipe-pane with argv and shell-quotes only the transcript path', async () => {
    const runner = vi.fn<TmuxTranscriptRunner>().mockResolvedValue(undefined);

    await startTmuxTranscript('%1', "/tmp/amux logs/pane's output.ansi", runner);

    expect(runner).toHaveBeenCalledWith([
      'pipe-pane',
      '-t',
      '%1',
      "cat >> '/tmp/amux logs/pane'\\''s output.ansi'",
    ]);
  });

  it('creates a transcript file and reuses an existing one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aumx-transcript-'));
    roots.push(root);
    const runner = vi.fn<TmuxTranscriptRunner>().mockResolvedValue(undefined);

    const transcriptPath = await setupTmuxTranscript({
      filenamePrefix: 'shell',
      logDir: root,
      runner,
      tmuxPaneId: '%12',
    });

    expect(transcriptPath).toBeDefined();
    expect(existsSync(transcriptPath ?? '')).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);

    writeFileSync(transcriptPath ?? '', 'existing');
    const reusedPath = await setupTmuxTranscript({
      existingTranscriptPath: transcriptPath,
      logDir: root,
      runner,
      tmuxPaneId: '%12',
    });

    expect(reusedPath).toBe(transcriptPath);
    expect(readFileSync(transcriptPath ?? '', 'utf-8')).toBe('existing');
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('starts a new transcript instead of reusing one past the size cap', async () => {
    // Arrange
    const root = mkdtempSync(join(tmpdir(), 'aumx-transcript-cap-'));
    roots.push(root);
    const runner = vi.fn<TmuxTranscriptRunner>().mockResolvedValue(undefined);
    const oversizedPath = join(root, 'terminal', 'tmux-12-shell-oversized.ansi');
    mkdirSync(join(root, 'terminal'), { recursive: true });
    writeFileSync(oversizedPath, '');
    truncateSync(oversizedPath, 64 * 1024 * 1024 + 1);

    // Act
    const transcriptPath = await setupTmuxTranscript({
      existingTranscriptPath: oversizedPath,
      logDir: root,
      runner,
      tmuxPaneId: '%12',
    });

    // Assert: the oversized transcript is left untouched for the reaper.
    expect(transcriptPath).not.toBe(oversizedPath);
    expect(statSync(oversizedPath).size).toBe(64 * 1024 * 1024 + 1);
    expect(statSync(transcriptPath ?? '').size).toBe(0);
    expect(runner).toHaveBeenCalledWith([
      'pipe-pane',
      '-t',
      '%12',
      `cat >> '${transcriptPath}'`,
    ]);
  });
});
