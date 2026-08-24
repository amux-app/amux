import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { predictMergeConflicts } from '../../src/utils/mergeValidation.js';

const roots: string[] = [];

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function createRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'aumx-merge-validation-'));
  roots.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'aumx-tests@example.com']);
  git(root, ['config', 'user.name', 'Amux Tests']);
  writeFileSync(path.join(root, 'base.txt'), 'base\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
  roots.length = 0;
});

describe('merge-tree conflict prediction', () => {
  it('reports clean divergence without claiming a conflict', async () => {
    const root = createRepo();
    git(root, ['switch', '-c', 'feature']);
    writeFileSync(path.join(root, 'feature.txt'), 'feature\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'feature']);
    git(root, ['switch', 'main']);
    writeFileSync(path.join(root, 'main.txt'), 'main\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'main']);

    await expect(predictMergeConflicts(root, 'feature', 'main')).resolves.toEqual({
      prediction: 'clean',
      conflictFiles: [],
    });
  });

  it('reports only Git-evidenced conflicting files', async () => {
    const root = createRepo();
    git(root, ['switch', '-c', 'feature']);
    writeFileSync(path.join(root, 'base.txt'), 'feature\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'feature']);
    git(root, ['switch', 'main']);
    writeFileSync(path.join(root, 'base.txt'), 'main\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'main']);

    await expect(predictMergeConflicts(root, 'feature', 'main')).resolves.toEqual({
      prediction: 'conflicted',
      conflictFiles: ['base.txt'],
    });
  });

  it('degrades invalid refs to unknown instead of a false conflict', async () => {
    const root = createRepo();

    await expect(predictMergeConflicts(root, 'missing', 'main')).resolves.toEqual({
      prediction: 'unknown',
      conflictFiles: [],
    });
  });
});
