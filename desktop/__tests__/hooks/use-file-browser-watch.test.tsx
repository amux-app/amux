// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileBrowserStore } from '../../src/renderer/stores/file-browser.store';
import { usePaneStore } from '../../src/renderer/stores/pane.store';
import { useFileBrowserWatch } from '../../src/renderer/hooks/useFileBrowserWatch';

const fileApi = vi.hoisted(() => ({
  setFileWatchRoot: vi.fn(),
}));

vi.mock('../../src/renderer/api/file.api', () => fileApi);

describe('useFileBrowserWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    fileApi.setFileWatchRoot.mockResolvedValue({ success: true });
    usePaneStore.setState({
      panes: [{
        id: 'pane-1',
        paneId: '%1',
        projectRoot: '/repo',
        prompt: '',
        slug: 'pane-1',
        type: 'shell',
      }],
      selectedPaneId: 'pane-1',
    });
    useFileBrowserStore.setState({
      expandedDirs: {},
      isOpen: false,
      viewingFile: {
        rootPath: '/repo',
        relativePath: 'src/search-result.ts',
        content: 'export {}',
        truncated: false,
        loading: false,
        mtimeMs: 1,
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('watches the open file parent even while the file browser panel is closed', async () => {
    // Act
    const { unmount } = renderHook(() => useFileBrowserWatch());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Assert
    expect(fileApi.setFileWatchRoot).toHaveBeenCalledWith({
      dirPaths: ['', 'src'],
      rootPath: '/repo',
    });

    // Act
    unmount();

    // Assert
    expect(fileApi.setFileWatchRoot).toHaveBeenLastCalledWith({ rootPath: undefined });
  });

  it('does no watch work until a browser or file is open', async () => {
    // Arrange
    useFileBrowserStore.setState({ viewingFile: null });

    // Act
    const { unmount } = renderHook(() => useFileBrowserWatch());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    unmount();

    // Assert
    expect(fileApi.setFileWatchRoot).not.toHaveBeenCalled();
  });
});
