// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { folderColorKey, useFileBrowserStore } from '../src/renderer/stores/file-browser.store';

describe('file browser folder colors', () => {
  beforeEach(() => {
    localStorage.clear();
    useFileBrowserStore.setState({ folderColors: {} });
  });

  it('scopes folder colors by root path and relative path', () => {
    // Arrange
    const store = useFileBrowserStore.getState();

    // Act
    store.setFolderColor('/repo/worktree-a', 'src', '#60a5fa');

    // Assert
    expect(useFileBrowserStore.getState().folderColors[folderColorKey('/repo/worktree-a', 'src')]).toBe('#60a5fa');
    expect(useFileBrowserStore.getState().folderColors[folderColorKey('/repo/worktree-b', 'src')]).toBeUndefined();
  });
});
