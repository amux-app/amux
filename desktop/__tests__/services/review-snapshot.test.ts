import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectSnapshotDiffData, collectWorkingDiffData, createReviewSnapshot } from '../../src/main/services/git/gitDiff';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('createReviewSnapshot (real git)', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'muxbase-review-snap-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 't@t.com']);
    git(repo, ['config', 'user.name', 't']);
    writeFileSync(join(repo, 'f.txt'), 'base\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'base']);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('returns HEAD unchanged when the worktree is clean', async () => {
    const head = git(repo, ['rev-parse', 'HEAD']);
    const snapshot = await createReviewSnapshot(repo);
    expect(snapshot.sha).toBe(head);
    expect(snapshot.skippedFiles).toEqual([]);
  });

  it('captures uncommitted + untracked changes without mutating the source branch or index', async () => {
    // Arrange: dirty state — modified tracked (staged) + untracked
    writeFileSync(join(repo, 'f.txt'), 'modified\n');
    writeFileSync(join(repo, 'g.txt'), 'untracked\n');
    git(repo, ['add', 'f.txt']);
    const headBefore = git(repo, ['rev-parse', 'HEAD']);
    const statusBefore = git(repo, ['status', '--porcelain']);

    // Act
    const snapshot = await createReviewSnapshot(repo);

    // Assert: snapshot is a new commit containing both changes
    expect(snapshot.sha).not.toBe(headBefore);
    const tree = git(repo, ['ls-tree', '-r', '--name-only', snapshot.sha]).split('\n').sort();
    expect(tree).toEqual(['f.txt', 'g.txt']);
    expect(git(repo, ['show', `${snapshot.sha}:f.txt`])).toBe('modified');

    // Assert: source branch HEAD and index are pristine
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(git(repo, ['status', '--porcelain'])).toBe(statusBefore);
  });

  it('produces a snapshot diff against base that includes the full change', async () => {
    writeFileSync(join(repo, 'f.txt'), 'changed\n');
    const snapshot = await createReviewSnapshot(repo);

    const diff = await collectSnapshotDiffData(repo, 'main', snapshot.sha);

    expect(diff.changedFiles).toContain('f.txt');
    expect(diff.diff).toContain('changed');
  });

  it('captures staged new files even when a secret file is also present (skipped-file bug)', async () => {
    // Arrange: a staged new file (not untracked) + a secret file (untracked, should be skipped)
    writeFileSync(join(repo, 'new-feature.ts'), 'export const x = 1;\n');
    git(repo, ['add', 'new-feature.ts']);   // staged, not untracked
    writeFileSync(join(repo, '.env'), 'SECRET=abc\n');  // untracked secret

    // Act
    const snapshot = await createReviewSnapshot(repo);

    // Assert: staged file is in the snapshot
    const tree = git(repo, ['ls-tree', '-r', '--name-only', snapshot.sha]).split('\n');
    expect(tree).toContain('new-feature.ts');
    // Assert: secret is excluded
    expect(tree).not.toContain('.env');
    // Assert: secret is listed as skipped
    expect(snapshot.skippedFiles).toContain('.env');
  });

  it('excludes a secret file that was staged before the review snapshot', async () => {
    writeFileSync(join(repo, '.env.production'), 'DATABASE_PASSWORD=secret\n');
    git(repo, ['add', '.env.production']);
    const statusBefore = git(repo, ['status', '--porcelain']);

    const snapshot = await createReviewSnapshot(repo);

    const tree = git(repo, ['ls-tree', '-r', '--name-only', snapshot.sha]).split('\n');
    expect(tree).not.toContain('.env.production');
    expect(snapshot.skippedFiles).toContain('.env.production');
    expect(git(repo, ['status', '--porcelain'])).toBe(statusBefore);
  });

  it('keeps the HEAD version of a modified tracked secret out of the snapshot diff', async () => {
    writeFileSync(join(repo, '.env'), 'DATABASE_PASSWORD=old\n');
    git(repo, ['add', '.env']);
    git(repo, ['commit', '-qm', 'tracked fixture']);
    writeFileSync(join(repo, '.env'), 'DATABASE_PASSWORD=new\n');

    const snapshot = await createReviewSnapshot(repo);

    expect(git(repo, ['show', `${snapshot.sha}:.env`])).toBe('DATABASE_PASSWORD=old');
    expect(snapshot.skippedFiles).toContain('.env');
  });

  it('excludes an untracked secret whose name contains a space (quotePath-safe)', async () => {
    // Arrange: git C-quotes spaced/non-ASCII paths in default porcelain output,
    // which broke the old slice-based parser — the spaced pathspec no longer
    // matched, so `git rm --cached` threw and the whole review aborted.
    writeFileSync(join(repo, 'my key.pem'), '-----BEGIN KEY-----\n');
    writeFileSync(join(repo, 'feature.ts'), 'export const y = 2;\n');

    // Act
    const snapshot = await createReviewSnapshot(repo);

    // Assert: snapshot builds, real change is captured, spaced secret is excluded and reported
    const tree = git(repo, ['ls-tree', '-r', '--name-only', snapshot.sha]).split('\n');
    expect(tree).toContain('feature.ts');
    expect(tree).not.toContain('my key.pem');
    expect(snapshot.skippedFiles).toContain('my key.pem');
  });

  it('captures untracked-only changes even when status.showUntrackedFiles=no', async () => {
    // Arrange: a repo config that hides untracked files from `git status`,
    // and an agent that created ONLY a new untracked file.
    git(repo, ['config', 'status.showUntrackedFiles', 'no']);
    writeFileSync(join(repo, 'new-feature.txt'), 'new\n');
    const head = git(repo, ['rev-parse', 'HEAD']);

    // Act
    const snapshot = await createReviewSnapshot(repo);

    // Assert: the snapshot is a real new commit containing the untracked file,
    // not a no-op fallback to HEAD.
    expect(snapshot.sha).not.toBe(head);
    const tree = git(repo, ['ls-tree', '-r', '--name-only', snapshot.sha]).split('\n');
    expect(tree).toContain('new-feature.txt');
  });

  it('retains a tracked file that later matches .gitignore (no phantom deletion)', async () => {
    // Arrange: .env is tracked, then added to .gitignore (still tracked in HEAD)
    writeFileSync(join(repo, '.env'), 'SECRET=1\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'track .env']);
    writeFileSync(join(repo, '.gitignore'), '.env\n');
    git(repo, ['add', '.gitignore']);
    git(repo, ['commit', '-qm', 'ignore .env']);
    writeFileSync(join(repo, 'f.txt'), 'changed\n'); // unrelated dirty change

    // Act
    const snapshot = await createReviewSnapshot(repo);

    // Assert: .env survives in the snapshot and is NOT reported as deleted
    const tree = git(repo, ['ls-tree', '-r', '--name-only', snapshot.sha]).split('\n');
    expect(tree).toContain('.env');
    const diff = await collectSnapshotDiffData(repo, 'main', snapshot.sha);
    expect(diff.changedFiles).not.toContain('.env');
  });
});

