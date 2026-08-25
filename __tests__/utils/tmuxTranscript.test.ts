import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileAsync } from '../../src/utils/execAsync.js';
import { removePaneTranscript, setupPaneTranscript } from '../../src/utils/tmuxTranscript.js';

vi.mock('../../src/utils/execAsync.js', () => ({
  execFileAsync: vi.fn(async () => ''),
}));

describe('tmux transcript setup', () => {
  let testRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testRoot = mkdtempSync(join(tmpdir(), 'muxbase-transcript-'));
  });

  afterEach(() => {
    rmSync(testRoot, { force: true, recursive: true });
  });

  it('creates the transcript and starts pipe-pane with shell-safe output redirection', async () => {
    const transcriptDir = join(testRoot, "owner's logs");

    const transcriptPath = await setupPaneTranscript({
      filenamePrefix: 'merge feature/main',
      paneId: '%9',
      transcriptDir,
    });

    expect(existsSync(transcriptPath)).toBe(true);
    expect(transcriptPath).toContain('tmux-9-merge-feature-main-');
    expect(execFileAsync).toHaveBeenCalledWith(
      'tmux',
      [
        'pipe-pane',
        '-t',
        '%9',
        expect.stringContaining(`owner'\"'\"'s logs`),
      ],
      { timeout: 5000 },
    );

    removePaneTranscript(transcriptPath);
    expect(existsSync(transcriptPath)).toBe(false);
  });

  it('removes the newly created file when tmux rejects transcript setup', async () => {
    vi.mocked(execFileAsync).mockRejectedValueOnce(new Error('tmux unavailable'));
    const transcriptDir = join(testRoot, 'terminal');

    await expect(setupPaneTranscript({
      filenamePrefix: 'conflict',
      paneId: '%9',
      transcriptDir,
    })).rejects.toThrow('tmux unavailable');

    expect(readdirSync(transcriptDir)).toEqual([]);
  });
});
