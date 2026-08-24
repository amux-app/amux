// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNotificationStore } from '../../src/renderer/stores/notification.store';
import {
  useActiveFileTabId,
  useFileTabsForScope,
  useWorkspaceTabsStore,
} from '../../src/renderer/stores/workspace-tabs.store';

const FLUSH_TIMEOUT_MS = 5_000;

interface MockViewingFile {
  loading: boolean;
  relativePath: string;
  rootPath: string;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

const fileBrowser = vi.hoisted(() => ({
  closeFile: vi.fn(),
  flushPendingFileSave: vi.fn(),
  openFile: vi.fn(),
  openFileAtLine: vi.fn(),
  viewingFile: null as MockViewingFile | null,
}));

vi.mock('../../src/renderer/stores/file-browser.store', () => ({
  useFileBrowserStore: {
    getState: () => fileBrowser,
  },
}));

describe('useWorkspaceTabsStore selectors', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  beforeEach(() => {
    useWorkspaceTabsStore.setState({
      activeTabByScope: {},
      tabsByScope: {},
    });
    useNotificationStore.setState({ toasts: [] });
    fileBrowser.viewingFile = null;
    vi.clearAllMocks();
    fileBrowser.closeFile.mockResolvedValue(true);
    fileBrowser.flushPendingFileSave.mockResolvedValue(true);
    fileBrowser.openFile.mockResolvedValue(undefined);
    fileBrowser.openFileAtLine.mockResolvedValue(undefined);
  });

  it('returns the same empty tabs reference across renders', () => {
    // Arrange
    const { rerender, result } = renderHook(() => useFileTabsForScope('pane-1'));
    const firstResult = result.current;

    // Act
    rerender();

    // Assert
    expect(result.current).toBe(firstResult);
  });

  it('resolves the active file tab id for a workspace root', () => {
    // Arrange
    useWorkspaceTabsStore.setState({
      activeTabByScope: { 'pane-1': '/workspace::src/index.ts' },
      tabsByScope: {},
    });

    // Act
    const { result } = renderHook(() => useActiveFileTabId('pane-1'));

    // Assert
    expect(result.current).toBe('/workspace::src/index.ts');
  });

  it('opens text search results as active workspace file tabs at the requested line', async () => {
    // Arrange / Act
    await useWorkspaceTabsStore.getState().openFileAtLine('pane-1', '/workspace', 'src/search.ts', 42, 'needle');

    // Assert
    expect(useWorkspaceTabsStore.getState().activeTabByScope['pane-1']).toBe('/workspace::src/search.ts');
    expect(useWorkspaceTabsStore.getState().tabsByScope['pane-1']).toEqual([
      expect.objectContaining({
        fileName: 'search.ts',
        relativePath: 'src/search.ts',
        rootPath: '/workspace',
      }),
    ]);
    expect(fileBrowser.openFileAtLine).toHaveBeenCalledWith('/workspace', 'src/search.ts', 42, 'needle');
  });

  it('isolates tabs between panes that share the same root path', async () => {
    // Arrange / Act
    await useWorkspaceTabsStore.getState().openFile('pane-1', '/workspace', 'package.json');

    // Assert
    expect(useWorkspaceTabsStore.getState().activeTabByScope['pane-1']).toBe('/workspace::package.json');
    expect(useWorkspaceTabsStore.getState().activeTabByScope['pane-2']).toBeUndefined();
    expect(useWorkspaceTabsStore.getState().tabsByScope['pane-2']).toBeUndefined();
  });

  it('keeps only one pane file viewer active at a time', async () => {
    // Arrange
    await useWorkspaceTabsStore.getState().openFile('pane-1', '/workspace', 'package.json');

    // Act
    await useWorkspaceTabsStore.getState().openFile('pane-2', '/workspace', 'src/index.ts');

    // Assert
    expect(useWorkspaceTabsStore.getState().activeTabByScope['pane-1']).toBeNull();
    expect(useWorkspaceTabsStore.getState().activeTabByScope['pane-2']).toBe('/workspace::src/index.ts');
    expect(useWorkspaceTabsStore.getState().tabsByScope['pane-1']).toHaveLength(1);
    expect(useWorkspaceTabsStore.getState().tabsByScope['pane-2']).toHaveLength(1);
  });

  it('retries the active file tab when its viewer is still loading', async () => {
    // Arrange
    const store = useWorkspaceTabsStore.getState();
    await store.openFile('pane-1', '/workspace', 'src/index.ts');
    fileBrowser.viewingFile = {
      loading: true,
      relativePath: 'src/index.ts',
      rootPath: '/workspace',
    };
    vi.clearAllMocks();

    // Act
    await store.openFile('pane-1', '/workspace', 'src/index.ts');

    // Assert
    expect(fileBrowser.openFile).toHaveBeenCalledWith('/workspace', 'src/index.ts');
  });

  it('retries the selected file tab when its viewer is still loading', async () => {
    // Arrange
    const store = useWorkspaceTabsStore.getState();
    await store.openFile('pane-1', '/workspace', 'src/index.ts');
    fileBrowser.viewingFile = {
      loading: true,
      relativePath: 'src/index.ts',
      rootPath: '/workspace',
    };
    vi.clearAllMocks();

    // Act
    await store.setActiveTab('pane-1', '/workspace::src/index.ts');

    // Assert
    expect(fileBrowser.openFile).toHaveBeenCalledWith('/workspace', 'src/index.ts');
  });

  it('closes file tabs to the right and activates the clicked tab when needed', async () => {
    // Arrange
    const store = useWorkspaceTabsStore.getState();
    await store.openFile('pane-1', '/workspace', 'src/a.ts');
    await store.openFile('pane-1', '/workspace', 'src/b.ts');
    await store.openFile('pane-1', '/workspace', 'src/c.ts');
    vi.clearAllMocks();

    // Act
    await store.closeTabsToRight('pane-1', '/workspace::src/b.ts');

    // Assert
    expect(useWorkspaceTabsStore.getState().tabsByScope['pane-1'].map((tab) => tab.relativePath)).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
    expect(useWorkspaceTabsStore.getState().activeTabByScope['pane-1']).toBe('/workspace::src/b.ts');
    expect(fileBrowser.openFile).toHaveBeenCalledWith('/workspace', 'src/b.ts');
  });

  it('closes other file tabs and focuses the selected tab', async () => {
    // Arrange
    const store = useWorkspaceTabsStore.getState();
    await store.openFile('pane-1', '/workspace', 'src/a.ts');
    await store.openFile('pane-1', '/workspace', 'src/b.ts');
    await store.openFile('pane-1', '/workspace', 'src/c.ts');
    vi.clearAllMocks();

    // Act
    await store.closeOtherTabs('pane-1', '/workspace::src/a.ts');

    // Assert
    expect(useWorkspaceTabsStore.getState().tabsByScope['pane-1'].map((tab) => tab.relativePath)).toEqual(['src/a.ts']);
    expect(useWorkspaceTabsStore.getState().activeTabByScope['pane-1']).toBe('/workspace::src/a.ts');
    expect(fileBrowser.openFile).toHaveBeenCalledWith('/workspace', 'src/a.ts');
  });

  it('closes all file tabs in a pane and clears the viewer', async () => {
    // Arrange
    const store = useWorkspaceTabsStore.getState();
    await store.openFile('pane-1', '/workspace', 'src/a.ts');
    await store.openFile('pane-1', '/workspace', 'src/b.ts');
    vi.clearAllMocks();

    // Act
    await store.closeAllTabs('pane-1');

    // Assert
    expect(useWorkspaceTabsStore.getState().tabsByScope['pane-1']).toEqual([]);
    expect(useWorkspaceTabsStore.getState().activeTabByScope['pane-1']).toBeNull();
    expect(fileBrowser.closeFile).toHaveBeenCalledWith({ flushPendingSave: false });
  });

  it('keeps the active tab and viewer open when its pending draft cannot be flushed', async () => {
    // Arrange
    const store = useWorkspaceTabsStore.getState();
    await store.openFile('pane-1', '/workspace', 'src/a.ts');
    vi.clearAllMocks();
    fileBrowser.flushPendingFileSave.mockResolvedValue(false);

    // Act
    await store.closeActiveTab('pane-1');

    // Assert
    expect(useWorkspaceTabsStore.getState().activeTabByScope['pane-1']).toBe('/workspace::src/a.ts');
    expect(useWorkspaceTabsStore.getState().tabsByScope['pane-1']).toHaveLength(1);
    expect(fileBrowser.closeFile).not.toHaveBeenCalled();
  });

  it('does not activate another tab before the current draft flush succeeds', async () => {
    // Arrange
    const store = useWorkspaceTabsStore.getState();
    await store.openFile('pane-1', '/workspace', 'src/a.ts');
    await store.openFile('pane-1', '/workspace', 'src/b.ts');
    await store.setActiveTab('pane-1', '/workspace::src/a.ts');
    vi.clearAllMocks();
    fileBrowser.flushPendingFileSave.mockResolvedValue(false);

    // Act
    await store.setActiveTab('pane-1', '/workspace::src/b.ts');

    // Assert
    expect(useWorkspaceTabsStore.getState().activeTabByScope['pane-1']).toBe('/workspace::src/a.ts');
    expect(fileBrowser.openFile).not.toHaveBeenCalled();
  });

  it('refuses a tab close when the pending draft flush never settles', async () => {
    // Arrange
    const store = useWorkspaceTabsStore.getState();
    await store.openFile('pane-1', '/workspace', 'src/a.ts');
    vi.clearAllMocks();
    fileBrowser.flushPendingFileSave.mockReturnValue(new Promise<boolean>(() => {}));
    vi.useFakeTimers();

    // Act
    const closed = store.closeActiveTab('pane-1');
    await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT_MS);

    // Assert
    await expect(closed).resolves.toBe(false);
    expect(useWorkspaceTabsStore.getState().tabsByScope['pane-1']).toHaveLength(1);
    expect(fileBrowser.closeFile).not.toHaveBeenCalled();
  });

