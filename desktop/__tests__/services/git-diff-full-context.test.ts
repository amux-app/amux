import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectWorkingTreeFilePatch, getWorktreeSnapshot } from '../../src/main/services/git/gitDiff';

describe('git diff full file context', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'muxbase-git-diff-context-'));
    git(['init']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test User']);
  });

  afterEach(() => {
    rmSync(repo, { force: true, recursive: true });
  });

  it('loads the selected file diff with full unchanged context', async () => {
    // Arrange
    mkdirSync(join(repo, 'src'));
    const filePath = join(repo, 'src', 'long-file.ts');
    const baseLines = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`);
    writeFileSync(filePath, `${baseLines.join('\n')}\n`);
    git(['add', '.']);
    git(['commit', '-m', 'base']);

    const changedLines = [...baseLines];
    changedLines[59] = 'line 60 changed';
    writeFileSync(filePath, `${changedLines.join('\n')}\n`);

    // Act
    const compactDiff = await getWorktreeSnapshot(repo, true);
    const fullDiff = await collectWorkingTreeFilePatch(repo, 'src/long-file.ts');
    const compactPatch = compactDiff?.diff.files.find((file) => file.path === 'src/long-file.ts')?.patch ?? '';

    // Assert
    expect(compactPatch).not.toContain(' line 1');
    expect(compactPatch).not.toContain(' line 80');
    expect(fullDiff.patch).toContain(' line 1');
    expect(fullDiff.patch).toContain(' line 80');
    expect(fullDiff.patch).toContain('-line 60');
    expect(fullDiff.patch).toContain('+line 60 changed');
  });

  it('loads the untracked file when it reuses a renamed-away path', async () => {
    // Arrange
    writeFileSync(join(repo, 'a.txt'), 'orig content\nl2\nl3\n');
    git(['add', '.']);
    git(['commit', '-m', 'base']);
    git(['mv', 'a.txt', 'b.txt']);
    writeFileSync(join(repo, 'a.txt'), 'BRAND NEW UNTRACKED CONTENT\n');

    // Act
    const fullDiff = await collectWorkingTreeFilePatch(repo, 'a.txt');

    // Assert
    expect(fullDiff.patch).toContain('--- /dev/null');
    expect(fullDiff.patch).toContain('+BRAND NEW UNTRACKED CONTENT');
    expect(fullDiff.patch).not.toContain('-orig content');
  });

  it('reports oversized full-file diffs so the UI can keep compact fallback visible', async () => {
    // Arrange
    const filePath = join(repo, 'large.txt');
    const baseLines = Array.from(
      { length: 45_000 },
      (_, index) => `${String(index).padStart(5, '0')} ${'x'.repeat(240)}`,
    );
    writeFileSync(filePath, `${baseLines.join('\n')}\n`);
    git(['add', '.']);
    git(['commit', '-m', 'base']);

    const changedLines = [...baseLines];
    changedLines[22_500] = `${String(22_500).padStart(5, '0')} ${'y'.repeat(240)}`;
    writeFileSync(filePath, `${changedLines.join('\n')}\n`);

    // Act
    const fullDiff = await collectWorkingTreeFilePatch(repo, 'large.txt');

    // Assert
    expect(fullDiff.patch).toBeUndefined();
    expect(fullDiff.tooLarge).toBe(true);
    expect(fullDiff.error).toContain('too large');
  });

  function git(args: string[]): string {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  }
});
