// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry, FileListResponse, FileReadResponse } from '../../src/shared/ipc-types';
import { useFileBrowserStore } from '../../src/renderer/stores/file-browser.store';

const fileApi = vi.hoisted(() => ({
  listFiles: vi.fn(),
  readFileContent: vi.fn(),
}));

vi.mock('../../src/renderer/api/file.api', () => fileApi);

function file(name: string, path = name): FileEntry {
  return { name, path, isDirectory: false };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (!resolvePromise) {
    throw new Error('Deferred promise was not initialized');
  }
  return { promise, resolve: resolvePromise };
}

function editableText(content: string): FileReadResponse {
  return {
    kind: 'editable-text',
    content,
    contentVersion: `hash-${content}`,
    encoding: 'utf8',
    eol: 'lf',
    hasBom: false,
  };
}

describe('useFileBrowserStore', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    useFileBrowserStore.setState({
      clipboard: null,
      draftResetKey: 0,
      expandedDirs: {},
      findInFileRequestKey: 0,
      folderColors: {},
      isOpen: true,
      pendingFileSaveHandler: null,
      trees: {},
      viewerCrowded: false,
      viewingFile: null,
    });
  });

  it('runs the latest directory refresh after an overlapping load finishes', async () => {
    // Arrange
    const firstLoad = deferred<FileListResponse>();
    fileApi.listFiles
      .mockReturnValueOnce(firstLoad.promise)
      .mockResolvedValueOnce({ entries: [file('renamed.ts', 'src/renamed.ts')] });

    // Act
    const pendingInitialLoad = useFileBrowserStore.getState().loadDir('/repo', 'src');
    const pendingRefresh = useFileBrowserStore.getState().loadDir('/repo', 'src');

    expect(fileApi.listFiles).toHaveBeenCalledTimes(1);
    firstLoad.resolve({ entries: [file('created.ts', 'src/created.ts')] });
    await Promise.all([pendingInitialLoad, pendingRefresh]);

    // Assert
    expect(fileApi.listFiles).toHaveBeenCalledTimes(2);
    expect(useFileBrowserStore.getState().trees['/repo::src']).toEqual([
      file('renamed.ts', 'src/renamed.ts'),
    ]);
  });

  it('hides the browser without clearing the active file viewer', async () => {
    // Arrange
    const pendingFileSaveHandler = vi.fn().mockResolvedValue(false);
    useFileBrowserStore.setState({
      isOpen: true,
      pendingFileSaveHandler,
      viewerCrowded: true,
      viewingFile: {
        content: 'open file',
        loading: false,
        relativePath: 'src/index.ts',
        rootPath: '/repo',
      },
    });

    // Act
    await useFileBrowserStore.getState().close();

    // Assert
    expect(useFileBrowserStore.getState().isOpen).toBe(false);
    expect(useFileBrowserStore.getState().viewerCrowded).toBe(false);
    expect(useFileBrowserStore.getState().viewingFile?.relativePath).toBe('src/index.ts');
    expect(pendingFileSaveHandler).not.toHaveBeenCalled();
  });

  it('coalesces overlapping reads for the same file', async () => {
    // Arrange
    const read = deferred<FileReadResponse>();
    fileApi.readFileContent.mockReturnValue(read.promise);

    // Act
    const firstOpen = useFileBrowserStore.getState().openFile('/repo', 'src/app.ts');
    const secondOpen = useFileBrowserStore.getState().openFile('/repo', 'src/app.ts');
    await Promise.resolve();

    expect(fileApi.readFileContent).toHaveBeenCalledTimes(1);
    read.resolve({
      kind: 'editable-text',
      content: 'hello',
      contentVersion: 'hash-123',
      encoding: 'utf8',
      eol: 'lf',
      hasBom: false,
    });
    await Promise.all([firstOpen, secondOpen]);

    // Assert
    expect(fileApi.readFileContent).toHaveBeenCalledTimes(1);
    expect(useFileBrowserStore.getState().viewingFile).toMatchObject({
      content: 'hello',
      loading: false,
      contentVersion: 'hash-123',
      relativePath: 'src/app.ts',
      rootPath: '/repo',
    });
  });

  it('invalidates a deferred read and reloads the remapped destination with viewer extras', async () => {
    // Arrange
    const sourceRead = deferred<FileReadResponse>();
    fileApi.readFileContent
      .mockReturnValueOnce(sourceRead.promise)
      .mockResolvedValueOnce(editableText('destination content'));

    // Act
    const openingSource = useFileBrowserStore.getState().openFile(
      '/repo',
      'src/app.ts',
      42,
      'needle',
    );
    await Promise.resolve();
    useFileBrowserStore.getState().remapAfterMove('/repo', [
      { from: 'src/app.ts', to: 'archive/app.ts' },
    ]);
    await Promise.resolve();
    sourceRead.resolve(editableText('stale source content'));
    await openingSource;

    await vi.waitFor(() => {
      expect(fileApi.readFileContent).toHaveBeenCalledTimes(2);
      expect(useFileBrowserStore.getState().viewingFile).toMatchObject({
        content: 'destination content',
        highlightQuery: 'needle',
        loading: false,
        relativePath: 'archive/app.ts',
        rootPath: '/repo',
        scrollToLine: 42,
      });
    });

    // Assert
    expect(fileApi.readFileContent).toHaveBeenNthCalledWith(2, {
      relativePath: 'archive/app.ts',
      rootPath: '/repo',
    });
    expect(useFileBrowserStore.getState().viewingFile).toMatchObject({
      content: 'destination content',
      highlightQuery: 'needle',
      loading: false,
      relativePath: 'archive/app.ts',
      scrollToLine: 42,
    });
  });

  it('does not cancel an in-flight read for an unrelated move', async () => {
    // Arrange
    const read = deferred<FileReadResponse>();
    fileApi.readFileContent.mockReturnValue(read.promise);

    // Act
    const opening = useFileBrowserStore.getState().openFile('/repo', 'src/app.ts');
    await Promise.resolve();
    useFileBrowserStore.getState().remapAfterMove('/repo', [
      { from: 'src/other.ts', to: 'archive/other.ts' },
    ]);
    read.resolve(editableText('source content'));
    await opening;

    // Assert
    expect(fileApi.readFileContent).toHaveBeenCalledTimes(1);
    expect(useFileBrowserStore.getState().viewingFile).toMatchObject({
      content: 'source content',
      loading: false,
      relativePath: 'src/app.ts',
    });
  });

  it('preserves a conflicted draft when reload confirms the file is still missing', async () => {
    // Arrange
    fileApi.readFileContent.mockResolvedValue({
      kind: 'error',
      code: 'NOT_FOUND',
      message: 'File not found',
    });
    useFileBrowserStore.setState({
      draftResetKey: 7,
      viewingFile: {
        conflictDetected: true,
        conflictType: 'deleted',
        content: 'last disk content',
        loading: false,
        contentVersion: 'hash-123',
        eol: 'lf',
        hasBom: false,
        relativePath: 'src/app.ts',
        rootPath: '/repo',
      },
    });

    // Act
    await useFileBrowserStore.getState().reloadOpenFile();

    // Assert
    expect(useFileBrowserStore.getState().draftResetKey).toBe(7);
    expect(useFileBrowserStore.getState().viewingFile).toMatchObject({
      conflictDetected: true,
      conflictType: 'deleted',
      content: 'last disk content',
      contentVersion: 'hash-123',
    });
  });

  it('times out a stuck pending save instead of blocking file operations forever', async () => {
    // Arrange
    vi.useFakeTimers();
    useFileBrowserStore.setState({
      pendingFileSaveHandler: () => new Promise<boolean>(() => {}),
    });

    // Act
    const flush = useFileBrowserStore.getState().flushPendingFileSave();
    await vi.advanceTimersByTimeAsync(5_000);

    // Assert
    await expect(flush).resolves.toBe(false);
    vi.useRealTimers();
  });
});
