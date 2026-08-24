// @vitest-environment happy-dom
import React from 'react';
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../src/shared/ipc-types';
import { FileTree } from '../src/renderer/components/file-browser/file-tree/FileTree';
import { FileTreeInlineInput } from '../src/renderer/components/file-browser/FileTreeInlineInput';
import { useFileBrowserStore } from '../src/renderer/stores/file-browser.store';
import { useFileUndoStore } from '../src/renderer/stores/file-undo.store';

const fileApi = vi.hoisted(() => ({
  createDir: vi.fn(),
  createFile: vi.fn(),
  copyFile: vi.fn(),
  deleteFile: vi.fn(),
  listFiles: vi.fn(),
  moveFiles: vi.fn(),
  renameFile: vi.fn(),
}));

const notifications = vi.hoisted(() => ({
  addToast: vi.fn(),
}));

function makeSelectableStore<T extends object>(state: T) {
  return vi.fn((selector: (s: T) => unknown) => selector(state));
}

vi.mock('../src/renderer/api/file.api', () => fileApi);

vi.mock('../src/renderer/api/system.api', () => ({
  clipboardWrite: vi.fn(),
  listEditors: vi.fn().mockResolvedValue([]),
  openInEditor: vi.fn(),
}));

vi.mock('../src/renderer/stores', () => ({
  useNotificationStore: makeSelectableStore({ addToast: notifications.addToast }),
}));

class TestResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element): void {
    this.callback([{ target, contentRect: new DOMRectReadOnly(0, 0, 360, 480) } as ResizeObserverEntry], this);
  }

  unobserve(): void {}

  disconnect(): void {}
}

function file(name: string, path = name): FileEntry {
  return { name, path, isDirectory: false };
}

function dir(name: string, path = name): FileEntry {
  return { name, path, isDirectory: true };
}

function resetFileBrowserState(
  trees: Record<string, FileEntry[]>,
  expandedDirs: Record<string, Set<string>> = {},
): void {
  useFileBrowserStore.setState({
    isOpen: true,
    trees,
    expandedDirs,
    activeMove: null,
    creating: null,
    pendingFileSaveHandler: null,
    viewingFile: null,
    findInFileRequestKey: 0,
    draftResetKey: 0,
    viewerCrowded: false,
    folderColors: {},
    clipboard: null,
  });
}

/** happy-dom does not implement DataTransfer, and the drag payload has to survive the whole gesture. */
interface RecordingDataTransfer extends DataTransfer {
  dragImageText: () => string;
}

function makeDataTransfer(): RecordingDataTransfer {
  const store = new Map<string, string>();
  let dragImage: Element | null = null;
  return {
    dropEffect: 'none',
    effectAllowed: 'none',
    setData: (type: string, value: string) => { store.set(type, value); },
    getData: (type: string) => store.get(type) ?? '',
    setDragImage: (image: Element) => { dragImage = image; },
    dragImageText: () => dragImage?.textContent ?? '',
  } as unknown as RecordingDataTransfer;
}

/**
 * A real mouse press is mousedown → mouseup → click, and the tree selects on mousedown because a
 * `draggable` row turns a bare click into a drag as soon as the pointer twitches. Driving only
 * `click` here is what let a broken shift-click ship.
 */
function pressRow(path: string, init: MouseEventInit = {}): void {
  const target = rowFor(path);
  fireEvent.mouseDown(target, { button: 0, ...init });
  fireEvent.mouseUp(target, { button: 0, ...init });
  fireEvent.click(target, init);
}

function rowFor(path: string): HTMLElement {
  const row = document.querySelector(`[data-testid="file-tree-row"][data-file-path="${path}"]`);
  if (!row) throw new Error(`missing row for ${path}`);
  return row as HTMLElement;
}

