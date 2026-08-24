import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerFileHandlers } from '../../src/main/ipc/file.handlers';
import { IPC } from '../../src/shared/ipc-channels';

const secureHandleMock = vi.hoisted(() => vi.fn());
const trashItemMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/main/ipc/ipc-security.js', () => ({
  secureHandle: (
    channel: string,
    handler: (...args: unknown[]) => unknown,
  ) => secureHandleMock(channel, handler),
}));

vi.mock('electron', () => ({
  shell: {
    openPath: vi.fn(),
    showItemInFolder: vi.fn(),
    trashItem: trashItemMock,
  },
}));

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const registration = secureHandleMock.mock.calls.find(([registered]) => registered === channel);
  if (!registration) throw new Error(`missing handler registration for ${channel}`);
  return registration[1] as (...args: unknown[]) => unknown;
}

function contentVersion(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function versionedWrite(overrides: Record<string, unknown> = {}) {
  return {
    content: 'after',
    documentVersion: 1,
    editorSessionId: 'editor-session-1',
    eol: 'lf',
    expectedContentVersion: contentVersion('before'),
    hasBom: false,
    relativePath: 'notes.ts',
    rootPath: '',
    saveSequence: 1,
    ...overrides,
  };
}

describe('file IPC handlers', () => {
  let rootPath = '';

  beforeEach(async () => {
    secureHandleMock.mockClear();
    trashItemMock.mockReset().mockImplementation((path: string) => unlink(path));
    rootPath = await mkdtemp(join(tmpdir(), 'aumx-file-handlers-'));
    registerFileHandlers({
      getPanes: () => [],
      getProjectRoot: () => rootPath,
      setFileWatchRoot: vi.fn(),
    } as never);
  });

  afterEach(async () => {
    await rm(rootPath, { force: true, recursive: true });
  });

  it('recreates a deleted file only while it is still missing', async () => {
    const write = getHandler(IPC.FILE_WRITE);
    const request = versionedWrite({
      content: 'preserved local draft',
      expectedContentVersion: null,
      expectedMissing: true,
      relativePath: 'notes.ts',
      rootPath,
    });

    await expect(write(undefined, request)).resolves.toMatchObject({
      success: true,
    });
    await expect(readFile(join(rootPath, 'notes.ts'), 'utf8')).resolves.toBe('preserved local draft');

    await expect(write(undefined, {
      ...request,
      content: 'must not overwrite',
    })).resolves.toMatchObject({
      conflict: true,
      conflictType: 'modified',
      success: false,
    });
    await expect(readFile(join(rootPath, 'notes.ts'), 'utf8')).resolves.toBe('preserved local draft');
  });

  it('recreates a deleted file after its parent directory was removed', async () => {
    // Arrange
    await mkdir(join(rootPath, 'nested/deep'), { recursive: true });
    await writeFile(join(rootPath, 'nested/deep/notes.ts'), 'original', 'utf8');
    await rm(join(rootPath, 'nested'), { force: true, recursive: true });
    const write = getHandler(IPC.FILE_WRITE);

    // Act
    const result = await write(undefined, versionedWrite({
      content: 'preserved local draft',
      expectedContentVersion: null,
      expectedMissing: true,
      relativePath: 'nested/deep/notes.ts',
      rootPath,
    }));

    // Assert
    expect(result).toMatchObject({ success: true });
    await expect(readFile(join(rootPath, 'nested/deep/notes.ts'), 'utf8'))
      .resolves.toBe('preserved local draft');
  });

  it('atomically replaces an existing file without dropping its executable mode', async () => {
    const target = join(rootPath, 'script.sh');
    await writeFile(target, '#!/bin/sh\necho before\n', 'utf8');
    await chmod(target, 0o755);
    const write = getHandler(IPC.FILE_WRITE);

    await expect(write(undefined, versionedWrite({
      content: '#!/bin/sh\necho after\n',
      expectedContentVersion: contentVersion('#!/bin/sh\necho before\n'),
      relativePath: 'script.sh',
      rootPath,
    }))).resolves.toMatchObject({ success: true });

    await expect(readFile(target, 'utf8')).resolves.toBe('#!/bin/sh\necho after\n');
    expect((await stat(target)).mode & 0o777).toBe(0o755);
  });

  it('saves through an existing symlink without replacing the link', async () => {
    const target = join(rootPath, 'target.ts');
    const alias = join(rootPath, 'alias.ts');
    await writeFile(target, 'before', 'utf8');
    await symlink('target.ts', alias);
    const write = getHandler(IPC.FILE_WRITE);

    await expect(write(undefined, versionedWrite({
      content: 'after',
      expectedContentVersion: contentVersion('before'),
      relativePath: 'alias.ts',
      rootPath,
    }))).resolves.toMatchObject({ success: true });

    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    await expect(readFile(target, 'utf8')).resolves.toBe('after');
    await expect(readFile(alias, 'utf8')).resolves.toBe('after');
  });

  it('deletes and renames the symlink itself', async () => {
    const target = join(rootPath, 'target.ts');
    const alias = join(rootPath, 'alias.ts');
    await writeFile(target, 'preserved', 'utf8');
    await symlink('target.ts', alias);
    const renameHandler = getHandler(IPC.FILE_RENAME);
    const deleteHandler = getHandler(IPC.FILE_DELETE);

    await expect(renameHandler(undefined, {
      newPath: 'renamed.ts',
      oldPath: 'alias.ts',
      rootPath,
    })).resolves.toMatchObject({ success: true });

    const renamed = join(rootPath, 'renamed.ts');
    expect((await lstat(renamed)).isSymbolicLink()).toBe(true);
    await expect(readFile(target, 'utf8')).resolves.toBe('preserved');

    await expect(deleteHandler(undefined, {
      relativePath: 'renamed.ts',
      rootPath,
    })).resolves.toMatchObject({ success: true });

    expect(trashItemMock).toHaveBeenCalledWith(
      join(await realpath(rootPath), 'renamed.ts'),
    );
    await expect(lstat(renamed)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(target, 'utf8')).resolves.toBe('preserved');
  });

  it('blocks a symlink whose target is outside the authorized root', async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'aumx-file-outside-'));
    const outsideTarget = join(outsideRoot, 'outside.ts');
    await writeFile(outsideTarget, 'outside', 'utf8');
    await symlink(outsideTarget, join(rootPath, 'alias.ts'));
    const write = getHandler(IPC.FILE_WRITE);

    await expect(write(undefined, versionedWrite({
      content: 'must not write',
      expectedContentVersion: contentVersion('outside'),
      relativePath: 'alias.ts',
      rootPath,
    }))).resolves.toMatchObject({ success: false });

    await expect(readFile(outsideTarget, 'utf8')).resolves.toBe('outside');
    await rm(outsideRoot, { force: true, recursive: true });
  });

  it('reports a broken symlink as a deleted-file conflict', async () => {
    const alias = join(rootPath, 'alias.ts');
    await symlink('missing-target.ts', alias);
    const write = getHandler(IPC.FILE_WRITE);

    await expect(write(undefined, versionedWrite({
      content: 'local draft',
      expectedContentVersion: contentVersion('missing'),
      relativePath: 'alias.ts',
      rootPath,
    }))).resolves.toMatchObject({
      conflict: true,
      conflictType: 'deleted',
      success: false,
    });

    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
  });

  it('treats a reappeared symlink as an expected-missing conflict', async () => {
    await writeFile(join(rootPath, 'target.ts'), 'target', 'utf8');
    const alias = join(rootPath, 'alias.ts');
    await symlink('target.ts', alias);
    const write = getHandler(IPC.FILE_WRITE);

    await expect(write(undefined, versionedWrite({
      content: 'must not overwrite',
      expectedContentVersion: null,
      expectedMissing: true,
      relativePath: 'alias.ts',
      rootPath,
    }))).resolves.toMatchObject({
      conflict: true,
      conflictType: 'modified',
      success: false,
    });

    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    await expect(readFile(join(rootPath, 'target.ts'), 'utf8')).resolves.toBe('target');
  });

  it('returns the exact-byte editable read contract', async () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('alpha\r\nbeta\r\n', 'utf8'),
    ]);
    await writeFile(join(rootPath, 'notes.ts'), bytes);
    const read = getHandler(IPC.FILE_READ);

    await expect(read(undefined, { relativePath: 'notes.ts', rootPath })).resolves.toEqual({
      kind: 'editable-text',
      content: 'alpha\r\nbeta\r\n',
      contentVersion: contentVersion(bytes),
      encoding: 'utf8',
      eol: 'crlf',
      hasBom: true,
    });
  });

  it('returns stable read error variants without leaking filesystem details', async () => {
    const read = getHandler(IPC.FILE_READ);

    await expect(read(undefined, { relativePath: 'missing.ts', rootPath })).resolves.toEqual({
      kind: 'error',
      code: 'NOT_FOUND',
      message: 'File not found',
    });
  });

  it('echoes save identity and publishes the exact encoded bytes and hash', async () => {
    await writeFile(join(rootPath, 'notes.ts'), 'before', 'utf8');
    const write = getHandler(IPC.FILE_WRITE);

    const result = await write(undefined, versionedWrite({
      content: 'after\r\n',
      eol: 'crlf',
      hasBom: true,
      rootPath,
    }));
    const expectedBytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('after\r\n', 'utf8'),
    ]);

    expect(result).toEqual({
      success: true,
      contentVersion: contentVersion(expectedBytes),
      documentVersion: 1,
      editorSessionId: 'editor-session-1',
      saveSequence: 1,
    });
    await expect(readFile(join(rootPath, 'notes.ts'))).resolves.toEqual(expectedBytes);
  });

  it('detects a same-length external rewrite even when mtime is restored', async () => {
    const target = join(rootPath, 'notes.ts');
    await writeFile(target, 'before', 'utf8');
    const originalTimes = await stat(target);
    await writeFile(target, 'mutate', 'utf8');
    await utimes(target, originalTimes.atime, originalTimes.mtime);
    const write = getHandler(IPC.FILE_WRITE);

    await expect(write(undefined, versionedWrite({ rootPath }))).resolves.toMatchObject({
      conflict: true,
      conflictType: 'modified',
      currentContentVersion: contentVersion('mutate'),
      documentVersion: 1,
      editorSessionId: 'editor-session-1',
      saveSequence: 1,
      success: false,
    });
    await expect(readFile(target, 'utf8')).resolves.toBe('mutate');
  });

  it('serializes competing editor sessions for the same canonical file', async () => {
    await writeFile(join(rootPath, 'notes.ts'), 'before', 'utf8');
    const write = getHandler(IPC.FILE_WRITE);

    const [first, second] = await Promise.all([
      write(undefined, versionedWrite({ content: 'first', rootPath })),
      write(undefined, versionedWrite({
        content: 'second',
        editorSessionId: 'editor-session-2',
        rootPath,
      })),
    ]);

    expect([first, second].filter((result) => (result as { success: boolean }).success)).toHaveLength(1);
    expect([first, second].filter((result) => !(result as { success: boolean }).success)).toHaveLength(1);
  });

  it('removes atomic-write temp files after a conflict', async () => {
    await writeFile(join(rootPath, 'notes.ts'), 'external', 'utf8');
    const write = getHandler(IPC.FILE_WRITE);

    await write(undefined, versionedWrite({ rootPath }));

    expect((await readdir(rootPath)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
