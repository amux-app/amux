import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import type { FileListRequest, FileListResponse } from '../src/shared/ipc-types';
import {
  createPathCompletionSource,
  parseLiteralIgnorePath,
} from '../src/renderer/components/file-browser/pathCompletion';
import { afterEach, describe, expect, it, vi } from 'vitest';

type ListDirectory = (request: FileListRequest) => Promise<FileListResponse>;

function contextFor(value: string, explicit = true): CompletionContext {
  return new CompletionContext(EditorState.create({ doc: value }), value.length, explicit);
}

function entries(...names: string[]): FileListResponse {
  return {
    entries: names.map((name) => ({
      isDirectory: name.endsWith('/'),
      name: name.endsWith('/') ? name.slice(0, -1) : name,
      path: name,
    })),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('pathCompletion', () => {
  it('parses literal prefixes and replaces only the active segment', () => {
    expect(parseLiteralIgnorePath('!src/fi')).toEqual({
      directoryPath: 'src',
      from: 5,
      rooted: false,
      segment: 'fi',
    });
    expect(parseLiteralIgnorePath('/src/fi')).toEqual({
      directoryPath: 'src',
      from: 5,
      rooted: true,
      segment: 'fi',
    });
    expect(parseLiteralIgnorePath('folder/')).toEqual({
      directoryPath: 'folder',
      from: 7,
      rooted: false,
      segment: '',
    });
  });

  it.each([
    '# comment',
    'src/*',
    'src/?',
    'src/[a]',
    'src\\file',
    'src//file',
    './file',
    '../file',
    'src/../file',
  ])('rejects unsupported ignore syntax: %s', (value) => {
      expect(parseLiteralIgnorePath(value)).toBeNull();
  });

  it('lists the containing directory for root and nested ignore files', async () => {
    const requests: FileListRequest[] = [];
    const listDirectory: ListDirectory = async (request) => {
      requests.push(request);
      return entries('src/', 'README.md');
    };
    const rootSource = createPathCompletionSource('/project', '.gitignore', listDirectory);
    const nestedSource = createPathCompletionSource('/project', 'desktop/.gitignore', listDirectory);

    const rootResult = await rootSource(contextFor('sr'));
    const nestedResult = await nestedSource(contextFor('ch'));

    expect(requests).toEqual([
      { rootPath: '/project' },
      { dirPath: 'desktop', rootPath: '/project' },
    ]);
    expect(rootResult?.from).toBe(0);
    expect(rootResult?.options).toEqual([
      { apply: 'src/', boost: 1, detail: 'directory', label: 'src', type: 'folder' },
      { label: 'README.md', type: 'file' },
    ]);
    expect(nestedResult?.from).toBe(0);
  });

  it('chains accepted directory prefixes and preserves literal markers', async () => {
    const requests: FileListRequest[] = [];
    const listDirectory: ListDirectory = async (request) => {
      requests.push(request);
      return entries('child/', 'child file.txt');
    };
    const source = createPathCompletionSource('/project', 'desktop/.gitignore', listDirectory);

    const nestedResult = await source(contextFor('child/'));
    const negatedResult = await source(contextFor('!child/fi'));
    const rootedResult = await source(contextFor('/child/fi'));

    expect(requests).toEqual([
      { dirPath: 'desktop/child', rootPath: '/project' },
      { dirPath: 'child', rootPath: '/project' },
    ]);
    expect(nestedResult?.from).toBe(6);
    expect(negatedResult?.from).toBe(7);
    expect(rootedResult?.from).toBe(7);
  });

  it('uses a five-second, fifty-directory listing cache', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const listDirectory: ListDirectory = async () => {
      calls += 1;
      return entries('entry.txt');
    };
    const source = createPathCompletionSource('/project', '.gitignore', listDirectory);

    await source(contextFor('dir/one'));
    await source(contextFor('dir/two'));
    expect(calls).toBe(1);

    vi.advanceTimersByTime(4_999);
    await source(contextFor('dir/three'));
    expect(calls).toBe(1);

    vi.advanceTimersByTime(1);
    await source(contextFor('dir/four'));
    expect(calls).toBe(2);

    for (let index = 0; index < 50; index += 1) {
      await source(contextFor(`dir-${index}/file`));
    }
    expect(calls).toBe(52);
    await source(contextFor(''));
    expect(calls).toBe(53);
  });

  it('returns null for errors and aborted requests, and limits valid input to literal segments', async () => {
    const errorSource = createPathCompletionSource('/project', '.gitignore', async () => ({
      entries: [],
      error: 'permission denied',
    }));
    expect(await errorSource(contextFor('src'))).toBeNull();
    const rejectedSource = createPathCompletionSource('/project', '.gitignore', async () => {
      throw new Error('IPC unavailable');
    });
    expect(await rejectedSource(contextFor('src'))).toBeNull();

    let resolveListing: (response: FileListResponse) => void = () => undefined;
    const pending = new Promise<FileListResponse>((resolve) => {
      resolveListing = resolve;
    });
    const abortedSource = createPathCompletionSource('/project', '.gitignore', async () => pending);
    const context = contextFor('src');
    const resultPromise = abortedSource(context);
    Object.defineProperty(context, 'aborted', { value: true });
    resolveListing(entries('src/'));

    expect(await resultPromise).toBeNull();
    const validResult = await createPathCompletionSource('/project', '.gitignore', async () => entries('file.txt'))(
      contextFor('file name'),
    );
    expect(validResult?.validFor?.('file name', 0, 9, EditorState.create({ doc: 'file name' }))).toBe(true);
    expect(validResult?.validFor?.('file/name', 0, 9, EditorState.create({ doc: 'file/name' }))).toBe(false);
  });

  it('forces a fresh query for unsupported dot segments after a cached result', async () => {
    const source = createPathCompletionSource('/project', '.gitignore', async () => entries('file.txt'));
    const result = await source(contextFor('fi'));

    expect(result?.validFor?.('.', 0, 1, EditorState.create({ doc: '.' }))).toBe(false);
    expect(result?.validFor?.('..', 0, 2, EditorState.create({ doc: '..' }))).toBe(false);
  });
});
