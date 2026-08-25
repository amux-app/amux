import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveBaseBranch } from '../../src/main/services/git/baseBranch';
import { git, safeGit } from '../../src/main/services/git/gitCommand';
import {
  collectWorkingTreeFilePatch,
  createReviewSnapshot,
  getWorktreeSnapshot,
} from '../../src/main/services/git/gitDiff';

const SPACED_FILE = 'my notes $HOME.txt';

describe('git argv passing (no shell)', () => {
  let repo: string;

  beforeEach(() => {
    // Arrange: a repo whose absolute path contains spaces — a shell-quoted
    // command would break here if any argument were double-quoted or unsplit.
    repo = mkdtempSync(join(tmpdir(), 'muxbase argv repo '));
    run(['init', '-q', '-b', 'main']);
    run(['config', 'user.email', 't@t.com']);
    run(['config', 'user.name', 't']);
    writeFileSync(join(repo, 'tracked.txt'), 'base\n');
    run(['add', '-A']);
    run(['commit', '-qm', 'base']);
  });

  afterEach(() => {
    rmSync(repo, { force: true, recursive: true });
  });

  it('runs git in a worktree path containing spaces', async () => {
    const output = await git(repo, ['rev-parse', '--show-toplevel']);

    expect(output).not.toBe('');
    expect(await resolveBaseBranch(repo)).toBe('main');
  });

  it('keeps the repository path literal instead of shell-quoted', async () => {
    // A shell-quoted `-C '<path>'` argument would make git fail to chdir.
    expect(await safeGit(repo, ['rev-parse', '--is-inside-work-tree'])).toBe('true');
  });

  it('collects a working tree diff for a file whose name has spaces and shell metacharacters', async () => {
    writeFileSync(join(repo, SPACED_FILE), 'untracked line\n');
    writeFileSync(join(repo, 'tracked.txt'), 'changed\n');

    const snapshot = await getWorktreeSnapshot(repo, true);

    expect(snapshot?.diff.files.map((file) => file.path).sort()).toEqual([SPACED_FILE, 'tracked.txt']);
  });

  it('loads a single-file patch through an unquoted pathspec argument', async () => {
    writeFileSync(join(repo, SPACED_FILE), 'first\n');
    run(['add', '-A']);
    run(['commit', '-qm', 'add spaced file']);
    writeFileSync(join(repo, SPACED_FILE), 'second\n');

    const response = await collectWorkingTreeFilePatch(repo, SPACED_FILE);

    expect(response.error).toBeUndefined();
    expect(response.patch).toContain('-first');
    expect(response.patch).toContain('+second');
  });

  it('creates a review snapshot in a spaced path with a temp index', async () => {
    writeFileSync(join(repo, SPACED_FILE), 'snapshot me\n');

    const snapshot = await createReviewSnapshot(repo);

    expect(run(['ls-tree', '-r', '--name-only', snapshot.sha]).split('\n').sort())
      .toEqual([SPACED_FILE, 'tracked.txt']);
    expect(run(['status', '--porcelain'])).toContain(SPACED_FILE);
  });

  function run(args: string[]): string {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  }
});
