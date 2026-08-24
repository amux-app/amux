import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerFileHandlers } from '../src/main/ipc/file.handlers';
import { IPC } from '../src/shared/ipc-channels';
import type { FileMoveRequest, FileMoveResponse } from '../src/shared/ipc-types';

const secureHandleMock = vi.hoisted(() => vi.fn());
const execFileAsync = promisify(execFile);

/** Hooks let a test simulate a lost race or an unremovable source without mocking the filesystem. */
const fsHooks = vi.hoisted(() => ({
  beforeLink: null as null | (() => Promise<void>),
  beforeMkdir: null as null | ((path: string) => Promise<void>),
  unlinkFailsFor: null as null | ((path: string) => boolean),
}));

vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
    link: async (source: string, target: string) => {
      await fsHooks.beforeLink?.();
      return actual.link(source, target);
    },
    mkdir: async (path: string, options?: Parameters<typeof actual.mkdir>[1]) => {
      await fsHooks.beforeMkdir?.(String(path));
      return actual.mkdir(path, options);
    },
    unlink: async (path: string) => {
      if (fsHooks.unlinkFailsFor?.(String(path))) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return actual.unlink(path);
    },
  };
});

vi.mock('../src/main/ipc/ipc-security.js', () => ({
  secureHandle: (channel: string, handler: (...args: unknown[]) => unknown) =>
    secureHandleMock(channel, handler),
}));

vi.mock('electron', () => ({
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), trashItem: vi.fn() },
}));

function getMoveHandler(): (event: unknown, request: FileMoveRequest) => Promise<FileMoveResponse> {
  const registration = secureHandleMock.mock.calls.find(([channel]) => channel === IPC.FILE_MOVE);
  if (!registration) throw new Error('FILE_MOVE handler was not registered');
  return registration[1] as (event: unknown, request: FileMoveRequest) => Promise<FileMoveResponse>;
}

