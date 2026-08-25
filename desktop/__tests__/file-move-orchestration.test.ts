// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileTreeMutations } from '../src/renderer/components/file-browser/file-tree/useFileTreeMutations';
import {
  fileKey,
  useFileBrowserStore,
  type ActiveFileMove,
} from '../src/renderer/stores/file-browser.store';
import { useFileUndoStore } from '../src/renderer/stores/file-undo.store';
import { useWorkspaceTabsStore } from '../src/renderer/stores/workspace-tabs.store';
import type { FileEntry, FileMoveResponse } from '../src/shared/ipc-types';

const fileApi = vi.hoisted(() => ({
  copyFile: vi.fn(),
  createDir: vi.fn(),
  createFile: vi.fn(),
  deleteFile: vi.fn(),
  listFiles: vi.fn(),
  moveFiles: vi.fn(),
  renameFile: vi.fn(),
}));

const notifications = vi.hoisted(() => ({ addToast: vi.fn() }));

function makeSelectableStore<T extends object>(state: T) {
  return vi.fn((selector: (s: T) => unknown) => selector(state));
}

vi.mock('../src/renderer/api/file.api', () => fileApi);
vi.mock('../src/renderer/api/system.api', () => ({ clipboardWrite: vi.fn() }));
vi.mock('../src/renderer/stores', () => ({
  useNotificationStore: makeSelectableStore({ addToast: notifications.addToast }),
}));

const ROOT = '/repo';

function succeeded(sourcePath: string, finalPath: string): FileMoveResponse {
  return { results: [{ finalPath, sourcePath, status: 'succeeded' }] };
}

function entry(path: string, isDirectory = false): FileEntry {
  return { isDirectory, name: path.split('/').pop() ?? path, path };
}

function seedStore(overrides: Partial<ReturnType<typeof useFileBrowserStore.getState>> = {}): void {
  useFileBrowserStore.setState({
    clipboard: null,
    draftResetKey: 0,
    expandedDirs: {},
    findInFileRequestKey: 0,
    folderColors: {},
    isOpen: true,
    activeMove: null,
    pendingFileSaveHandler: null,
    trees: {},
    viewerCrowded: false,
    viewingFile: null,
    ...overrides,
  });
}

function renderMutations() {
  return renderHook(() => useFileTreeMutations(ROOT)).result;
}