  it('warns the user when a tab close is refused by a failed draft flush', async () => {
    // Arrange
    const store = useWorkspaceTabsStore.getState();
    await store.openFile('pane-1', '/workspace', 'src/a.ts');
    fileBrowser.flushPendingFileSave.mockResolvedValue(false);
    useNotificationStore.setState({ toasts: [] });

    // Act
    await store.closeActiveTab('pane-1');

    // Assert
    const toasts = useNotificationStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].severity).toBe('error');
    expect(toasts[0].message).toContain('could not be saved');
  });

  it('warns the user when a tab switch is refused by a failed draft flush', async () => {
    // Arrange
    const store = useWorkspaceTabsStore.getState();
    await store.openFile('pane-1', '/workspace', 'src/a.ts');
    await store.openFile('pane-1', '/workspace', 'src/b.ts');
    fileBrowser.flushPendingFileSave.mockResolvedValue(false);
    useNotificationStore.setState({ toasts: [] });

    // Act
    await store.setActiveTab('pane-1', '/workspace::src/a.ts');

    // Assert
    expect(useNotificationStore.getState().toasts).toHaveLength(1);
    expect(useNotificationStore.getState().toasts[0].severity).toBe('error');
  });

  it('commits a tab switch only after the pending draft has finished saving', async () => {
    // Arrange
    const store = useWorkspaceTabsStore.getState();
    await store.openFile('pane-1', '/workspace', 'src/a.ts');
    await store.openFile('pane-1', '/workspace', 'src/b.ts');
    await store.setActiveTab('pane-1', '/workspace::src/a.ts');
    const flush = createDeferred<boolean>();
    vi.clearAllMocks();
    fileBrowser.flushPendingFileSave.mockReturnValue(flush.promise);

    // Act
    const transition = store.setActiveTab('pane-1', '/workspace::src/b.ts');
    await Promise.resolve();

    // Assert
    expect(useWorkspaceTabsStore.getState().activeTabByScope['pane-1']).toBe('/workspace::src/a.ts');
    expect(fileBrowser.openFile).not.toHaveBeenCalled();

    // Act
    flush.resolve(true);
    await transition;

    // Assert
    expect(useWorkspaceTabsStore.getState().activeTabByScope['pane-1']).toBe('/workspace::src/b.ts');
    expect(fileBrowser.openFile).toHaveBeenCalledWith('/workspace', 'src/b.ts');
  });

  it('prefers a moved source tab over a stale destination tab after remapping', async () => {
    // Arrange
    useWorkspaceTabsStore.setState({
      activeTabByScope: { 'pane-1': '/workspace::src/app.ts' },
      tabsByScope: {
        'pane-1': [
          {
            fileName: 'app.ts',
            id: '/workspace::archive/app.ts',
            openedAt: 1,
            relativePath: 'archive/app.ts',
            rootPath: '/workspace',
          },
          {
            fileName: 'app.ts',
            id: '/workspace::src/app.ts',
            openedAt: 2,
            relativePath: 'src/app.ts',
            rootPath: '/workspace',
          },
        ],
      },
    });

    // Act
    await useWorkspaceTabsStore.getState().remapFilePath(
      '/workspace',
      'src/app.ts',
      'archive/app.ts',
    );

    // Assert
    expect(useWorkspaceTabsStore.getState().tabsByScope['pane-1']).toEqual([
      expect.objectContaining({
        id: '/workspace::archive/app.ts',
        openedAt: 2,
        relativePath: 'archive/app.ts',
      }),
    ]);
    expect(useWorkspaceTabsStore.getState().activeTabByScope['pane-1'])
      .toBe('/workspace::archive/app.ts');
  });

  it('deduplicates every affected tab when a directory containing open files moves', async () => {
    // Arrange
    useWorkspaceTabsStore.setState({
      activeTabByScope: { 'pane-1': '/workspace::src/nested/b.ts' },
      tabsByScope: {
        'pane-1': [
          {
            fileName: 'a.ts',
            id: '/workspace::archive/nested/a.ts',
            openedAt: 1,
            relativePath: 'archive/nested/a.ts',
            rootPath: '/workspace',
          },
          {
            fileName: 'a.ts',
            id: '/workspace::src/nested/a.ts',
            openedAt: 2,
            relativePath: 'src/nested/a.ts',
            rootPath: '/workspace',
          },
          {
            fileName: 'b.ts',
            id: '/workspace::src/nested/b.ts',
            openedAt: 3,
            relativePath: 'src/nested/b.ts',
            rootPath: '/workspace',
          },
        ],
      },
    });

    // Act
    await useWorkspaceTabsStore.getState().remapFilePath(
      '/workspace',
      'src',
      'archive',
    );

    // Assert
    const state = useWorkspaceTabsStore.getState();
    expect(state.tabsByScope['pane-1'].map((tab) => tab.relativePath)).toEqual([
      'archive/nested/a.ts',
      'archive/nested/b.ts',
    ]);
    expect([...new Set(state.tabsByScope['pane-1'].map((tab) => tab.id))]).toHaveLength(2);
    expect(state.activeTabByScope['pane-1']).toBe('/workspace::archive/nested/b.ts');
  });
});