async function entryNames(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

describe('FILE_MOVE handler', () => {
  let rootPath = '';
  let move: (event: unknown, request: FileMoveRequest) => Promise<FileMoveResponse>;

  beforeEach(async () => {
    secureHandleMock.mockClear();
    fsHooks.beforeLink = null;
    fsHooks.beforeMkdir = null;
    fsHooks.unlinkFailsFor = null;
    rootPath = await mkdtemp(join(tmpdir(), 'aumx-file-move-'));
    registerFileHandlers({
      getPanes: () => [],
      getProjectRoot: () => rootPath,
      setFileWatchRoot: vi.fn(),
    } as never);
    move = getMoveHandler();

    await mkdir(join(rootPath, 'src', 'nested'), { recursive: true });
    await mkdir(join(rootPath, 'dest'), { recursive: true });
    await writeFile(join(rootPath, 'src', 'index.ts'), 'index');
    await writeFile(join(rootPath, 'src', 'nested', 'deep.ts'), 'deep');
    await writeFile(join(rootPath, 'notes.md'), 'notes');
  });

  afterEach(async () => {
    fsHooks.beforeLink = null;
    fsHooks.beforeMkdir = null;
    fsHooks.unlinkFailsFor = null;
    await rm(rootPath, { force: true, recursive: true });
  });

  it('moves a file into a subdirectory', async () => {
    // Act
    const response = await move({}, {
      destDir: 'dest',
      mode: 'move',
      rootPath,
      sourcePaths: ['notes.md'],
    });

    // Assert
    expect(response.results).toEqual([
      { finalPath: 'dest/notes.md', sourcePath: 'notes.md', status: 'succeeded' },
    ]);
    expect(await entryNames(join(rootPath, 'dest'))).toEqual(['notes.md']);
    expect(await entryNames(rootPath)).toEqual(['dest', 'src']);
  });

  it('moves a directory together with its children', async () => {
    // Act
    const response = await move({}, {
      destDir: 'dest',
      mode: 'move',
      rootPath,
      sourcePaths: ['src/nested'],
    });

    // Assert
    expect(response.results[0]).toEqual({
      finalPath: 'dest/nested',
      sourcePath: 'src/nested',
      status: 'succeeded',
    });
    expect(await entryNames(join(rootPath, 'dest', 'nested'))).toEqual(['deep.ts']);
    expect(await entryNames(join(rootPath, 'src'))).toEqual(['index.ts']);
  });

  it('leaves the source in place in copy mode', async () => {
    // Act
    const response = await move({}, {
      destDir: 'dest',
      mode: 'copy',
      rootPath,
      sourcePaths: ['src/index.ts'],
    });

    // Assert
    expect(response.results[0].status).toBe('succeeded');
    expect(await entryNames(join(rootPath, 'src'))).toEqual(['index.ts', 'nested']);
    expect(await entryNames(join(rootPath, 'dest'))).toEqual(['index.ts']);
  });

  it('moves a symlink as an entry of its own, even when its target is gone', async () => {
    // Arrange
    await symlink(join(rootPath, 'missing-target.ts'), join(rootPath, 'dangling.ts'));

    // Act
    const response = await move({}, {
      destDir: 'dest',
      mode: 'move',
      rootPath,
      sourcePaths: ['dangling.ts'],
    });

    // Assert
    expect(response.results[0]).toEqual({
      finalPath: 'dest/dangling.ts',
      sourcePath: 'dangling.ts',
      status: 'succeeded',
    });
    expect((await lstat(join(rootPath, 'dest', 'dangling.ts'))).isSymbolicLink()).toBe(true);
    expect(await entryNames(rootPath)).toEqual(['dest', 'notes.md', 'src']);
  });

  it('keeps a symlink to a directory as a symlink instead of following it', async () => {
    // Arrange
    await symlink(join(rootPath, 'src'), join(rootPath, 'src-link'));

    // Act
    const response = await move({}, {
      destDir: 'dest',
      mode: 'move',
      rootPath,
      sourcePaths: ['src-link'],
    });

    // Assert
    expect(response.results[0].status).toBe('succeeded');
    expect((await lstat(join(rootPath, 'dest', 'src-link'))).isSymbolicLink()).toBe(true);
    expect(await entryNames(join(rootPath, 'src'))).toEqual(['index.ts', 'nested']);
  });

  it('refuses to move a symlink onto an existing dangling symlink', async () => {
    // Arrange — `access` follows links and would report the destination absent.
    await symlink(join(rootPath, 'gone-a.ts'), join(rootPath, 'link.ts'));
    await symlink(join(rootPath, 'gone-b.ts'), join(rootPath, 'dest', 'link.ts'));

    // Act
    const response = await move({}, {
      destDir: 'dest',
      mode: 'move',
      rootPath,
      sourcePaths: ['link.ts'],
    });

    // Assert — the destination link is untouched and the source stays put.
    expect(response.results[0]).toMatchObject({ code: 'EEXIST', status: 'failed' });
    expect(await readlink(join(rootPath, 'dest', 'link.ts'))).toBe(join(rootPath, 'gone-b.ts'));
    expect(await readlink(join(rootPath, 'link.ts'))).toBe(join(rootPath, 'gone-a.ts'));
  });

  it('rejects a batch whose targets differ only by case', async () => {
    // Arrange — on a case-insensitive volume these are one entry, so the second would clobber.
    await mkdir(join(rootPath, 'x'));
    await mkdir(join(rootPath, 'y'));
    await writeFile(join(rootPath, 'x', 'Report.md'), 'upper');
    await writeFile(join(rootPath, 'y', 'report.md'), 'lower');

    // Act
    const response = await move({}, {
      destDir: 'dest',
      mode: 'move',
      rootPath,
      sourcePaths: ['x/Report.md', 'y/report.md'],
    });

    // Assert
    expect(response.code).toBe('DUPLICATE_TARGET');
    expect(await entryNames(join(rootPath, 'dest'))).toEqual([]);
  });

  it('rejects a source that escapes the authorized root', async () => {
    // Act
    const response = await move({}, {
      destDir: 'dest',
      mode: 'move',
      rootPath,
      sourcePaths: ['../../etc/passwd'],
    });

    // Assert
    expect(response.code).toBe('INVALID');
    expect(response.results).toEqual([]);
    expect(await entryNames(join(rootPath, 'dest'))).toEqual([]);
  });

  it('rejects moving a folder into its own child', async () => {
    // Act
    const response = await move({}, {
      destDir: 'src/nested',
      mode: 'move',
      rootPath,
      sourcePaths: ['src'],
    });

    // Assert
    expect(response.code).toBe('INVALID');
    expect(await entryNames(join(rootPath, 'src'))).toEqual(['index.ts', 'nested']);
  });

  it('normalizes a source list that contains both a folder and its child', async () => {
    // Act
    const response = await move({}, {
      destDir: 'dest',
      mode: 'move',
      rootPath,
      sourcePaths: ['src', 'src/index.ts'],
    });

    // Assert
    expect(response.results).toEqual([
      { finalPath: 'dest/src', sourcePath: 'src', status: 'succeeded' },
    ]);
    expect(await entryNames(join(rootPath, 'dest', 'src'))).toEqual(['index.ts', 'nested']);
  });

  it('rejects the whole request when two sources resolve to the same target', async () => {
    // Arrange
    await mkdir(join(rootPath, 'a'));
    await mkdir(join(rootPath, 'b'));
    await writeFile(join(rootPath, 'a', 'index.ts'), 'a');
    await writeFile(join(rootPath, 'b', 'index.ts'), 'b');

    // Act
    const response = await move({}, {
      destDir: 'dest',
      mode: 'move',
      rootPath,
      sourcePaths: ['a/index.ts', 'b/index.ts'],
    });

    // Assert
    expect(response.code).toBe('DUPLICATE_TARGET');
    expect(response.results).toEqual([]);
    expect(await entryNames(join(rootPath, 'dest'))).toEqual([]);
    expect(await entryNames(join(rootPath, 'a'))).toEqual(['index.ts']);
    expect(await entryNames(join(rootPath, 'b'))).toEqual(['index.ts']);
  });

  it('fails a move onto an existing name and keeps the source', async () => {
    // Arrange
    await writeFile(join(rootPath, 'dest', 'notes.md'), 'existing');

    // Act
    const response = await move({}, {
      destDir: 'dest',
      mode: 'move',
      rootPath,
      sourcePaths: ['notes.md'],
    });

    // Assert
    expect(response.results[0]).toMatchObject({ code: 'EEXIST', status: 'failed' });
    expect(await stat(join(rootPath, 'notes.md'))).toBeTruthy();
  });

  it('keeps both entries when a copy lands on an existing name', async () => {
    // Arrange
    await writeFile(join(rootPath, 'dest', 'notes.md'), 'existing');

    // Act
    const response = await move({}, {
      destDir: 'dest',
      mode: 'copy',
      rootPath,
      sourcePaths: ['notes.md'],
    });

    // Assert
    expect(response.results[0]).toEqual({
      finalPath: 'dest/notes copy.md',
      sourcePath: 'notes.md',
      status: 'succeeded',
    });
    expect(await entryNames(join(rootPath, 'dest'))).toEqual(['notes copy.md', 'notes.md']);
  });

  it('removes a partial destination and staging data when a copied tree is unreadable', async () => {
    // Arrange
    await chmod(join(rootPath, 'src', 'nested', 'deep.ts'), 0o000);

    // Act
    const response = await move({}, {
      destDir: 'dest',
      mode: 'copy',
      rootPath,
      sourcePaths: ['src'],
    });

    // Assert
    expect(response.results[0]).toMatchObject({ code: 'EACCES', status: 'failed' });
    expect(await entryNames(join(rootPath, 'dest'))).toEqual([]);
  });

  it('removes a partial destination and staging data when a copied tree contains a FIFO', async () => {
    // Arrange
    await execFileAsync('mkfifo', [join(rootPath, 'src', 'nested', 'events.pipe')]);

    // Act
    const response = await move({}, {
      destDir: 'dest',
      mode: 'copy',
      rootPath,
      sourcePaths: ['src'],
    });

    // Assert
    expect(response.results[0]).toMatchObject({ status: 'failed' });
    expect(await entryNames(join(rootPath, 'dest'))).toEqual([]);
  });

  it('does not overwrite a file created after copy preflight', async () => {
    // Arrange
    fsHooks.beforeLink = async () => {
      await writeFile(join(rootPath, 'dest', 'notes.md'), 'raced');
    };

    // Act
    const response = await move({}, {
      destDir: 'dest',
      mode: 'copy',
      rootPath,
      sourcePaths: ['notes.md'],
    });

    // Assert
    expect(response.results[0]).toMatchObject({ code: 'EEXIST', status: 'failed' });
    expect(await entryNames(join(rootPath, 'dest'))).toEqual(['notes.md']);
    expect(await readFile(join(rootPath, 'dest', 'notes.md'), 'utf8')).toBe('raced');
  });

  it('does not overwrite a directory created after copy preflight', async () => {
    // Arrange
    const racedTarget = join(rootPath, 'dest', 'nested');
    fsHooks.beforeMkdir = async (path) => {
      if (!path.endsWith('/dest/nested')) return;
      fsHooks.beforeMkdir = null;
      await mkdir(path);
      await writeFile(join(path, 'raced.txt'), 'raced');
    };

    // Act
    const response = await move({}, {
      destDir: 'dest',
      mode: 'copy',
      rootPath,
      sourcePaths: ['src/nested'],
    });

    // Assert
    expect(response.results[0]).toMatchObject({ code: 'EEXIST', status: 'failed' });
    expect(await entryNames(racedTarget)).toEqual(['raced.txt']);
    expect(await entryNames(join(rootPath, 'dest'))).toEqual(['nested']);
  });

  it('does not overwrite a directory created after move preflight', async () => {
    // Arrange
    fsHooks.beforeMkdir = async (path) => {
      if (!path.endsWith('/dest/nested')) return;
      fsHooks.beforeMkdir = null;
      await mkdir(path);
    };

    // Act
    const response = await move({}, {
      destDir: 'dest',
      mode: 'move',
      rootPath,
      sourcePaths: ['src/nested'],
    });

    // Assert
    expect(response.results[0]).toMatchObject({ code: 'EEXIST', status: 'failed' });
    expect(await entryNames(join(rootPath, 'src', 'nested'))).toEqual(['deep.ts']);
    expect(await entryNames(join(rootPath, 'dest'))).toEqual(['nested']);
  });

  it('does not collide with a user-owned file resembling a staging name', async () => {
    // Arrange
    await writeFile(join(rootPath, 'dest', '.aumx-copy-notes.md'), 'user data');

    // Act
    const response = await move({}, {
      destDir: 'dest',
      mode: 'copy',
      rootPath,
      sourcePaths: ['notes.md'],
    });

    // Assert
    expect(response.results[0]).toMatchObject({ finalPath: 'dest/notes.md', status: 'succeeded' });
    expect(await entryNames(join(rootPath, 'dest'))).toEqual(['.aumx-copy-notes.md', 'notes.md']);
    expect(await readFile(join(rootPath, 'dest', '.aumx-copy-notes.md'), 'utf8')).toBe('user data');
  });

  it('reports one result per source when the middle item fails', async () => {
    // Arrange
    await writeFile(join(rootPath, 'first.ts'), 'first');
    await writeFile(join(rootPath, 'third.ts'), 'third');
    await writeFile(join(rootPath, 'dest', 'second.ts'), 'existing');
    await writeFile(join(rootPath, 'second.ts'), 'second');

    // Act
    const response = await move({}, {
      destDir: 'dest',
      mode: 'move',
      rootPath,
      sourcePaths: ['first.ts', 'second.ts', 'third.ts'],
    });

    // Assert
    expect(response.results).toHaveLength(3);
    const bySource = new Map(response.results.map((result) => [result.sourcePath, result.status]));
    expect(bySource.get('first.ts')).toBe('succeeded');
    expect(bySource.get('second.ts')).toBe('failed');
    expect(bySource.get('third.ts')).toBe('succeeded');
    expect(await entryNames(rootPath)).toEqual(['dest', 'notes.md', 'second.ts', 'src']);
  });

  it('does not overwrite a target created between preflight and apply', async () => {
    // Arrange
    fsHooks.beforeLink = async () => {
      await writeFile(join(rootPath, 'dest', 'notes.md'), 'raced');
    };

    // Act
    const response = await move({}, {
      destDir: 'dest',
      mode: 'move',
      rootPath,
      sourcePaths: ['notes.md'],
    });

    // Assert
    expect(response.results[0]).toMatchObject({ code: 'EEXIST', status: 'failed' });
    expect(await stat(join(rootPath, 'notes.md'))).toBeTruthy();
  });

  it('rolls the target back when the source cannot be removed', async () => {
    // Arrange
    fsHooks.unlinkFailsFor = (path) => path.endsWith('/notes.md') && !path.includes('/dest/');

    // Act
    const response = await move({}, {
      destDir: 'dest',
      mode: 'move',
      rootPath,
      sourcePaths: ['notes.md'],
    });

    // Assert
    expect(response.results[0]).toMatchObject({ code: 'EACCES', status: 'failed' });
    expect(await stat(join(rootPath, 'notes.md'))).toBeTruthy();
    expect(await entryNames(join(rootPath, 'dest'))).toEqual([]);
  });

  it('reports a partial move when the rollback also fails', async () => {
    // Arrange
    fsHooks.unlinkFailsFor = () => true;

    // Act
    const response = await move({}, {
      destDir: 'dest',
      mode: 'move',
      rootPath,
      sourcePaths: ['notes.md'],
    });

    // Assert
    expect(response.results[0]).toMatchObject({
      finalPath: 'dest/notes.md',
      sourcePath: 'notes.md',
      status: 'partial',
    });
    expect(await stat(join(rootPath, 'notes.md'))).toBeTruthy();
    expect(await stat(join(rootPath, 'dest', 'notes.md'))).toBeTruthy();
  });
});