describe('moveEntries orchestration', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    fileApi.listFiles.mockResolvedValue({ entries: [] });
    fileApi.moveFiles.mockResolvedValue({ results: [] });
    seedStore();
    useWorkspaceTabsStore.setState({ activeTabByScope: {}, tabsByScope: {} });
    useFileUndoStore.setState({ stacks: {} });
  });

  afterEach(() => {
    cleanup();
  });

  it('flushes the open file before the move reaches the backend', async () => {
    // Arrange
    const order: string[] = [];
    seedStore({
      pendingFileSaveHandler: async () => {
        order.push('flush');
        return true;
      },
      viewingFile: { content: '', loading: false, relativePath: 'src/a.ts', rootPath: ROOT },
    });
    fileApi.moveFiles.mockImplementation(async () => {
      order.push('move');
      return succeeded('src/a.ts', 'dest/a.ts');
    });
    const result = renderMutations();

    // Act
    await act(() => result.current.moveEntries(['src/a.ts'], 'dest', 'move'));

    // Assert
    expect(order).toEqual(['flush', 'move']);
  });

  it('aborts the whole move when the open file cannot be flushed', async () => {
    // Arrange
    seedStore({
      pendingFileSaveHandler: async () => false,
      viewingFile: { content: '', loading: false, relativePath: 'src/a.ts', rootPath: ROOT },
    });
    const result = renderMutations();

    // Act
    await act(() => result.current.moveEntries(['src'], 'dest', 'move'));

    // Assert
    expect(fileApi.moveFiles).not.toHaveBeenCalled();
    expect(notifications.addToast).toHaveBeenCalledWith(expect.stringContaining('could not be saved'), 'error');
  });

  it('marks the sources as moving for the whole request and clears them when it throws', async () => {
    // Arrange
    let observed: ActiveFileMove | null = null;
    fileApi.moveFiles.mockImplementation(async () => {
      observed = useFileBrowserStore.getState().activeMove;
      throw new Error('transport down');
    });
    const result = renderMutations();

    // Act
    await act(() => result.current.moveEntries(['src/a.ts'], 'dest', 'move'));

    // Assert
    expect(observed).toEqual({ mode: 'move', paths: ['src/a.ts'], rootPath: ROOT });
    expect(useFileBrowserStore.getState().activeMove).toBeNull();
    expect(notifications.addToast).toHaveBeenCalledWith('transport down', 'error');
  });

  it('ignores a second move while one is still in flight', async () => {
    // Arrange
    let release = (): void => {};
    fileApi.moveFiles.mockImplementation(async () => {
      await new Promise<void>((resolveMove) => { release = resolveMove; });
      return succeeded('src/a.ts', 'dest/a.ts');
    });
    const result = renderMutations();

    // Act
    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = result.current.moveEntries(['src/a.ts'], 'dest', 'move');
      await result.current.moveEntries(['src/b.ts'], 'dest', 'move');
    });
    await act(async () => {
      release();
      await first;
    });

    // Assert
    expect(fileApi.moveFiles).toHaveBeenCalledTimes(1);
  });

  it('remaps nothing and reloads when the response does not cover every source', async () => {
    // Arrange
    seedStore({ trees: { [`${ROOT}::src`]: [entry('src/a.ts')] } });
    fileApi.moveFiles.mockResolvedValue({
      results: [],
      code: 'UNKNOWN',
      error: 'Invalid file move response',
    });
    const result = renderMutations();

    // Act
    await act(() => result.current.moveEntries(['src/a.ts'], 'dest', 'move'));

    // Assert
    expect(useFileBrowserStore.getState().trees[`${ROOT}::src`]).toBeDefined();
    expect(fileApi.listFiles).toHaveBeenCalledWith({ dirPath: 'dest', rootPath: ROOT });
    expect(fileApi.listFiles).toHaveBeenCalledWith({ dirPath: 'src', rootPath: ROOT });
    expect(notifications.addToast).toHaveBeenCalledWith('Invalid file move response', 'error', expect.anything());
  });

  it('moves the open file together with its tab identity', async () => {
    // Arrange
    seedStore({
      viewingFile: { content: '', loading: false, relativePath: 'src/a.ts', rootPath: ROOT },
    });
    useWorkspaceTabsStore.setState({
      activeTabByScope: { pane: `${ROOT}::src/a.ts` },
      tabsByScope: {
        pane: [{
          fileName: 'a.ts',
          id: `${ROOT}::src/a.ts`,
          openedAt: 0,
          relativePath: 'src/a.ts',
          rootPath: ROOT,
        }],
      },
    });
    fileApi.moveFiles.mockResolvedValue(succeeded('src/a.ts', 'dest/renamed.ts'));
    const result = renderMutations();

    // Act
    await act(() => result.current.moveEntries(['src/a.ts'], 'dest', 'move'));

    // Assert
    const tabs = useWorkspaceTabsStore.getState();
    expect(tabs.tabsByScope.pane[0]).toMatchObject({
      fileName: 'renamed.ts',
      id: `${ROOT}::dest/renamed.ts`,
      relativePath: 'dest/renamed.ts',
    });
    expect(tabs.activeTabByScope.pane).toBe(`${ROOT}::dest/renamed.ts`);
    expect(useFileBrowserStore.getState().viewingFile?.relativePath).toBe('dest/renamed.ts');
  });

  it('carries the tabs of files inside a moved folder', async () => {
    // Arrange
    useWorkspaceTabsStore.setState({
      activeTabByScope: {},
      tabsByScope: {
        pane: [{
          fileName: 'deep.ts',
          id: `${ROOT}::src/nested/deep.ts`,
          openedAt: 0,
          relativePath: 'src/nested/deep.ts',
          rootPath: ROOT,
        }],
      },
    });
    fileApi.moveFiles.mockResolvedValue(succeeded('src/nested', 'dest/nested'));
    const result = renderMutations();

    // Act
    await act(() => result.current.moveEntries(['src/nested'], 'dest', 'move'));

    // Assert
    expect(useWorkspaceTabsStore.getState().tabsByScope.pane[0].relativePath)
      .toBe('dest/nested/deep.ts');
  });

  it('does not let a tab close in flight revert the remap of the other tabs', async () => {
    // Arrange — the close flushes slowly, so the remap would land while it is still awaiting.
    seedStore({
      pendingFileSaveHandler: () => new Promise<boolean>((resolveFlush) => {
        setTimeout(() => resolveFlush(true), 20);
      }),
      viewingFile: { content: '', loading: false, relativePath: 'src/b.ts', rootPath: ROOT },
    });
    useWorkspaceTabsStore.setState({
      activeTabByScope: { pane: `${ROOT}::src/b.ts` },
      tabsByScope: {
        pane: [
          { fileName: 'a.ts', id: `${ROOT}::src/a.ts`, openedAt: 0, relativePath: 'src/a.ts', rootPath: ROOT },
          { fileName: 'b.ts', id: `${ROOT}::src/b.ts`, openedAt: 0, relativePath: 'src/b.ts', rootPath: ROOT },
        ],
      },
    });
    fileApi.moveFiles.mockResolvedValue(succeeded('src/a.ts', 'dest/a.ts'));
    const result = renderMutations();

    // Act
    await act(async () => {
      const closing = useWorkspaceTabsStore.getState().closeTab('pane', `${ROOT}::src/b.ts`);
      const moving = result.current.moveEntries(['src/a.ts'], 'dest', 'move');
      await Promise.all([closing, moving]);
    });

    // Assert
    const tabs = useWorkspaceTabsStore.getState().tabsByScope.pane;
    expect(tabs.map((tab) => tab.relativePath)).toEqual(['dest/a.ts']);
  });

  it('rewrites and persists expanded dirs and folder colours without touching a prefix sibling', async () => {
    // Arrange
    seedStore({
      expandedDirs: { [ROOT]: new Set(['src/app', 'src/app/ui', 'src/application']) },
      folderColors: {
        [fileKey(ROOT, 'src/app')]: '#60a5fa',
        [fileKey(ROOT, 'src/application')]: '#fb7185',
      },
      trees: {
        [`${ROOT}::src/app`]: [entry('src/app/ui', true)],
        [`${ROOT}::src/app/ui`]: [entry('src/app/ui/x.ts')],
        [`${ROOT}::src/application`]: [entry('src/application/y.ts')],
      },
    });
    fileApi.moveFiles.mockResolvedValue(succeeded('src/app', 'lib/app'));
    const result = renderMutations();

    // Act
    await act(() => result.current.moveEntries(['src/app'], 'lib', 'move'));

    // Assert
    const state = useFileBrowserStore.getState();
    expect([...(state.expandedDirs[ROOT] ?? [])].sort())
      .toEqual(['lib/app', 'lib/app/ui', 'src/application']);
    expect(state.folderColors[fileKey(ROOT, 'lib/app')]).toBe('#60a5fa');
    expect(state.folderColors[fileKey(ROOT, 'src/application')]).toBe('#fb7185');
    expect(state.folderColors[fileKey(ROOT, 'src/app')]).toBeUndefined();
    expect(JSON.parse(localStorage.getItem('muxbase-folder-colors') ?? '{}'))
      .toHaveProperty(fileKey(ROOT, 'lib/app'), '#60a5fa');
    expect(state.trees[`${ROOT}::src/application`]).toBeDefined();
  });

  it('drops the cached subtree under the old path and reloads the remapped one', async () => {
    // Arrange
    seedStore({
      expandedDirs: { [ROOT]: new Set(['src/app']) },
      trees: {
        [`${ROOT}::src/app`]: [entry('src/app/x.ts')],
        [`${ROOT}::src/app/ui`]: [entry('src/app/ui/y.ts')],
      },
    });
    fileApi.moveFiles.mockResolvedValue(succeeded('src/app', 'lib/app'));
    const result = renderMutations();

    // Act
    await act(() => result.current.moveEntries(['src/app'], 'lib', 'move'));

    // Assert
    const trees = useFileBrowserStore.getState().trees;
    expect(trees[`${ROOT}::src/app`]).toBeUndefined();
    expect(trees[`${ROOT}::src/app/ui`]).toBeUndefined();
    expect(fileApi.listFiles).toHaveBeenCalledWith({ dirPath: 'lib/app', rootPath: ROOT });
  });

  it('reports a copy as copied and leaves paths untouched', async () => {
    // Arrange
    seedStore({ trees: { [`${ROOT}::src`]: [entry('src/a.ts')] } });
    fileApi.moveFiles.mockResolvedValue(succeeded('src/a.ts', 'dest/a.ts'));
    const result = renderMutations();

    // Act
    await act(() => result.current.moveEntries(['src/a.ts'], 'dest', 'copy'));

    // Assert
    expect(notifications.addToast).toHaveBeenCalledWith('Copied 1 item', 'success', expect.anything());
    expect(useFileBrowserStore.getState().trees[`${ROOT}::src`]).toBeDefined();
  });

  it('warns when a move leaves a copy behind', async () => {
    // Arrange
    fileApi.moveFiles.mockResolvedValue({
      results: [{
        code: 'EACCES',
        error: 'permission denied',
        finalPath: 'dest/a.ts',
        sourcePath: 'src/a.ts',
        status: 'partial',
      }],
    } satisfies FileMoveResponse);
    const result = renderMutations();

    // Act
    await act(() => result.current.moveEntries(['src/a.ts'], 'dest', 'move'));

    // Assert
    expect(notifications.addToast).toHaveBeenCalledWith(
      'Moved 1 item · 1 left a copy behind',
      'warning',
      { detail: 'src/a.ts: permission denied' },
    );
  });
});

