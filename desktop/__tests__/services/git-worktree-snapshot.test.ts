import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gitCalls = vi.hoisted(() => [] as string[][]);
const collectorGate = vi.hoisted(() => ({
  blockNext: false,
  release: undefined as (() => void) | undefined,
  started: undefined as (() => void) | undefined,
}));

vi.mock('../../src/main/services/git/gitCommand', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/services/git/gitCommand')>();
  return {
    ...actual,
    git: (path: string, args: readonly string[]) => {
      gitCalls.push([...args]);
      return actual.git(path, args);
    },
    gitOrThrow: (path: string, args: readonly string[], options?: Parameters<typeof actual.gitOrThrow>[2]) => {
      gitCalls.push([...args]);
      return actual.gitOrThrow(path, args, options);
    },
    safeGit: (path: string, args: readonly string[], fallback?: string | null) => {
      gitCalls.push([...args]);
      return actual.safeGit(path, args, fallback);
    },
  };
});

vi.mock('../../src/main/services/git/gitDiffCollector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/services/git/gitDiffCollector')>();
  return {
    ...actual,
    collectWorkingTreeDiffFromStatus: async (
      ...args: Parameters<typeof actual.collectWorkingTreeDiffFromStatus>
    ) => {
      if (collectorGate.blockNext) {
        collectorGate.blockNext = false;
        collectorGate.started?.();
        await new Promise<void>((resolve) => {
          collectorGate.release = resolve;
        });
      }
      return actual.collectWorkingTreeDiffFromStatus(...args);
    },
  };
});

const { __test__: contextTest } = await import('../../src/main/services/git/gitWorktreeContext');
const {
  getWorktreeMeta,
  getWorktreeSnapshot,
  releaseWorktreeSnapshot,
  __test__: snapshotTest,
} = await import('../../src/main/services/git/gitWorktreeSnapshot');

const FRESH_WINDOW_MS = 600;
const STATUS_COMMAND = 'status';
const ALLOW_FILE_PROTOCOL = ['-c', 'protocol.file.allow=always'];
const TEST_GIT_IDENTITY = ['-c', 'user.email=t@t.com', '-c', 'user.name=t'];
const FIXED_MTIME_SECONDS = 1_700_000_000;

type Snapshot = Awaited<ReturnType<typeof getWorktreeSnapshot>>;