describe('FileTree interactions', () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 360,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 480,
    });
    globalThis.ResizeObserver = TestResizeObserver;
  });

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  afterAll(() => {
    delete globalThis.ResizeObserver;
  });

  it('opens a file path when the file row is clicked', async () => {
    // Arrange
    const onFileClick = vi.fn();
    resetFileBrowserState({ '/repo': [file('app.ts')] });

    // Act
    render(<FileTree rootPath="/repo" onFileClick={onFileClick} />);
    fireEvent.click(await screen.findByText('app.ts'));

    // Assert
    expect(onFileClick).toHaveBeenCalledWith('app.ts');
  });

  it('renders per-type sprite icons for files and folders', async () => {
    // Arrange
    resetFileBrowserState({ '/repo': [dir('src'), file('app.ts')] });

    // Act
    render(<FileTree rootPath="/repo" />);
    await screen.findByText('app.ts');
    const symbols = screen
      .getAllByTestId('file-tree-row')
      .map((row) => row.querySelector('use')?.getAttribute('href'));

    // Assert
    expect(symbols).toEqual(['#fi-folder_src', '#fi-typescript']);
  });

  it('syncs expanded state and lazy-loads a directory when expanded', async () => {
    // Arrange
    fileApi.listFiles.mockResolvedValue({ entries: [file('index.ts', 'src/index.ts')] });
    resetFileBrowserState({ '/repo': [dir('src')] });

    // Act
    render(<FileTree rootPath="/repo" />);
    fireEvent.click(await screen.findByText('src'));

    // Assert
    await waitFor(() => {
      expect(useFileBrowserStore.getState().expandedDirs['/repo']?.has('src')).toBe(true);
    });
    expect(fileApi.listFiles).toHaveBeenCalledWith({ rootPath: '/repo', dirPath: 'src' });
  });

  it('exposes a labelled tree with levels and expansion state', async () => {
    resetFileBrowserState({ '/repo': [dir('src'), file('README.md')] });

    render(<FileTree rootPath="/repo" />);

    const tree = await screen.findByRole('tree', { name: 'Files in repo' });
    const rows = within(tree).getAllByRole('treeitem');
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('aria-level')).toBe('1');
    expect(rows[0].getAttribute('aria-expanded')).toBe('false');
    expect(rows[1].hasAttribute('aria-expanded')).toBe(false);
  });

  it('navigates, expands, collapses, and opens files from the keyboard', async () => {
    const onFileClick = vi.fn();
    resetFileBrowserState({
      '/repo': [dir('src'), file('README.md')],
      '/repo::src': [file('index.ts', 'src/index.ts')],
    });
    render(<FileTree rootPath="/repo" onFileClick={onFileClick} />);
    const tree = await screen.findByRole('tree', { name: 'Files in repo' });
    tree.focus();

    fireEvent.keyDown(tree, { key: 'r' });
    expect(screen.getByText('README.md').closest('[role="treeitem"]')?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tree, { key: 'Home' });
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(screen.getByText('README.md').closest('[role="treeitem"]')?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tree, { key: 'Enter' });
    expect(onFileClick).toHaveBeenCalledWith('README.md');

    fireEvent.keyDown(tree, { key: 'Home' });
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(screen.getByText('src').closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('true');
    });
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    expect(screen.getByText('index.ts').closest('[role="treeitem"]')?.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    expect(screen.getByText('src').closest('[role="treeitem"]')?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    await waitFor(() => {
      expect(screen.getByText('src').closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('false');
    });
  });

  it('keeps filename input keyboard events inside the input', () => {
    // Arrange
    const onParentKeyDown = vi.fn();
    const onSubmit = vi.fn();

    // Act
    render(
      <div onKeyDown={onParentKeyDown}>
        <FileTreeInlineInput defaultValue="old.ts" onSubmit={onSubmit} onCancel={vi.fn()} />
      </div>,
    );
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: ' ' });
    fireEvent.change(input, { target: { value: 'new.ts' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Assert
    expect(onParentKeyDown).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith('new.ts');
  });

  it('does not duplicate the extension when a full filename replaces the selected basename', () => {
    // Arrange
    const onSubmit = vi.fn();

    // Act
    render(<FileTreeInlineInput defaultValue="old.ts" onSubmit={onSubmit} onCancel={vi.fn()} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'new.ts.ts' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Assert
    expect(onSubmit).toHaveBeenCalledWith('new.ts');
  });
});

describe('FileTree clipboard and keyboard verbs', () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 360 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 480 });
    globalThis.ResizeObserver = TestResizeObserver;
  });

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    fileApi.listFiles.mockResolvedValue({ entries: [] });
    fileApi.moveFiles.mockResolvedValue({ results: [] });
  });

  afterEach(() => {
    cleanup();
  });

  afterAll(() => {
    delete globalThis.ResizeObserver;
  });

  async function renderTree(): Promise<HTMLElement> {
    resetFileBrowserState({ '/repo': [dir('src'), file('app.ts')] });
    render(<FileTree rootPath="/repo" />);
    await screen.findByText('app.ts');
    const tree = screen.getByRole('tree', { name: 'Files in repo' });
    tree.focus();
    fireEvent.keyDown(tree, { key: 'Home' });
    fireEvent.keyDown(tree, { key: 'a' });
    return tree;
  }

  it('cuts the active row and pastes it into the focused folder', async () => {
    const tree = await renderTree();
    fileApi.moveFiles.mockResolvedValue({
      results: [{ finalPath: 'src/app.ts', sourcePath: 'app.ts', status: 'succeeded' }],
    });

    fireEvent.keyDown(tree, { key: 'x', metaKey: true });
    expect(useFileBrowserStore.getState().clipboard)
      .toEqual({ mode: 'cut', paths: ['app.ts'], rootPath: '/repo' });

    fireEvent.keyDown(tree, { key: 's' });
    fireEvent.keyDown(tree, { key: 'v', metaKey: true });

    await waitFor(() => {
      expect(fileApi.moveFiles).toHaveBeenCalledWith({
        destDir: 'src',
        mode: 'move',
        rootPath: '/repo',
        sourcePaths: ['app.ts'],
      });
    });
    await waitFor(() => expect(useFileBrowserStore.getState().clipboard).toBeNull());
  });

  it('keeps the cut clipboard when every item of the paste failed', async () => {
    const tree = await renderTree();
    fileApi.moveFiles.mockResolvedValue({
      results: [{
        code: 'EEXIST',
        error: 'src/app.ts already exists',
        sourcePath: 'app.ts',
        status: 'failed',
      }],
    });

    fireEvent.keyDown(tree, { key: 'x', metaKey: true });
    fireEvent.keyDown(tree, { key: 's' });
    fireEvent.keyDown(tree, { key: 'v', metaKey: true });

    await waitFor(() => expect(fileApi.moveFiles).toHaveBeenCalled());
    expect(useFileBrowserStore.getState().clipboard)
      .toEqual({ mode: 'cut', paths: ['app.ts'], rootPath: '/repo' });
  });

  it('says why a folder cannot be pasted into itself, and stays silent about a no-op paste', async () => {
    resetFileBrowserState({ '/repo': [dir('src'), file('app.ts')] }, { '/repo': new Set(['src']) });
    render(<FileTree rootPath="/repo" />);
    const tree = await screen.findByRole('tree', { name: 'Files in repo' });
    tree.focus();
    fireEvent.keyDown(tree, { key: 'Home' });
    fireEvent.keyDown(tree, { key: 'x', metaKey: true });

    fireEvent.keyDown(tree, { key: 'v', metaKey: true });

    await waitFor(() => {
      expect(notifications.addToast)
        .toHaveBeenCalledWith('A folder cannot be pasted into itself', 'error');
    });
    expect(fileApi.moveFiles).not.toHaveBeenCalled();

    notifications.addToast.mockClear();
    fireEvent.keyDown(tree, { key: 'a' });
    fireEvent.keyDown(tree, { key: 'x', metaKey: true });
    fireEvent.keyDown(tree, { key: 'v', metaKey: true });

    expect(notifications.addToast).not.toHaveBeenCalled();
    expect(fileApi.moveFiles).not.toHaveBeenCalled();
  });

  it('does not make the row draggable while its rename input is open', async () => {
    const tree = await renderTree();

    fireEvent.keyDown(tree, { key: 'F2' });

    expect(rowFor('app.ts').getAttribute('draggable')).toBe('false');
  });

  it('abandons an inline create that belongs to another root', async () => {
    await renderTree();
    useFileBrowserStore.getState().setCreating({ dir: '', rootPath: '/repo', type: 'file' });

    cleanup();
    render(<FileTree rootPath="/other" />);

    await waitFor(() => expect(useFileBrowserStore.getState().creating).toBeNull());
  });

  it('keeps a copy clipboard so paste can run twice', async () => {
    const tree = await renderTree();

    fireEvent.keyDown(tree, { key: 'c', metaKey: true });
    fireEvent.keyDown(tree, { key: 's' });
    fireEvent.keyDown(tree, { key: 'v', metaKey: true });

    await waitFor(() => {
      expect(fileApi.moveFiles).toHaveBeenCalledWith(expect.objectContaining({ mode: 'copy' }));
    });
    expect(useFileBrowserStore.getState().clipboard?.mode).toBe('copy');
  });

  it('duplicates the active row into its own parent', async () => {
    const tree = await renderTree();

    fireEvent.keyDown(tree, { key: 'd', metaKey: true });

    await waitFor(() => {
      expect(fileApi.moveFiles).toHaveBeenCalledWith({
        destDir: '',
        mode: 'copy',
        rootPath: '/repo',
        sourcePaths: ['app.ts'],
      });
    });
  });

  it('opens the inline rename input from F2 and clears a cut clipboard with Escape', async () => {
    const tree = await renderTree();

    fireEvent.keyDown(tree, { key: 'F2' });
    expect(screen.getByTestId('file-tree-inline-input')).toHaveProperty('value', 'app.ts');

    fireEvent.keyDown(tree, { key: 'x', metaKey: true });
    expect(useFileBrowserStore.getState().clipboard).not.toBeNull();
    fireEvent.keyDown(tree, { key: 'Escape' });
    expect(useFileBrowserStore.getState().clipboard).toBeNull();
  });

  it('drops a cut clipboard when the root changes but keeps a copy clipboard', async () => {
    await renderTree();
    useFileBrowserStore.getState().setClipboard({ mode: 'cut', paths: ['app.ts'], rootPath: '/repo' });

    cleanup();
    render(<FileTree rootPath="/other" />);
    await waitFor(() => expect(useFileBrowserStore.getState().clipboard).toBeNull());

    useFileBrowserStore.getState().setClipboard({ mode: 'copy', paths: ['app.ts'], rootPath: '/repo' });
    cleanup();
    render(<FileTree rootPath="/other" />);
    expect(useFileBrowserStore.getState().clipboard?.mode).toBe('copy');
  });
});

