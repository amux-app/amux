import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneCreationRollback } from '../../src/utils/paneCreationRollback.js';

const execFileAsync = vi.hoisted(() => vi.fn().mockResolvedValue(''));
vi.mock('../../src/utils/execAsync.js', () => ({ execFileAsync }));

describe('PaneCreationRollback', () => {
  const roots: string[] = [];

  beforeEach(() => {
    execFileAsync.mockClear();
  });

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { force: true, recursive: true });
    }
    roots.length = 0;
  });

  it('removes created artifacts in reverse order', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aumx-rollback-'));
    roots.push(root);
    const configPath = join(root, 'aumx.config.json');
    const transcriptPath = join(root, 'pane.ansi');
    const worktreePath = join(root, 'worktree');

    mkdirSync(worktreePath);
    writeFileSync(transcriptPath, 'ansi');
    writeFileSync(configPath, JSON.stringify({
      panes: [
        { id: 'keep', slug: 'keep', prompt: '', paneId: '%1' },
        { id: 'remove', slug: 'remove', prompt: '', paneId: '%2' },
      ],
    }));

    const rollback = new PaneCreationRollback();
    rollback.trackWorktree({
      branchName: 'feature/remove',
      deleteBranch: true,
      projectRoot: root,
      worktreePath,
    });
    rollback.trackTmuxPane('%2');
    rollback.trackTranscript(transcriptPath);
    rollback.trackConfigPane(configPath, 'remove');

    await rollback.run();

    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as { panes: Array<{ id: string }> };
    expect(config.panes.map((pane) => pane.id)).toEqual(['keep']);
    expect(existsSync(transcriptPath)).toBe(false);
    expect(execFileAsync.mock.calls).toEqual([
      ['tmux', ['kill-pane', '-t', '%2'], { timeout: 5000 }],
      ['git', ['worktree', 'remove', worktreePath, '--force'], { cwd: root, timeout: 30000 }],
      ['git', ['branch', '-D', 'feature/remove'], { cwd: root, timeout: 10000 }],
    ]);
  });

  it('does nothing after disarm', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aumx-rollback-'));
    roots.push(root);
    const transcriptPath = join(root, 'pane.ansi');
    writeFileSync(transcriptPath, 'ansi');

    const rollback = new PaneCreationRollback();
    rollback.trackTranscript(transcriptPath);
    rollback.disarm();

    await rollback.run();

    expect(existsSync(transcriptPath)).toBe(true);
    expect(execFileAsync).not.toHaveBeenCalled();
  });
});
