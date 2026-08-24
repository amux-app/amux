import { beforeEach, describe, expect, it, vi } from 'vitest';
import { moveFiles } from '../src/renderer/api/file.api';
import { IPC } from '../src/shared/ipc-channels';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('../src/renderer/api/ipc.js', () => ({
  invoke: invokeMock,
}));

vi.mock('../src/renderer/lib/rendererLog', () => ({
  rendererLog: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const ROOT = '/repo';

function request(sourcePaths: string[]) {
  return { destDir: 'dest', mode: 'move' as const, rootPath: ROOT, sourcePaths };
}

describe('moveFiles', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('normalizes nested sources before sending and accepts the matching response', async () => {
    // Arrange
    invokeMock.mockResolvedValue({
      results: [{ finalPath: 'dest/src', sourcePath: 'src', status: 'succeeded' }],
    });

    // Act
    const response = await moveFiles(request(['src', 'src/index.ts']));

    // Assert
    expect(invokeMock).toHaveBeenCalledWith(IPC.FILE_MOVE, {
      destDir: 'dest',
      mode: 'move',
      rootPath: ROOT,
      sourcePaths: ['src'],
    });
    expect(response.results).toHaveLength(1);
    expect(response.error).toBeUndefined();
  });

  it('rejects a succeeded result that carries no final path', async () => {
    // Arrange
    invokeMock.mockResolvedValue({ results: [{ sourcePath: 'a.ts', status: 'succeeded' }] });

    // Act
    const response = await moveFiles(request(['a.ts']));

    // Assert
    expect(response).toEqual({ results: [], code: 'UNKNOWN', error: 'Invalid file move response' });
  });

  it('rejects a response with a duplicated source path', async () => {
    // Arrange
    invokeMock.mockResolvedValue({
      results: [
        { finalPath: 'dest/a.ts', sourcePath: 'a.ts', status: 'succeeded' },
        { finalPath: 'dest/a.ts', sourcePath: 'a.ts', status: 'succeeded' },
      ],
    });

    // Act
    const response = await moveFiles(request(['a.ts', 'b.ts']));

    // Assert
    expect(response.code).toBe('UNKNOWN');
    expect(response.results).toEqual([]);
  });

  it('rejects a response that is missing one of the requested sources', async () => {
    // Arrange
    invokeMock.mockResolvedValue({
      results: [{ finalPath: 'dest/a.ts', sourcePath: 'a.ts', status: 'succeeded' }],
    });

    // Act
    const response = await moveFiles(request(['a.ts', 'b.ts']));

    // Assert
    expect(response.code).toBe('UNKNOWN');
  });

  it('accepts a preflight rejection that reports no results', async () => {
    // Arrange
    invokeMock.mockResolvedValue({
      code: 'DUPLICATE_TARGET',
      error: 'Two items would land on the same name',
      results: [],
    });

    // Act
    const response = await moveFiles(request(['a/index.ts', 'b/index.ts']));

    // Assert
    expect(response).toEqual({
      code: 'DUPLICATE_TARGET',
      error: 'Two items would land on the same name',
      results: [],
    });
  });

  it('rejects a response that reports results and a top-level error at once', async () => {
    // Arrange — the filesystem changed, but the verdict says it did not; the two cannot both hold.
    invokeMock.mockResolvedValue({
      code: 'UNKNOWN',
      error: 'something went wrong',
      results: [{ finalPath: 'dest/a.ts', sourcePath: 'a.ts', status: 'succeeded' }],
    });

    // Act
    const response = await moveFiles(request(['a.ts']));

    // Assert
    expect(response).toEqual({ results: [], code: 'UNKNOWN', error: 'Invalid file move response' });
  });

  it('rejects a rejection that gives no reason', async () => {
    invokeMock.mockResolvedValue({ code: 'DUPLICATE_TARGET', results: [] });

    expect((await moveFiles(request(['a.ts']))).error).toBe('Invalid file move response');
  });

  it('rejects a failed item whose error message is empty', async () => {
    invokeMock.mockResolvedValue({
      results: [{ code: 'EEXIST', error: '', sourcePath: 'a.ts', status: 'failed' }],
    });

    expect((await moveFiles(request(['a.ts']))).error).toBe('Invalid file move response');
  });

  it('keeps a partial result that reports both a final path and an error', async () => {
    // Arrange
    invokeMock.mockResolvedValue({
      results: [{
        code: 'EACCES',
        error: 'permission denied',
        finalPath: 'dest/a.ts',
        sourcePath: 'a.ts',
        status: 'partial',
      }],
    });

    // Act
    const response = await moveFiles(request(['a.ts']));

    // Assert
    expect(response.results[0]).toMatchObject({ finalPath: 'dest/a.ts', status: 'partial' });
  });
});