describe('createReviewSnapshot in a linked worktree (real git)', () => {
  let repo: string;
  let worktree: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'muxbase-review-wt-repo-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 't@t.com']);
    git(repo, ['config', 'user.name', 't']);
    writeFileSync(join(repo, 'f.txt'), 'base\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'base']);
    // A linked worktree is what every MuxBase pane runs in — its `.git` is a FILE
    // (`gitdir: …`), not a directory, so a temp index under `.git` would fail.
    worktree = mkdtempSync(join(tmpdir(), 'muxbase-review-wt-'));
    rmSync(worktree, { recursive: true, force: true });
    git(repo, ['worktree', 'add', '-q', worktree, '-b', 'feat']);
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('snapshots dirty changes in a linked worktree without mutating it', async () => {
    // Arrange
    writeFileSync(join(worktree, 'f.txt'), 'modified\n');
    writeFileSync(join(worktree, 'g.txt'), 'untracked\n');
    const headBefore = git(worktree, ['rev-parse', 'HEAD']);
    const statusBefore = git(worktree, ['status', '--porcelain']);

    // Act
    const snapshot = await createReviewSnapshot(worktree);

    // Assert: real snapshot SHA (not empty), containing both changes
    expect(snapshot.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.sha).not.toBe(headBefore);
    const tree = git(worktree, ['ls-tree', '-r', '--name-only', snapshot.sha]).split('\n').sort();
    expect(tree).toEqual(['f.txt', 'g.txt']);

    // Assert: the linked worktree stays pristine
    expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(git(worktree, ['status', '--porcelain'])).toBe(statusBefore);
  });
});

describe('non-worktree review on a shared checkout (real git)', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'muxbase-review-direct-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 't@t.com']);
    git(repo, ['config', 'user.name', 't']);
    writeFileSync(join(repo, 'f.txt'), 'base\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'base']);
    // A feature branch with prior commits that are NOT this session's work.
    git(repo, ['checkout', '-q', '-b', 'feature']);
    writeFileSync(join(repo, 'prior1.txt'), 'old\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'prior commit 1']);
    writeFileSync(join(repo, 'prior2.txt'), 'old\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'prior commit 2']);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('reviews only uncommitted session changes, not the branch history', async () => {
    // Arrange: the agent session work (uncommitted), on top of prior commits
    writeFileSync(join(repo, 'today.txt'), 'new\n');
    writeFileSync(join(repo, 'f.txt'), 'edited\n');

    // Act
    const snapshot = await createReviewSnapshot(repo);
    const diff = await collectWorkingDiffData(repo, snapshot.sha);

    // Assert: HEAD...snapshot shows ONLY the session changes
    expect(diff.changedFiles.sort()).toEqual(['f.txt', 'today.txt']);
    expect(diff.changedFiles).not.toContain('prior1.txt');
    expect(diff.changedFiles).not.toContain('prior2.txt');
  });

  it('returns HEAD (no review changes) when the shared checkout is clean', async () => {
    const head = git(repo, ['rev-parse', 'HEAD']);
    const snapshot = await createReviewSnapshot(repo);
    expect(snapshot.sha).toBe(head);
    const diff = await collectWorkingDiffData(repo, snapshot.sha);
    expect(diff.changedFiles).toEqual([]);
  });
});