describe('FileTree multi-select', () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 360 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 480 });
    globalThis.ResizeObserver = TestResizeObserver;
  });

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    fileApi.listFiles.mockResolvedValue({ entries: [] });
    fileApi.moveFiles.mockResolvedValue({ results: [] });
  });

  afterEach(() => {
    cleanup();
  });

  afterAll(() => {
    delete globalThis.ResizeObserver;
  });

  async function renderFlatTree(): Promise<void> {
    resetFileBrowserState({
      '/repo': [dir('src'), file('a.ts'), file('b.ts'), file('c.ts')],
    });
    render(<FileTree rootPath="/repo" />);
    await screen.findByText('c.ts');
  }

  function selectedPaths(): string[] {
    return screen.getAllByTestId('file-tree-row')
      .filter((row) => row.getAttribute('aria-selected') === 'true')
      .map((row) => row.getAttribute('data-file-path') ?? '');
  }

  it('selects a contiguous range on a shift click without opening anything', async () => {
    const onFileClick = vi.fn();
    resetFileBrowserState({ '/repo': [dir('src'), file('a.ts'), file('b.ts'), file('c.ts')] });
    render(<FileTree rootPath="/repo" onFileClick={onFileClick} />);
    await screen.findByText('c.ts');

    pressRow('a.ts');
    onFileClick.mockClear();
    pressRow('c.ts', { shiftKey: true });

    expect(selectedPaths()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(onFileClick).not.toHaveBeenCalled();
  });

  it('does not announce an off-screen focused row as selected', async () => {
    // Opening a file parks the focus ring on its row without selecting it, and in a long tree that
    // row sits outside the virtualized window, so the off-screen proxy is all a reader gets.
    const many = Array.from({ length: 200 }, (_, index) => file(`f${String(index).padStart(3, '0')}.ts`));
    resetFileBrowserState({ '/repo': many });
    act(() => {
      useFileBrowserStore.setState({
        viewingFile: { content: '', loading: false, relativePath: 'f150.ts', rootPath: '/repo' },
      });
    });
    render(<FileTree rootPath="/repo" />);
    const tree = await screen.findByRole('tree', { name: 'Files in repo' });

    const proxy = await within(tree).findByRole('treeitem', { name: 'f150.ts' });
    expect(document.querySelector('[data-file-path="f150.ts"]')).toBeNull();
    expect(tree.getAttribute('aria-activedescendant')).toBe(proxy.id);
    expect(proxy.getAttribute('aria-selected')).toBe('false');
  });

  it('adds a single row on a modifier click and leaves folders collapsed', async () => {
    await renderFlatTree();

    pressRow('a.ts');
    pressRow('src', { metaKey: true });

    expect(selectedPaths().sort()).toEqual(['a.ts', 'src']);
    expect(rowFor('src').getAttribute('aria-expanded')).toBe('false');
  });

  it('extends the selection with shift and the arrow keys', async () => {
    await renderFlatTree();
    const tree = screen.getByRole('tree', { name: 'Files in repo' });
    tree.focus();

    fireEvent.keyDown(tree, { key: 'Home' });
    fireEvent.keyDown(tree, { key: 'ArrowDown', shiftKey: true });

    expect(selectedPaths()).toEqual(['src', 'a.ts']);
  });

  it('drags the whole selection when the dragged row is part of it', async () => {
    await renderFlatTree();

    pressRow('a.ts');
    pressRow('b.ts', { shiftKey: true });
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(rowFor('a.ts'), { dataTransfer });
    fireEvent.dragEnter(rowFor('src'), { dataTransfer });
    fireEvent.dragOver(rowFor('src'), { dataTransfer });
    fireEvent.drop(rowFor('src'), { dataTransfer });

    await waitFor(() => {
      expect(fileApi.moveFiles).toHaveBeenCalledWith({
        destDir: 'src',
        mode: 'move',
        rootPath: '/repo',
        sourcePaths: ['a.ts', 'b.ts'],
      });
    });
  });

  it('drags only the grabbed row when it sits outside the selection', async () => {
    await renderFlatTree();

    pressRow('a.ts');
    pressRow('b.ts', { shiftKey: true });
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(rowFor('c.ts'), { dataTransfer });
    fireEvent.dragEnter(rowFor('src'), { dataTransfer });
    fireEvent.dragOver(rowFor('src'), { dataTransfer });
    fireEvent.drop(rowFor('src'), { dataTransfer });

    await waitFor(() => {
      expect(fileApi.moveFiles).toHaveBeenCalledWith(
        expect.objectContaining({ sourcePaths: ['c.ts'] }),
      );
    });
  });

  it('trashes a folder without also reporting its selected child as a failure', async () => {
    resetFileBrowserState(
      { '/repo': [dir('src'), file('z.ts')], '/repo::src': [file('a.ts', 'src/a.ts')] },
      { '/repo': new Set(['src']) },
    );
    fileApi.deleteFile.mockResolvedValue({ success: true });
    render(<FileTree rootPath="/repo" />);
    await screen.findByText('z.ts');
    const tree = screen.getByRole('tree', { name: 'Files in repo' });
    tree.focus();

    // Rows are src, src/a.ts, z.ts — a shift range from the bottom takes the folder and its child.
    pressRow('z.ts');
    pressRow('src', { shiftKey: true });
    fireEvent.keyDown(tree, { key: 'Delete' });

    // The dialog counts the normalized set, not the three raw rows.
    expect(await screen.findByText('Move 2 items to Trash?')).toBeTruthy();
    fireEvent.click(screen.getByText('Move to Trash'));

    await waitFor(() => expect(fileApi.deleteFile).toHaveBeenCalledTimes(2));
    expect(fileApi.deleteFile).toHaveBeenCalledWith({ relativePath: 'src', rootPath: '/repo' });
    expect(fileApi.deleteFile).toHaveBeenCalledWith({ relativePath: 'z.ts', rootPath: '/repo' });
    expect(fileApi.deleteFile)
      .not.toHaveBeenCalledWith({ relativePath: 'src/a.ts', rootPath: '/repo' });
  });

  it('skips entries already sitting in the drop target instead of failing them', async () => {
    await renderFlatTree();

    // a.ts and b.ts are root-level; dropping them onto the root-level c.ts targets the root, where
    // they already live. The backend would answer EEXIST for both, so they never leave.
    pressRow('a.ts');
    pressRow('b.ts', { metaKey: true });
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(rowFor('a.ts'), { dataTransfer });
    fireEvent.dragEnter(rowFor('c.ts'), { dataTransfer });
    fireEvent.dragOver(rowFor('c.ts'), { dataTransfer });
    fireEvent.drop(rowFor('c.ts'), { dataTransfer });

    expect(fileApi.moveFiles).not.toHaveBeenCalled();
  });

  it('removes only the toggled row, keeping the rest of the selection', async () => {
    await renderFlatTree();

    pressRow('a.ts');
    pressRow('c.ts', { shiftKey: true });
    expect(selectedPaths()).toEqual(['a.ts', 'b.ts', 'c.ts']);

    // a.ts is not the focused row; focusing it here would resurrect it as a fresh single selection.
    pressRow('a.ts', { metaKey: true });

    expect(selectedPaths()).toEqual(['b.ts', 'c.ts']);
  });

  it('re-anchors the selection onto a row grabbed from outside it', async () => {
    await renderFlatTree();

    pressRow('a.ts');
    pressRow('b.ts', { shiftKey: true });
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(rowFor('c.ts'), { dataTransfer });

    // The highlight has to describe what is actually being dragged.
    await waitFor(() => expect(selectedPaths()).toEqual(['c.ts']));
  });

  it('declares itself multi-selectable so the selection is announced', async () => {
    await renderFlatTree();

    expect(screen.getByRole('tree', { name: 'Files in repo' }).getAttribute('aria-multiselectable'))
      .toBe('true');
  });

  it('re-anchors the selection when a row outside it is right-clicked', async () => {
    await renderFlatTree();

    pressRow('a.ts');
    pressRow('b.ts', { shiftKey: true });
    fireEvent.contextMenu(rowFor('c.ts'));

    // The highlight has to describe what the menu is about to act on.
    await waitFor(() => expect(selectedPaths()).toEqual(['c.ts']));
  });

  it('keeps a multi-selection when a row inside it is right-clicked', async () => {
    await renderFlatTree();

    pressRow('a.ts');
    pressRow('c.ts', { shiftKey: true });
    fireEvent.contextMenu(rowFor('b.ts'));

    expect(selectedPaths()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('drags the range when a shift press runs straight into a drag', async () => {
    await renderFlatTree();

    // No mouseup between the shift press and the drag — the gesture the user actually makes.
    pressRow('a.ts');
    const target = rowFor('c.ts');
    fireEvent.mouseDown(target, { button: 0, shiftKey: true });
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(target, { dataTransfer, shiftKey: true });
    fireEvent.dragEnter(rowFor('src'), { dataTransfer });
    fireEvent.dragOver(rowFor('src'), { dataTransfer });
    fireEvent.drop(rowFor('src'), { dataTransfer });

    await waitFor(() => {
      expect(fileApi.moveFiles).toHaveBeenCalledWith({
        destDir: 'src',
        mode: 'move',
        rootPath: '/repo',
        sourcePaths: ['a.ts', 'b.ts', 'c.ts'],
      });
    });
  });

  it('shows the batch size in the drag image instead of one row', async () => {
    await renderFlatTree();

    pressRow('a.ts');
    pressRow('c.ts', { shiftKey: true });
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(rowFor('a.ts'), { dataTransfer });

    expect(dataTransfer.dragImageText()).toBe('3 items');
  });

  it('names the file when only one row is dragged', async () => {
    await renderFlatTree();

    pressRow('a.ts');
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(rowFor('a.ts'), { dataTransfer });

    expect(dataTransfer.dragImageText()).toBe('a.ts');
  });

  it('cancels the drag when a modifier press removes the row from the selection', async () => {
    await renderFlatTree();

    pressRow('a.ts');
    pressRow('c.ts', { shiftKey: true });
    // Cmd-pressing a selected row deselects it; dragging on from there has nothing coherent to carry.
    fireEvent.mouseDown(rowFor('b.ts'), { button: 0, metaKey: true });
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(rowFor('b.ts'), { dataTransfer });
    fireEvent.dragEnter(rowFor('src'), { dataTransfer });
    fireEvent.dragOver(rowFor('src'), { dataTransfer });
    fireEvent.drop(rowFor('src'), { dataTransfer });

    expect(fileApi.moveFiles).not.toHaveBeenCalled();
  });

  it('cuts every selected row with one keystroke', async () => {
    await renderFlatTree();
    const tree = screen.getByRole('tree', { name: 'Files in repo' });
    tree.focus();

    pressRow('a.ts');
    pressRow('c.ts', { shiftKey: true });
    fireEvent.keyDown(tree, { key: 'x', metaKey: true });

    expect(useFileBrowserStore.getState().clipboard)
      .toEqual({ mode: 'cut', paths: ['a.ts', 'b.ts', 'c.ts'], rootPath: '/repo' });
  });
});

describe('FileTree undo', () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 360 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 480 });
    globalThis.ResizeObserver = TestResizeObserver;
  });

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    fileApi.listFiles.mockResolvedValue({ entries: [] });
    useFileUndoStore.setState({ stacks: {} });
  });

  afterEach(() => {
    cleanup();
  });

  afterAll(() => {
    delete globalThis.ResizeObserver;
  });

  it('moves the last dragged entry back where it came from', async () => {
    resetFileBrowserState({ '/repo': [dir('src'), file('a.ts')] });
    fileApi.moveFiles.mockResolvedValue({
      results: [{ finalPath: 'src/a.ts', sourcePath: 'a.ts', status: 'succeeded' }],
    });
    render(<FileTree rootPath="/repo" />);
    await screen.findByText('a.ts');
    const tree = screen.getByRole('tree', { name: 'Files in repo' });
    tree.focus();

    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(rowFor('a.ts'), { dataTransfer });
    fireEvent.dragEnter(rowFor('src'), { dataTransfer });
    fireEvent.dragOver(rowFor('src'), { dataTransfer });
    fireEvent.drop(rowFor('src'), { dataTransfer });
    await waitFor(() => expect(useFileUndoStore.getState().stacks['/repo']).toHaveLength(1));
    // The undo entry is recorded before the move finishes settling, and undo is a move itself.
    await waitFor(() => expect(useFileBrowserStore.getState().activeMove).toBeNull());

    fileApi.moveFiles.mockResolvedValue({
      results: [{ finalPath: 'a.ts', sourcePath: 'src/a.ts', status: 'succeeded' }],
    });
    fireEvent.keyDown(tree, { key: 'z', metaKey: true });

    await waitFor(() => {
      expect(fileApi.moveFiles).toHaveBeenLastCalledWith({
        destDir: '',
        mode: 'move',
        rootPath: '/repo',
        sourcePaths: ['src/a.ts'],
      });
    });
  });

  it('leaves redo to whoever implements it instead of undoing again', async () => {
    resetFileBrowserState({ '/repo': [dir('src'), file('a.ts')] });
    render(<FileTree rootPath="/repo" />);
    await screen.findByText('a.ts');
    const tree = screen.getByRole('tree', { name: 'Files in repo' });
    tree.focus();
    useFileUndoStore.getState().pushMove({
      moves: [{ from: 'a.ts', to: 'src/a.ts' }],
      rootPath: '/repo',
    });

    fireEvent.keyDown(tree, { key: 'z', metaKey: true, shiftKey: true });

    expect(fileApi.moveFiles).not.toHaveBeenCalled();
    expect(useFileUndoStore.getState().stacks['/repo']).toHaveLength(1);
  });
});

