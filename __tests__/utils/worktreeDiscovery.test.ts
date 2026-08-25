import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectAllWorktrees } from '../../src/utils/worktreeDiscovery.js';

const temporaryDirectories: string[] = [];

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('detectAllWorktrees', () => {
  it('discovers nested worktrees deepest first without losing repository metadata', async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), 'muxbase-worktree-discovery-'));
    temporaryDirectories.push(repositoryPath);

    runGit(repositoryPath, ['init', '--initial-branch=main']);
    runGit(repositoryPath, ['config', 'user.email', 'tests@muxbase.local']);
    runGit(repositoryPath, ['config', 'user.name', 'MuxBase Tests']);
    writeFileSync(join(repositoryPath, 'README.md'), 'fixture\n');
    runGit(repositoryPath, ['add', 'README.md']);
    runGit(repositoryPath, ['commit', '-m', 'initial']);

    const rootWorktreePath = join(repositoryPath, '.muxbase', 'worktrees', 'root-feature');
    runGit(repositoryPath, ['worktree', 'add', '-b', 'root-feature', rootWorktreePath]);

    const nestedWorktreePath = join(rootWorktreePath, 'packages', 'nested-feature');
    runGit(repositoryPath, ['worktree', 'add', '-b', 'nested-feature', nestedWorktreePath]);

    const worktrees = await detectAllWorktrees(rootWorktreePath);

    expect(worktrees.map(({ branch, depth, isRoot, relativePath }) => ({
      branch,
      depth,
      isRoot,
      relativePath,
    }))).toEqual([
      {
        branch: 'nested-feature',
        depth: 1,
        isRoot: false,
        relativePath: 'packages/nested-feature',
      },
      {
        branch: 'root-feature',
        depth: 0,
        isRoot: true,
        relativePath: '.',
      },
    ]);
    const canonicalRepositoryPath = realpathSync(repositoryPath);
    expect(worktrees.every(worktree => worktree.parentRepoPath === canonicalRepositoryPath)).toBe(true);
    expect(worktrees.every(worktree => worktree.mainBranch === 'main')).toBe(true);
  });
});
