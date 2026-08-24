import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getWorktreeSnapshot } from '../../src/main/services/git/gitDiff';
import type { WorkingTreeDiffData } from '../../src/main/services/git/gitDiffParser';
import { buildGitStatusResponse } from '../../src/main/services/git/gitStatus';

function makeDiff(filesChanged: number): WorkingTreeDiffData {
  return {
    changedFiles: filesChanged > 0 ? ['src/index.ts'] : [],
    deletions: filesChanged > 0 ? 2 : 0,
    diff: '',
    files: [],
    filesChanged,
    insertions: filesChanged > 0 ? 3 : 0,
    untrackedFiles: [],
  };
}

describe('buildGitStatusResponse', () => {
  it('derives dirty state from the already-collected working tree diff', () => {
    expect(buildGitStatusResponse(makeDiff(1), 4)).toEqual({
      commitsAhead: 4,
      deletions: 2,
      filesChanged: 1,
      hasChanges: true,
      insertions: 3,
    });
  });

  it('reports a clean working tree without a second git status query', () => {
    expect(buildGitStatusResponse(makeDiff(0), null)).toEqual({
      commitsAhead: null,
      deletions: 0,
      filesChanged: 0,
      hasChanges: false,
      insertions: 0,
    });
  });
});

describe('git status response from real working tree snapshots', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'aumx-git-status-'));
    git(['init', '--initial-branch=main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test User']);
    writeFileSync(join(repo, 'tracked.txt'), 'base\n');
    git(['add', '.']);
    git(['commit', '-m', 'base']);
  });

  afterEach(() => {
    rmSync(repo, { force: true, recursive: true });
  });

  it('reports an untracked-only working tree as dirty', async () => {
    writeFileSync(join(repo, 'untracked.txt'), 'new\n');

    const response = await collectStatusResponse();

    expect(response.hasChanges).toBe(true);
    expect(response.filesChanged).toBe(1);
  });

  it('reports a staged-only working tree as dirty', async () => {
    writeFileSync(join(repo, 'tracked.txt'), 'staged\n');
    git(['add', 'tracked.txt']);

    const response = await collectStatusResponse();

    expect(response.hasChanges).toBe(true);
    expect(response.filesChanged).toBe(1);
  });

  it('reports a conflicted working tree as dirty', async () => {
    git(['switch', '-c', 'other']);
    writeFileSync(join(repo, 'tracked.txt'), 'other\n');
    git(['commit', '-am', 'other change']);
    git(['switch', 'main']);
    writeFileSync(join(repo, 'tracked.txt'), 'main\n');
    git(['commit', '-am', 'main change']);
    git(['merge', 'other'], true);

    const response = await collectStatusResponse();

    expect(response.hasChanges).toBe(true);
    expect(response.filesChanged).toBe(1);
  });

  async function collectStatusResponse() {
    const snapshot = await getWorktreeSnapshot(repo, false);
    return buildGitStatusResponse(snapshot!.diff, 0);
  }

  function git(args: string[], allowFailure = false): string {
    try {
      return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
    } catch (error) {
      if (allowFailure) return '';
      throw error;
    }
  }
});