describe('FileTree drag and drop', () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 360 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 480 });
    globalThis.ResizeObserver = TestResizeObserver;
  });

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    fileApi.listFiles.mockResolvedValue({ entries: [] });
    fileApi.moveFiles.mockResolvedValue({ results: [] });
  });

  afterEach(() => {
    cleanup();
  });

  afterAll(() => {
    delete globalThis.ResizeObserver;
  });

  async function renderTree(): Promise<void> {
    resetFileBrowserState({ '/repo': [dir('lib'), dir('src'), file('app.ts')] });
    render(<FileTree rootPath="/repo" />);
    await screen.findByText('app.ts');
  }

  function fireDrag(
    kind: 'dragEnter' | 'dragOver' | 'drop',
    target: HTMLElement,
    init: { altKey?: boolean; dataTransfer: DataTransfer },
  ): void {
    const event = createEvent[kind](target, { dataTransfer: init.dataTransfer });
    Object.defineProperty(event, 'altKey', { value: init.altKey ?? false });
    fireEvent(target, event);
  }

  function dragTo(source: string, target: HTMLElement, init: { altKey?: boolean } = {}): void {
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(rowFor(source), { dataTransfer });
    fireDrag('dragEnter', target, { dataTransfer, ...init });
    fireDrag('dragOver', target, { dataTransfer, ...init });
    fireDrag('drop', target, { dataTransfer, ...init });
  }

  it('moves the dragged file into the folder it is dropped on', async () => {
    await renderTree();

    dragTo('app.ts', rowFor('src'));

    await waitFor(() => {
      expect(fileApi.moveFiles).toHaveBeenCalledWith({
        destDir: 'src',
        mode: 'move',
        rootPath: '/repo',
        sourcePaths: ['app.ts'],
      });
    });
  });

  it('copies instead of moving while the copy modifier is held', async () => {
    await renderTree();

    dragTo('app.ts', rowFor('src'), { altKey: true });

    await waitFor(() => {
      expect(fileApi.moveFiles).toHaveBeenCalledWith(expect.objectContaining({ mode: 'copy' }));
    });
  });

  it('makes no call when the drop target is not allowed', async () => {
    await renderTree();

    dragTo('src', rowFor('src'));

    expect(fileApi.moveFiles).not.toHaveBeenCalled();
  });

  it('targets the root when the drop lands on the tree background', async () => {
    resetFileBrowserState({ '/repo': [dir('src')], '/repo::src': [file('a.ts', 'src/a.ts')] }, {
      '/repo': new Set(['src']),
    });
    render(<FileTree rootPath="/repo" />);
    await screen.findByText('a.ts');

    dragTo('src/a.ts', screen.getByRole('tree', { name: 'Files in repo' }));

    await waitFor(() => {
      expect(fileApi.moveFiles).toHaveBeenCalledWith(expect.objectContaining({ destDir: '' }));
    });
  });

  it('springs a collapsed folder open after hovering it', async () => {
    await renderTree();
    vi.useFakeTimers();
    try {
      const dataTransfer = makeDataTransfer();
      fireEvent.dragStart(rowFor('app.ts'), { dataTransfer });
      fireEvent.dragEnter(rowFor('src'), { dataTransfer });

      act(() => { vi.advanceTimersByTime(600); });

      expect(useFileBrowserStore.getState().expandedDirs['/repo']?.has('src')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the drop highlight when the drag ends without a drop', async () => {
    await renderTree();
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(rowFor('app.ts'), { dataTransfer });
    fireEvent.dragEnter(rowFor('src'), { dataTransfer });
    fireEvent.dragOver(rowFor('src'), { dataTransfer });
    await waitFor(() => expect(rowFor('src').getAttribute('data-drop-target')).toBe('true'));

    fireEvent.dragEnd(rowFor('app.ts'), { dataTransfer });

    await waitFor(() => expect(rowFor('src').hasAttribute('data-drop-target')).toBe(false));
    expect(fileApi.moveFiles).not.toHaveBeenCalled();
  });
});
