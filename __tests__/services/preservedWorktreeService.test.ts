import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectPreservedWorktreeAsync,
  listPreservedWorktreesAsync,
  removePreservedWorktreeAsync,
} from '../../src/services/PreservedWorktreeService.js';
import type {
  PreservedWorktree,
  RemovePreservedWorktreeOptions,
} from '../../src/services/PreservedWorktreeService.js';

const roots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'aumx-preserved-worktree-'));
  roots.push(root);
  return root;
}

function initializeRepository(): string {
  const root = createTempRoot();
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'tests@aumx.local'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Aumx Tests'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root, stdio: 'ignore' });
  mkdirSync(join(root, '.aumx', 'worktrees'), { recursive: true });
  return root;
}

function createRegisteredWorktree(root: string, slug: string): string {
  const worktreePath = join(root, '.aumx', 'worktrees', slug);
  execFileSync('git', ['worktree', 'add', '-b', `feature/${slug}`, worktreePath], {
    cwd: root,
    stdio: 'ignore',
  });
  return worktreePath;
}

function toRemovalState(worktree: PreservedWorktree) {
  return {
    branch: worktree.branch,
    gitStatus: worktree.gitStatus,
    registration: worktree.registration,
  };
}

async function removalOptions(
  projectRoot: string,
  worktreePath: string,
  allowDataLoss: boolean,
): Promise<RemovePreservedWorktreeOptions> {
  const inspected = await inspectPreservedWorktreeAsync(projectRoot, [], worktreePath);
  return {
    activeWorktreePaths: [],
    allowDataLoss,
    expectedState: toRemovalState(inspected),
    projectRoot,
    worktreePath,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('PreservedWorktreeService', () => {
  it('lists filesystem metadata without requiring valid Git metadata', async () => {
    const root = createTempRoot();
    const worktreePath = join(root, '.aumx', 'worktrees', 'stale-e2e');
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, '.git'), 'gitdir: /missing/worktree/metadata\n');

    const worktrees = await listPreservedWorktreesAsync(root, []);

    expect(worktrees).toEqual([
      expect.objectContaining({
        branch: null,
        gitStatus: 'unchecked',
        path: worktreePath,
        slug: 'stale-e2e',
      }),
    ]);
  });

  it('inspects only the requested worktree and reports dirty state', async () => {
    const root = initializeRepository();
    const inspectedPath = createRegisteredWorktree(root, 'inspect-me');
    createRegisteredWorktree(root, 'leave-unread');
    writeFileSync(join(inspectedPath, 'dirty.txt'), 'uncommitted\n');

    const worktree = await inspectPreservedWorktreeAsync(root, [], inspectedPath);

    expect(worktree).toMatchObject({
      branch: 'feature/inspect-me',
      gitStatus: 'dirty',
      path: inspectedPath,
      slug: 'inspect-me',
    });
  });

  it('refuses paths outside the managed directory and active worktrees', async () => {
    const root = initializeRepository();
    const activePath = createRegisteredWorktree(root, 'active');
    const outsidePath = join(root, 'outside');
    mkdirSync(outsidePath);
    writeFileSync(join(outsidePath, '.git'), 'not managed\n');

    await expect(
      inspectPreservedWorktreeAsync(root, [], outsidePath),
    ).rejects.toThrow('outside the managed worktree directory');
    await expect(
      inspectPreservedWorktreeAsync(root, [activePath], activePath),
    ).rejects.toThrow('active');
  });

  it('requires explicit data-loss consent before removing a dirty worktree', async () => {
    const root = initializeRepository();
    const worktreePath = createRegisteredWorktree(root, 'dirty');
    writeFileSync(join(worktreePath, 'important.txt'), 'do not lose silently\n');

    await expect(removePreservedWorktreeAsync(
      await removalOptions(root, worktreePath, false),
    )).rejects.toThrow('uncommitted changes');

    await removePreservedWorktreeAsync(await removalOptions(root, worktreePath, true));

    expect(await listPreservedWorktreesAsync(root, [])).toEqual([]);
  });

  it('removes a clean registered worktree without broad data-loss consent', async () => {
    const root = initializeRepository();
    const worktreePath = createRegisteredWorktree(root, 'clean');

    await removePreservedWorktreeAsync(await removalOptions(root, worktreePath, false));

    expect(await listPreservedWorktreesAsync(root, [])).toEqual([]);
  });

  it('requires explicit data-loss consent when stale Git metadata cannot be inspected', async () => {
    const root = initializeRepository();
    const worktreePath = join(root, '.aumx', 'worktrees', 'broken');
    mkdirSync(worktreePath);
    writeFileSync(join(worktreePath, '.git'), 'gitdir: /missing/worktree/metadata\n');
    writeFileSync(join(worktreePath, 'possibly-important.txt'), 'unknown state\n');

    await expect(removePreservedWorktreeAsync(
      await removalOptions(root, worktreePath, false),
    )).rejects.toThrow('could not be verified');

    await removePreservedWorktreeAsync(await removalOptions(root, worktreePath, true));

    expect(await listPreservedWorktreesAsync(root, [])).toEqual([]);
  });

  it('requires explicit data-loss consent for a detached worktree', async () => {
    const root = initializeRepository();
    const worktreePath = createRegisteredWorktree(root, 'detached');
    execFileSync('git', ['checkout', '--detach'], { cwd: worktreePath, stdio: 'ignore' });

    const worktree = await inspectPreservedWorktreeAsync(root, [], worktreePath);

    expect(worktree).toMatchObject({
      branch: null,
      gitStatus: 'clean',
      registration: 'registered',
    });
    await expect(removePreservedWorktreeAsync({
      activeWorktreePaths: [],
      allowDataLoss: false,
      expectedState: toRemovalState(worktree),
      projectRoot: root,
      worktreePath,
    })).rejects.toThrow('detached HEAD');

    await removePreservedWorktreeAsync({
      activeWorktreePaths: [],
      allowDataLoss: true,
      expectedState: toRemovalState(worktree),
      projectRoot: root,
      worktreePath,
    });
    expect(await listPreservedWorktreesAsync(root, [])).toEqual([]);
  });

  it('requires explicit data-loss consent for an unregistered repository', async () => {
    const root = initializeRepository();
    const worktreePath = join(root, '.aumx', 'worktrees', 'standalone');
    mkdirSync(worktreePath);
    execFileSync('git', ['init', '--initial-branch=main'], {
      cwd: worktreePath,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.email', 'tests@aumx.local'], { cwd: worktreePath });
    execFileSync('git', ['config', 'user.name', 'Aumx Tests'], { cwd: worktreePath });
    writeFileSync(join(worktreePath, 'standalone.txt'), 'standalone\n');
    execFileSync('git', ['add', 'standalone.txt'], { cwd: worktreePath });
    execFileSync('git', ['commit', '-m', 'standalone'], {
      cwd: worktreePath,
      stdio: 'ignore',
    });

    const worktree = await inspectPreservedWorktreeAsync(root, [], worktreePath);

    expect(worktree).toMatchObject({
      branch: 'main',
      gitStatus: 'clean',
      registration: 'unregistered',
    });
    await expect(removePreservedWorktreeAsync({
      activeWorktreePaths: [],
      allowDataLoss: false,
      expectedState: toRemovalState(worktree),
      projectRoot: root,
      worktreePath,
    })).rejects.toThrow('not registered');

    await removePreservedWorktreeAsync({
      activeWorktreePaths: [],
      allowDataLoss: true,
      expectedState: toRemovalState(worktree),
      projectRoot: root,
      worktreePath,
    });
    expect(await listPreservedWorktreesAsync(root, [])).toEqual([]);
  });

  it('rejects removal when the inspected Git state changed before confirmation', async () => {
    const root = initializeRepository();
    const worktreePath = createRegisteredWorktree(root, 'state-changed');
    writeFileSync(join(worktreePath, 'important.txt'), 'uncommitted\n');
    const inspected = await inspectPreservedWorktreeAsync(root, [], worktreePath);
    execFileSync('git', ['checkout', '--detach'], { cwd: worktreePath, stdio: 'ignore' });
    const options: RemovePreservedWorktreeOptions = {
      activeWorktreePaths: [],
      allowDataLoss: true,
      expectedState: toRemovalState(inspected),
      projectRoot: root,
      worktreePath,
    };

    await expect(removePreservedWorktreeAsync(options))
      .rejects.toThrow('changed since it was inspected');
  });
});