describe('worktree snapshot cache', () => {
  let repo: string;
  let scratchDirs: string[];

  beforeEach(() => {
    snapshotTest.resetSnapshotCache();
    contextTest.resetCanonicalPaths();
    collectorGate.blockNext = false;
    collectorGate.release = undefined;
    collectorGate.started = undefined;
    gitCalls.length = 0;
    scratchDirs = [];
    repo = mkdtempSync(join(tmpdir(), 'aumx-snapshot-'));
    run(repo, ['init', '-q', '-b', 'main']);
    run(repo, ['config', 'user.email', 't@t.com']);
    run(repo, ['config', 'user.name', 't']);
    writeFileSync(join(repo, 'tracked.txt'), 'base\n');
    run(repo, ['add', '-A']);
    run(repo, ['commit', '-qm', 'base']);
  });

  afterEach(() => {
    for (const dir of scratchDirs) rmSync(dir, { force: true, recursive: true });
    rmSync(repo, { force: true, recursive: true });
  });

  it('serves concurrent callers on one worktree from a single git status scan', async () => {
    // Arrange
    writeFileSync(join(repo, 'tracked.txt'), 'changed\n');
    gitCalls.length = 0;

    // Act
    const results = await Promise.all(
      Array.from({ length: 6 }, () => getWorktreeSnapshot(repo, false)),
    );

    // Assert
    expect(countCommand(STATUS_COMMAND)).toBe(1);
    expect(results.every((result) => result?.diff.filesChanged === 1)).toBe(true);
  });

  it('answers a commit-range caller from repository metadata without scanning the working tree', async () => {
    // Arrange: a dirty worktree the range view must not pay to collect.
    writeFileSync(join(repo, 'tracked.txt'), 'changed\n');
    writeFileSync(join(repo, 'untracked.txt'), 'a\nb\n');
    gitCalls.length = 0;

    // Act
    const meta = await getWorktreeMeta(repo);

    // Assert
    expect(countCommand(STATUS_COMMAND)).toBe(0);
    expect(meta?.baseBranch).toBe('main');
    expect(meta?.context.branch).toBe('main');
  });

  it('serves a status request and a diff request from one collection', async () => {
    // Arrange
    writeFileSync(join(repo, 'tracked.txt'), 'changed\n');
    gitCalls.length = 0;

    // Act: the two pollers of one worktree ask for different levels of detail.
    const [summary, withPatches] = await Promise.all([
      getWorktreeSnapshot(repo, false),
      getWorktreeSnapshot(repo, true),
    ]);

    // Assert
    expect(countCommand(STATUS_COMMAND)).toBe(1);
    expect(summary?.diff.insertions).toBe(1);
    expect(withPatches?.diff.files[0]?.patch).toContain('+changed');
  });

  it('coalesces late patch callers into one follow-up collection', async () => {
    // Arrange: hold a summary collection after it has committed to omitting
    // patches, then let two patch callers arrive on the same in-flight entry.
    writeFileSync(join(repo, 'tracked.txt'), 'changed\n');
    let markStarted: (() => void) | undefined;
    const collectorStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    collectorGate.blockNext = true;
    collectorGate.started = markStarted;
    gitCalls.length = 0;

    // Act
    const summary = getWorktreeSnapshot(repo, false);
    await collectorStarted;
    const firstPatch = getWorktreeSnapshot(repo, true);
    const secondPatch = getWorktreeSnapshot(repo, true);
    collectorGate.release?.();
    const [, first, second] = await Promise.all([summary, firstPatch, secondPatch]);

    // Assert: the first pass cannot grow patches retroactively, but both late
    // callers share exactly one richer follow-up pass.
    expect(countCommand(STATUS_COMMAND)).toBe(2);
    expect(first?.diff.files[0]?.patch).toContain('+changed');
    expect(second?.diff.files[0]?.patch).toContain('+changed');
  });

  it('keeps a worktree collecting patches across a status-only refresh', async () => {
    // Arrange: the diff view collected patches, then the status poll refreshed
    // the same worktree after an edit.
    await getWorktreeSnapshot(repo, true);
    await wait(FRESH_WINDOW_MS);
    writeFileSync(join(repo, 'tracked.txt'), 'changed\n');
    await getWorktreeSnapshot(repo, false);
    await wait(FRESH_WINDOW_MS);
    gitCalls.length = 0;

    // Act
    const snapshot = await getWorktreeSnapshot(repo, true);

    // Assert: the patches survived, so nothing had to be collected again.
    expect(gitCalls).toEqual([[STATUS_COMMAND, '--porcelain=v1', '-z', '-uall']]);
    expect(snapshot?.diff.files[0]?.patch).toContain('+changed');
  });

  it('collapses the metadata gathering pass into a single status process when nothing changed', async () => {
    // Arrange
    writeFileSync(join(repo, 'tracked.txt'), 'changed\n');
    await getWorktreeSnapshot(repo, true);
    await wait(FRESH_WINDOW_MS);
    gitCalls.length = 0;

    // Act
    const snapshot = await getWorktreeSnapshot(repo, true);

    // Assert
    expect(gitCalls).toEqual([[STATUS_COMMAND, '--porcelain=v1', '-z', '-uall']]);
    expect(snapshot?.diff.insertions).toBe(1);
  });

  it('recollects the diff when a tracked file changes without changing status output', async () => {
    // Arrange
    writeFileSync(join(repo, 'tracked.txt'), 'changed\n');
    const before = await getWorktreeSnapshot(repo, true);
    await wait(FRESH_WINDOW_MS);
    writeFileSync(join(repo, 'tracked.txt'), 'changed twice\nand again\n');
    gitCalls.length = 0;

    // Act
    const after = await getWorktreeSnapshot(repo, true);

    // Assert
    expect(before?.diff.insertions).toBe(1);
    expect(after?.diff.insertions).toBe(2);
    expect(gitCalls.length).toBeGreaterThan(1);
  });

  it('recollects the diff when the only changed file is rewritten to the same size and mtime', async () => {
    // Arrange: an in-place rewrite of the one path git reports, leaving status
    // output, size and mtime identical, so only its change time records the edit.
    const tracked = join(repo, 'tracked.txt');
    writeWithFixedMtime(tracked, 'aaaa\n');
    const before = await getWorktreeSnapshot(repo, true);
    await wait(FRESH_WINDOW_MS);
    writeWithFixedMtime(tracked, 'bbbb\n');

    // Act
    const after = await getWorktreeSnapshot(repo, true);

    // Assert
    expect(before?.diff.files[0]?.patch).toContain('+aaaa');
    expect(after?.diff.files[0]?.patch).toContain('+bbbb');
  });

  it('keeps counts independent for two worktrees of the same repository', async () => {
    // Arrange: sibling worktrees share --git-common-dir but not their working trees.
    const secondary = `${repo}-wt`;
    run(repo, ['worktree', 'add', '-q', '-b', 'feature', secondary]);
    writeFileSync(join(repo, 'tracked.txt'), 'primary edit\n');
    writeFileSync(join(secondary, 'secondary-only.txt'), 'a\nb\nc\n');

    // Act
    const [primary, feature] = await Promise.all([
      getWorktreeSnapshot(repo, true),
      getWorktreeSnapshot(secondary, true),
    ]);

    // Assert
    expect(primary?.diff.changedFiles).toEqual(['tracked.txt']);
    expect(primary?.diff.insertions).toBe(1);
    expect(feature?.diff.changedFiles).toEqual(['secondary-only.txt']);
    expect(feature?.diff.insertions).toBe(3);
    expect(primary?.context.branch).toBe('main');
    expect(feature?.context.branch).toBe('feature');
    expect(feature?.context.isWorktree).toBe(true);

    rmSync(secondary, { force: true, recursive: true });
  });

  it('keys the cache on the resolved working tree path, not the repository root', async () => {
    // Arrange
    const secondary = `${repo}-alias`;
    run(repo, ['worktree', 'add', '-q', '-b', 'alias', secondary]);
    writeFileSync(join(secondary, 'only-here.txt'), 'x\n');
    await getWorktreeSnapshot(secondary, true);

    // Act: the primary worktree must not inherit the sibling's cached entry.
    const primary = await getWorktreeSnapshot(repo, true);

    // Assert
    expect(primary?.diff.filesChanged).toBe(0);
    expect(primary?.context.gitRoot).not.toBe((await getWorktreeSnapshot(secondary, true))?.context.gitRoot);

    rmSync(secondary, { force: true, recursive: true });
  });

  it('refreshes branch and commit metadata after a commit moves HEAD', async () => {
    // Arrange
    await getWorktreeSnapshot(repo, true);
    await wait(FRESH_WINDOW_MS);
    writeFileSync(join(repo, 'tracked.txt'), 'committed\n');
    run(repo, ['checkout', '-qb', 'next']);
    run(repo, ['commit', '-qam', 'second commit']);

    // Act
    const snapshot = await getWorktreeSnapshot(repo, true);

    // Assert
    expect(snapshot?.context.branch).toBe('next');
    expect(snapshot?.recentCommits[0]?.message).toBe('second commit');
    expect(snapshot?.diff.filesChanged).toBe(0);
  });

  it('reports a detached HEAD without a branch name', async () => {
    // Arrange
    const sha = run(repo, ['rev-parse', 'HEAD']);
    run(repo, ['checkout', '-q', '--detach', sha]);

    // Act
    const snapshot = await getWorktreeSnapshot(repo, true);

    // Assert
    expect(snapshot?.context.detachedHead).toBe(true);
    expect(snapshot?.context.branch).toBe('HEAD');
  });

  it('collects untracked additions in an empty repository with no commits', async () => {
    // Arrange
    const empty = mkdtempSync(join(tmpdir(), 'aumx-snapshot-empty-'));
    run(empty, ['init', '-q', '-b', 'main']);
    writeFileSync(join(empty, 'new.txt'), 'one\ntwo\n');

    // Act
    const snapshot = await getWorktreeSnapshot(empty, true);

    // Assert
    expect(snapshot?.context.hasHeadCommit).toBe(false);
    expect(snapshot?.diff.insertions).toBe(2);
    expect(snapshot?.diff.untrackedFiles).toEqual(['new.txt']);

    rmSync(empty, { force: true, recursive: true });
  });

  it('returns null for a path outside any repository', async () => {
    // Arrange
    const plain = mkdtempSync(join(tmpdir(), 'aumx-snapshot-plain-'));

    // Act
    const snapshot = await getWorktreeSnapshot(plain, false);

    // Assert
    expect(snapshot).toBeNull();

    rmSync(plain, { force: true, recursive: true });
  });

  it('reports identical untracked counts for summary and patch collections', async () => {
    // Arrange
    writeFileSync(join(repo, 'untracked.txt'), 'a\nb\nc\nd');
    const summary = await getWorktreeSnapshot(repo, false);
    snapshotTest.resetSnapshotCache();

    // Act
    const withPatches = await getWorktreeSnapshot(repo, true);

    // Assert
    expect(summary?.diff.insertions).toBe(4);
    expect(withPatches?.diff.insertions).toBe(summary?.diff.insertions);
    expect(withPatches?.diff.files[0]?.patch).toContain('+d');
  });

  it('recounts an untracked file rewritten to the same size and mtime', async () => {
    // Arrange: two untracked files, one of which will be rewritten in place so
    // that only its change time records the edit.
    const rewritten = join(repo, 'rewritten.txt');
    writeWithFixedMtime(rewritten, 'a\nb\nc\n');
    writeFileSync(join(repo, 'churn.txt'), 'x\n');
    const before = await getWorktreeSnapshot(repo, false);
    await wait(FRESH_WINDOW_MS);

    // Act: rewrite to the same size and pin the mtime back, and edit the other
    // file so the worktree is collected again.
    writeWithFixedMtime(rewritten, 'abcde\n');
    writeFileSync(join(repo, 'churn.txt'), 'x\ny\n');
    const after = await getWorktreeSnapshot(repo, false);

    // Assert: neither file was answered from a count taken before the rewrite.
    expect(additionsFor(before, 'rewritten.txt')).toBe(3);
    expect(additionsFor(after, 'rewritten.txt')).toBe(1);
    expect(additionsFor(after, 'churn.txt')).toBe(2);
  });

  it('cannot serve a cached untracked count once the worktree is released', async () => {
    // Arrange: a rewrite that leaves status output byte-identical, so the count
    // has to come from the file rather than from a memo the released entry held.
    const stable = join(repo, 'stable.txt');
    writeWithFixedMtime(stable, 'a\nb\nc\n');
    await getWorktreeSnapshot(repo, false);
    await wait(FRESH_WINDOW_MS);
    writeWithFixedMtime(stable, 'abcde\n');

    // Act
    releaseWorktreeSnapshot(repo);
    const after = await getWorktreeSnapshot(repo, false);

    // Assert: the released worktree read the file again instead of reusing a count.
    expect(additionsFor(after, 'stable.txt')).toBe(1);
  });

  it('reports the same insertions from a warmed cache as from a cold collection', async () => {
    // Arrange: a refresh that mixes a memoized count with a freshly read file.
    writeFileSync(join(repo, 'one.txt'), 'a\nb\n');
    writeFileSync(join(repo, 'two.txt'), 'c\n');
    await getWorktreeSnapshot(repo, false);
    await wait(FRESH_WINDOW_MS);
    writeFileSync(join(repo, 'two.txt'), 'c\nd\ne\n');
    const warm = await getWorktreeSnapshot(repo, false);

    // Act: the same working tree, collected with nothing cached.
    snapshotTest.resetSnapshotCache();
    const cold = await getWorktreeSnapshot(repo, false);

    // Assert
    expect(warm?.diff.insertions).toBe(5);
    expect(cold?.diff.insertions).toBe(warm?.diff.insertions);
  });

  it('bounds untracked paths in the working signature without dropping tracked paths', () => {
    // Arrange: a repository may expose far more untracked files than the diff
    // collector is willing to open, plus tracked changes after that long prefix.
    const entries = [
      ...Array.from({ length: 2500 }, (_, index) => ({
        path: `untracked-${index}.txt`,
        staged: false,
        status: 'untracked' as const,
        unstaged: true,
      })),
      {
        path: 'tracked.txt',
        staged: false,
        status: 'modified' as const,
        unstaged: true,
      },
    ];

    // Act
    const paths = snapshotTest.pathsForWorkingSignature(entries);

    // Assert: signature validation covers every path whose content may be
    // collected, and every tracked path, but does no metadata I/O for omitted
    // untracked previews.
    expect(paths).toHaveLength(2001);
    expect(paths).toContain('untracked-0.txt');
    expect(paths).not.toContain('untracked-2499.txt');
    expect(paths).toContain('tracked.txt');
  });

  it('evicts under pressure and recollects an evicted worktree from disk', async () => {
    // Arrange: more worktrees than the cache holds, each with its own line count.
    const bound = snapshotTest.maxCachedWorktrees;
    const repos = Array.from({ length: bound + 2 }, (_, index) => makeCountedRepo(index + 1));

    // Act
    const insertions: Array<number | undefined> = [];
    for (const entry of repos) {
      insertions.push((await getWorktreeSnapshot(entry.path, false))?.diff.insertions);
    }
    const evicted = repos[0];
    writeFileSync(join(evicted.path, 'extra.txt'), 'x\ny\n');
    const reread = await getWorktreeSnapshot(evicted.path, false);

    // Assert: every worktree reported its own counts, the cache stayed bounded, and the
    // evicted head came back from disk rather than from a surviving neighbour.
    expect(insertions).toEqual(repos.map((entry) => entry.lines));
    expect(snapshotTest.cachedWorktreeCount()).toBe(bound);
    expect(reread?.diff.insertions).toBe(evicted.lines + 2);
    expect(reread?.diff.untrackedFiles).toEqual(['counted.txt', 'extra.txt']);
  }, 30_000);

  it('releases a closed pane worktree so its cached diff stops answering', async () => {
    // Arrange
    writeFileSync(join(repo, 'tracked.txt'), 'changed\n');
    const before = await getWorktreeSnapshot(repo, true);
    writeFileSync(join(repo, 'tracked.txt'), 'changed\nagain\n');

    // Act: the retained entry answers from its coalescing window, the released one cannot.
    const retained = await getWorktreeSnapshot(repo, true);
    releaseWorktreeSnapshot(repo);
    const afterRelease = await getWorktreeSnapshot(repo, true);

    // Assert
    expect(before?.diff.insertions).toBe(1);
    expect(retained?.diff.insertions).toBe(1);
    expect(afterRelease?.diff.insertions).toBe(2);
  });

  it('recollects the diff when a submodule commit leaves status output unchanged', async () => {
    // Arrange: a submodule directory keeps its mtime and its ` M sub` status line
    // no matter which commit it points at.
    const submodule = makeSubmoduleRepo();
    run(repo, [...ALLOW_FILE_PROTOCOL, 'submodule', 'add', '-q', submodule, 'sub']);
    run(repo, ['commit', '-qm', 'add submodule']);
    commitInSubmodule(join(repo, 'sub'), 'second');
    const before = await getWorktreeSnapshot(repo, true);
    await wait(FRESH_WINDOW_MS);
    commitInSubmodule(join(repo, 'sub'), 'third');

    // Act
    const after = await getWorktreeSnapshot(repo, true);

    // Assert
    const head = run(join(repo, 'sub'), ['rev-parse', 'HEAD']);
    expect(before?.diff.files[0]?.patch).not.toContain(head);
    expect(after?.diff.files[0]?.patch).toContain(head);
  });

  function countCommand(command: string): number {
    return gitCalls.filter((args) => args[0] === command).length;
  }

  function makeCountedRepo(lines: number): { lines: number; path: string } {
    const path = mkdtempSync(join(tmpdir(), 'aumx-snapshot-bound-'));
    scratchDirs.push(path);
    run(path, ['init', '-q', '-b', 'main']);
    writeFileSync(join(path, 'counted.txt'), 'line\n'.repeat(lines));
    return { lines, path };
  }

  function makeSubmoduleRepo(): string {
    const path = mkdtempSync(join(tmpdir(), 'aumx-snapshot-sub-'));
    scratchDirs.push(path);
    run(path, ['init', '-q', '-b', 'main']);
    run(path, ['config', 'user.email', 't@t.com']);
    run(path, ['config', 'user.name', 't']);
    writeFileSync(join(path, 'sub.txt'), 'first\n');
    run(path, ['add', '-A']);
    run(path, ['commit', '-qm', 'first']);
    return path;
  }

  function commitInSubmodule(path: string, content: string): void {
    writeFileSync(join(path, 'sub.txt'), `${content}\n`);
    run(path, [...TEST_GIT_IDENTITY, 'commit', '-qam', content]);
  }
});

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

/** Writes in place and pins the mtime, so equal-sized content keeps one identity. */
function writeWithFixedMtime(path: string, content: string): void {
  writeFileSync(path, content);
  utimesSync(path, FIXED_MTIME_SECONDS, FIXED_MTIME_SECONDS);
}

function additionsFor(snapshot: Snapshot, path: string): number | undefined {
  return snapshot?.diff.files.find((file) => file.path === path)?.additions;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
