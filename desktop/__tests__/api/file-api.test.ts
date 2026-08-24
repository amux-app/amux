import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDir,
  createFile,
  deleteFile,
  formatFileContent,
  listFiles,
  moveFiles,
  readFileBinary,
  readFileContent,
  renameFile,
  writeFileContent,
} from '../../src/renderer/api/file.api';
import { IPC } from '../../src/shared/ipc-channels';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/renderer/api/ipc.js', () => ({ invoke: invokeMock }));

describe('file API response validation', () => {
  beforeEach(() => invokeMock.mockReset());

  it('keeps valid entries and reports invalid list payloads safely', async () => {
    invokeMock.mockResolvedValueOnce({
      entries: [
        { isDirectory: true, name: 'src', path: 'src' },
        { isDirectory: 'yes', name: 'bad', path: 'bad' },
      ],
    });
    await expect(listFiles({ rootPath: '/repo', relativePath: '' })).resolves.toEqual({
      entries: [{ isDirectory: true, name: 'src', path: 'src' }],
      error: undefined,
    });

    invokeMock.mockResolvedValueOnce({ invalid: true });
    await expect(listFiles({ rootPath: '/repo', relativePath: '' })).resolves.toEqual({
      entries: [],
      error: 'Invalid file list response',
    });
  });

  it('returns safe fallbacks for malformed read, binary, and mutation responses', async () => {
    invokeMock.mockResolvedValueOnce({ kind: 'editable-text' });
    await expect(readFileContent({ rootPath: '/repo', relativePath: 'a.ts' })).resolves.toEqual({
      code: 'IO_ERROR',
      kind: 'error',
      message: 'Invalid file read response',
    });

    invokeMock.mockResolvedValueOnce({ data: 42 });
    await expect(readFileBinary({ rootPath: '/repo', relativePath: 'a.bin' })).resolves.toEqual({
      data: '',
      error: 'Invalid file read binary response',
      mimeType: 'application/octet-stream',
    });

    invokeMock.mockResolvedValueOnce({ success: 'yes' });
    await expect(createFile({ rootPath: '/repo', relativePath: 'a.ts' })).resolves.toEqual({
      error: 'Invalid file create response',
      success: false,
    });
  });

  it('preserves write and formatter request identity in invalid-response fallbacks', async () => {
    const writeRequest = {
      content: 'next',
      documentVersion: 4,
      editorSessionId: 'editor-1',
      relativePath: 'src/a.ts',
      rootPath: '/repo',
      saveSequence: 9,
    };
    invokeMock.mockResolvedValueOnce(null);
    await expect(writeFileContent(writeRequest)).resolves.toEqual({
      documentVersion: 4,
      editorSessionId: 'editor-1',
      error: 'Invalid file write response',
      saveSequence: 9,
      success: false,
    });

    const formatRequest = {
      content: 'const x=1',
      documentVersion: 4,
      editorSessionId: 'editor-1',
      eol: 'lf' as const,
      fileKey: 'src/a.ts',
      relativePath: 'src/a.ts',
      requestId: 'request-1',
      rootPath: '/repo',
    };
    invokeMock.mockResolvedValueOnce({ success: true });
    await expect(formatFileContent(formatRequest)).resolves.toEqual({
      code: 'INVALID_RESPONSE',
      documentVersion: 4,
      editorSessionId: 'editor-1',
      error: 'Invalid formatter response',
      fileKey: 'src/a.ts',
      requestId: 'request-1',
      success: false,
    });
  });

  it('validates normalized move responses and forwards normalized source paths', async () => {
    invokeMock.mockResolvedValueOnce({
      results: [{ finalPath: 'dest/a.ts', sourcePath: 'src/a.ts', status: 'succeeded' }],
    });
    await expect(
      moveFiles({
        destDir: 'dest',
        mode: 'move',
        rootPath: '/repo',
        sourcePaths: ['src/a.ts'],
      }),
    ).resolves.toEqual({
      results: [{ finalPath: 'dest/a.ts', sourcePath: 'src/a.ts', status: 'succeeded' }],
    });
    expect(invokeMock).toHaveBeenCalledWith(IPC.FILE_MOVE, expect.objectContaining({ sourcePaths: ['src/a.ts'] }));

    invokeMock.mockResolvedValueOnce({
      results: [{ sourcePath: 'src/a.ts', status: 'unknown' }],
    });
    await expect(
      moveFiles({
        destDir: 'dest',
        mode: 'move',
        rootPath: '/repo',
        sourcePaths: ['src/a.ts'],
      }),
    ).resolves.toEqual({
      code: 'UNKNOWN',
      error: 'Invalid file move response',
      results: [],
    });
  });

  it.each([
    ['create-dir', createDir, IPC.FILE_CREATE_DIR],
    ['delete', deleteFile, IPC.FILE_DELETE],
    ['rename', renameFile, IPC.FILE_RENAME],
  ])('uses the safe mutation fallback for %s', async (_name, operation, channel) => {
    invokeMock.mockResolvedValue({ nope: true });
    await expect(operation({ rootPath: '/repo', relativePath: 'a.ts' } as never)).resolves.toEqual({
      error: expect.stringContaining('Invalid file'),
      success: false,
    });
    expect(invokeMock).toHaveBeenCalledWith(channel, expect.anything());
  });
});