describe('undo', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    fileApi.listFiles.mockResolvedValue({ entries: [] });
    seedStore();
    useWorkspaceTabsStore.setState({ activeTabByScope: {}, tabsByScope: {} });
    useFileUndoStore.setState({ stacks: {} });
  });

  afterEach(() => {
    cleanup();
  });

  it('moves every entry back to the parent it came from', async () => {
    // Arrange — two sources from different folders, so the inverse needs two destinations.
    fileApi.moveFiles.mockResolvedValue({
      results: [
        { finalPath: 'dest/a.ts', sourcePath: 'src/a.ts', status: 'succeeded' },
        { finalPath: 'dest/b.ts', sourcePath: 'lib/b.ts', status: 'succeeded' },
      ],
    } satisfies FileMoveResponse);
    const result = renderMutations();
    await act(() => result.current.moveEntries(['src/a.ts', 'lib/b.ts'], 'dest', 'move'));

    fileApi.moveFiles.mockImplementation(async (request: { destDir: string; sourcePaths: string[] }) => ({
      results: request.sourcePaths.map((sourcePath) => ({
        finalPath: `${request.destDir}/${sourcePath.split('/').pop()}`,
        sourcePath,
        status: 'succeeded' as const,
      })),
    }));

    // Act
    await act(() => result.current.undoLastMove());

    // Assert
    expect(fileApi.moveFiles).toHaveBeenCalledWith({
      destDir: 'src', mode: 'move', rootPath: ROOT, sourcePaths: ['dest/a.ts'],
    });
    expect(fileApi.moveFiles).toHaveBeenCalledWith({
      destDir: 'lib', mode: 'move', rootPath: ROOT, sourcePaths: ['dest/b.ts'],
    });
    expect(notifications.addToast).toHaveBeenLastCalledWith('Undid move of 2 items', 'success');
  });

  it('does not record the undo itself, so the stack cannot cycle', async () => {
    // Arrange
    fileApi.moveFiles.mockResolvedValue(succeeded('src/a.ts', 'dest/a.ts'));
    const result = renderMutations();
    await act(() => result.current.moveEntries(['src/a.ts'], 'dest', 'move'));
    expect(useFileUndoStore.getState().stacks[ROOT]).toHaveLength(1);

    // Act
    fileApi.moveFiles.mockResolvedValue(succeeded('dest/a.ts', 'src/a.ts'));
    await act(() => result.current.undoLastMove());

    // Assert
    expect(useFileUndoStore.getState().stacks[ROOT]).toHaveLength(0);
    await act(() => result.current.undoLastMove());
    expect(fileApi.moveFiles).toHaveBeenCalledTimes(2);
  });

  it('keeps the entry when nothing could be moved back', async () => {
    // Arrange
    fileApi.moveFiles.mockResolvedValue(succeeded('src/a.ts', 'dest/a.ts'));
    const result = renderMutations();
    await act(() => result.current.moveEntries(['src/a.ts'], 'dest', 'move'));

    fileApi.moveFiles.mockResolvedValue({
      results: [{ code: 'EEXIST', error: 'exists', sourcePath: 'dest/a.ts', status: 'failed' }],
    } satisfies FileMoveResponse);

    // Act
    await act(() => result.current.undoLastMove());

    // Assert — a retry must target the same batch, not silently skip to an older one.
    expect(useFileUndoStore.getState().stacks[ROOT]).toHaveLength(1);
    expect(notifications.addToast).toHaveBeenLastCalledWith('Nothing could be moved back', 'error');
  });

  it('replays a single queued undo once the move it landed on settles', async () => {
    // Arrange — a move whose filesystem side is done but whose remap and reloads are still running.
    let release = (): void => {};
    fileApi.moveFiles.mockImplementation(async () => {
      await new Promise<void>((resolveMove) => { release = resolveMove; });
      return succeeded('src/a.ts', 'dest/a.ts');
    });
    const result = renderMutations();

    let moving: Promise<unknown> = Promise.resolve();
    await act(async () => {
      moving = result.current.moveEntries(['src/a.ts'], 'dest', 'move');
      // Key auto-repeat: several presses inside the same window must not stack up.
      await result.current.undoLastMove();
      await result.current.undoLastMove();
    });
    expect(fileApi.moveFiles).toHaveBeenCalledTimes(1);

    // Act — the move settles, and the held undo runs exactly once.
    fileApi.moveFiles.mockResolvedValue(succeeded('dest/a.ts', 'src/a.ts'));
    await act(async () => {
      release();
      await moving;
      await Promise.resolve();
    });

    // Assert
    await vi.waitFor(() => expect(fileApi.moveFiles).toHaveBeenCalledTimes(2));
    expect(fileApi.moveFiles).toHaveBeenLastCalledWith({
      destDir: 'src', mode: 'move', rootPath: ROOT, sourcePaths: ['dest/a.ts'],
    });
    expect(useFileUndoStore.getState().stacks[ROOT] ?? []).toHaveLength(0);
  });

  it('restores every group when a second undo arrives mid-undo', async () => {
    // Arrange — two sources from different parents, so the inverse needs two FILE_MOVE calls.
    fileApi.moveFiles.mockResolvedValue({
      results: [
        { finalPath: 'dest/a.md', sourcePath: 'docs/a.md', status: 'succeeded' },
        { finalPath: 'dest/b.ts', sourcePath: 'src/b.ts', status: 'succeeded' },
      ],
    } satisfies FileMoveResponse);
    const result = renderMutations();
    // An older entry sits underneath, so a second undo has something of its own to pop.
    useFileUndoStore.getState().pushMove({
      moves: [{ from: 'older.ts', to: 'dest/older.ts' }],
      rootPath: ROOT,
    });
    await act(() => result.current.moveEntries(['docs/a.md', 'src/b.ts'], 'dest', 'move'));

    // The first inverse group hangs, and a second Cmd-Z lands while it is in flight.
    let releaseFirstGroup = (): void => {};
    const restoreCalls: string[] = [];
    fileApi.moveFiles.mockImplementation(async (request: { destDir: string; sourcePaths: string[] }) => {
      restoreCalls.push(request.destDir);
      if (restoreCalls.length === 1) {
        await new Promise<void>((resolveGroup) => { releaseFirstGroup = resolveGroup; });
      }
      return {
        results: request.sourcePaths.map((sourcePath) => ({
          finalPath: `${request.destDir}/${sourcePath.split('/').pop()}`,
          sourcePath,
          status: 'succeeded' as const,
        })),
      };
    });

    // Act
    let undoing: Promise<unknown> = Promise.resolve();
    await act(async () => {
      undoing = result.current.undoLastMove();
      await result.current.undoLastMove();
    });
    await act(async () => {
      releaseFirstGroup();
      await undoing;
    });

    // Assert — both original parents were restored; neither group was skipped by the guard.
    await vi.waitFor(() => expect(restoreCalls).toContain('docs'));
    expect(restoreCalls).toContain('src');
    expect(notifications.addToast).toHaveBeenCalledWith('Undid move of 2 items', 'success');
  });

  it('puts back only the items a partial undo could not restore', async () => {
    // Arrange — a two-parent batch where one inverse group will fail.
    fileApi.moveFiles.mockResolvedValue({
      results: [
        { finalPath: 'dest/a.md', sourcePath: 'docs/a.md', status: 'succeeded' },
        { finalPath: 'dest/b.ts', sourcePath: 'src/b.ts', status: 'succeeded' },
      ],
    } satisfies FileMoveResponse);
    const result = renderMutations();
    await act(() => result.current.moveEntries(['docs/a.md', 'src/b.ts'], 'dest', 'move'));

    fileApi.moveFiles.mockImplementation(async (request: { destDir: string; sourcePaths: string[] }) => (
      request.destDir === 'docs'
        ? { results: [{ finalPath: 'docs/a.md', sourcePath: 'dest/a.md', status: 'succeeded' as const }] }
        : { results: [{ code: 'EEXIST' as const, error: 'exists', sourcePath: 'dest/b.ts', status: 'failed' as const }] }
    ));

    // Act
    await act(() => result.current.undoLastMove());

    // Assert — the half that is still displaced stays on the stack for a later retry.
    expect(useFileUndoStore.getState().stacks[ROOT]).toEqual([
      { moves: [{ from: 'src/b.ts', to: 'dest/b.ts' }], rootPath: ROOT },
    ]);
    expect(notifications.addToast).toHaveBeenLastCalledWith('Undid 1 of 2 moved items', 'warning');
  });

  it('discards a held undo when the tree has switched to another root', async () => {
    // Arrange — the tree is reused across roots, so a queued press must not follow the user.
    let release = (): void => {};
    fileApi.moveFiles.mockImplementation(async () => {
      await new Promise<void>((resolveMove) => { release = resolveMove; });
      return succeeded('src/a.ts', 'dest/a.ts');
    });
    const view = renderHook(({ root }) => useFileTreeMutations(root), {
      initialProps: { root: ROOT },
    });
    useFileUndoStore.getState().pushMove({
      moves: [{ from: 'older.ts', to: 'dest/older.ts' }],
      rootPath: ROOT,
    });
    // The root switched to also has history, so a leaked drain would have something to consume.
    useFileUndoStore.getState().pushMove({
      moves: [{ from: 'other.ts', to: 'dest/other.ts' }],
      rootPath: '/other-worktree',
    });

    let moving: Promise<unknown> = Promise.resolve();
    await act(async () => {
      moving = view.result.current.moveEntries(['src/a.ts'], 'dest', 'move');
      await view.result.current.undoLastMove();
    });
    fileApi.moveFiles.mockClear();

    // Act — the pane switches while the move is still settling.
    view.rerender({ root: '/other-worktree' });
    await act(async () => {
      release();
      await moving;
    });

    // Assert — the held undo belonged to the old root and is dropped, not replayed against the new.
    // Both entries stay put: the seeded one and the one the completed move recorded.
    expect(fileApi.moveFiles).not.toHaveBeenCalled();
    expect(useFileUndoStore.getState().stacks[ROOT]).toHaveLength(2);
    expect(useFileUndoStore.getState().stacks['/other-worktree']).toHaveLength(1);
  });

  it('does not record a partial move, which is not invertible', async () => {
    // Arrange — a partial left the source in place, so moving the target back would collide.
    fileApi.moveFiles.mockResolvedValue({
      results: [{
        code: 'EACCES',
        error: 'permission denied',
        finalPath: 'dest/a.ts',
        sourcePath: 'src/a.ts',
        status: 'partial',
      }],
    } satisfies FileMoveResponse);
    const result = renderMutations();

    // Act
    await act(() => result.current.moveEntries(['src/a.ts'], 'dest', 'move'));

    // Assert
    expect(useFileUndoStore.getState().stacks[ROOT] ?? []).toHaveLength(0);
  });

  it('does not call a restore that left a duplicate behind a success', async () => {
    // Arrange
    fileApi.moveFiles.mockResolvedValue(succeeded('notes.md', 'dest/notes.md'));
    const result = renderMutations();
    await act(() => result.current.moveEntries(['notes.md'], 'dest', 'move'));

    // The restore creates the target but cannot remove the source: both paths now exist.
    fileApi.moveFiles.mockResolvedValue({
      results: [{
        code: 'EACCES',
        error: 'permission denied',
        finalPath: 'notes.md',
        sourcePath: 'dest/notes.md',
        status: 'partial',
      }],
    } satisfies FileMoveResponse);

    // Act
    await act(() => result.current.undoLastMove());

    // Assert
    expect(notifications.addToast).toHaveBeenLastCalledWith('Nothing could be moved back', 'error');
    expect(useFileUndoStore.getState().stacks[ROOT]).toHaveLength(1);
  });

  it('records nothing for a copy, because undoing one would delete a file', async () => {
    // Arrange
    fileApi.moveFiles.mockResolvedValue(succeeded('src/a.ts', 'dest/a.ts'));
    const result = renderMutations();

    // Act
    await act(() => result.current.moveEntries(['src/a.ts'], 'dest', 'copy'));

    // Assert
    expect(useFileUndoStore.getState().stacks[ROOT] ?? []).toHaveLength(0);
  });

  it('reports a partial restore rather than claiming success', async () => {
    // Arrange
    fileApi.moveFiles.mockResolvedValue({
      results: [
        { finalPath: 'dest/a.ts', sourcePath: 'src/a.ts', status: 'succeeded' },
        { finalPath: 'dest/b.ts', sourcePath: 'lib/b.ts', status: 'succeeded' },
      ],
    } satisfies FileMoveResponse);
    const result = renderMutations();
    await act(() => result.current.moveEntries(['src/a.ts', 'lib/b.ts'], 'dest', 'move'));

    fileApi.moveFiles.mockImplementation(async (request: { destDir: string; sourcePaths: string[] }) => (
      request.destDir === 'src'
        ? { results: [{ finalPath: 'src/a.ts', sourcePath: 'dest/a.ts', status: 'succeeded' as const }] }
        : { results: [{ code: 'EEXIST' as const, error: 'exists', sourcePath: 'dest/b.ts', status: 'failed' as const }] }
    ));

    // Act
    await act(() => result.current.undoLastMove());

    // Assert
    expect(notifications.addToast)
      .toHaveBeenLastCalledWith('Undid 1 of 2 moved items', 'warning');
  });

  it('counts what actually came back rather than the size of the group', async () => {
    // Arrange — one group of three, of which the backend restores only two.
    fileApi.moveFiles.mockResolvedValue({
      results: ['a', 'b', 'c'].map((name) => ({
        finalPath: `dest/${name}.ts`,
        sourcePath: `src/${name}.ts`,
        status: 'succeeded' as const,
      })),
    } satisfies FileMoveResponse);
    const result = renderMutations();
    await act(() => result.current.moveEntries(
      ['src/a.ts', 'src/b.ts', 'src/c.ts'], 'dest', 'move',
    ));

    fileApi.moveFiles.mockResolvedValue({
      results: [
        { finalPath: 'src/a.ts', sourcePath: 'dest/a.ts', status: 'succeeded' },
        { finalPath: 'src/b.ts', sourcePath: 'dest/b.ts', status: 'succeeded' },
        { code: 'ENOENT', error: 'gone', sourcePath: 'dest/c.ts', status: 'failed' },
      ],
    } satisfies FileMoveResponse);

    // Act
    await act(() => result.current.undoLastMove());

    // Assert
    expect(notifications.addToast)
      .toHaveBeenLastCalledWith('Undid 2 of 3 moved items', 'warning');
  });
});

describe('file key ownership', () => {
  it('keeps a single fileKey helper in the renderer', () => {
    // Arrange
    const viewerSource = readFileSync(
      resolve(__dirname, '..', 'src/renderer/components/file-browser/FileViewer.tsx'),
      'utf8',
    );

    // Assert
    expect(viewerSource).toContain("from '../../stores/file-browser.store'");
    expect(viewerSource).not.toMatch(/function\s+\w*[fF]ileKey\s*\(/);
  });
});
