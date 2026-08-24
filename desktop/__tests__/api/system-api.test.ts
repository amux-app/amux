import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchProjectFiles, searchProjectText } from '../../src/renderer/api/system.api';
import { IPC } from '../../src/shared/ipc-channels';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/api/ipc.js', () => ({ invoke: invokeMock }));

describe('system API search response validation', () => {
  beforeEach(() => invokeMock.mockReset());

  it('filters malformed file-search entries and forwards the requested root', async () => {
    invokeMock.mockResolvedValue([
      { filename: 'App.tsx', path: 'src/App.tsx', rootPath: '/repo' },
      { filename: 42, path: 'bad', rootPath: '/repo' },
    ]);

    await expect(searchProjectFiles('app', '/repo')).resolves.toEqual([
      { filename: 'App.tsx', path: 'src/App.tsx', rootPath: '/repo' },
    ]);
    expect(invokeMock).toHaveBeenCalledWith(IPC.PROJECT_FILE_SEARCH, {
      query: 'app',
      rootPath: '/repo',
    });
  });

  it('returns an empty result for malformed search payloads', async () => {
    invokeMock.mockResolvedValue({ results: [] });
    await expect(searchProjectText('needle')).resolves.toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith(IPC.PROJECT_TEXT_SEARCH, {
      query: 'needle',
      rootPath: undefined,
    });
  });

  it('caps validated text results at the renderer trust boundary', async () => {
    invokeMock.mockResolvedValue(
      Array.from({ length: 51 }, (_, index) => ({
        filename: `file-${index}.ts`,
        lineContent: 'needle',
        lineNumber: index + 1,
        path: `src/file-${index}.ts`,
        rootPath: '/repo',
      })),
    );
    await expect(searchProjectText('needle', '/repo')).resolves.toHaveLength(50);
  });
});
