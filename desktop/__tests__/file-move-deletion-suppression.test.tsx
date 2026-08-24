// @vitest-environment happy-dom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileViewer } from '../src/renderer/components/file-browser/FileViewer';
import { useFileBrowserStore, type ActiveFileMove } from '../src/renderer/stores/file-browser.store';
import { IPC_EVENT } from '../src/shared/ipc-channels';

const fileApi = vi.hoisted(() => ({
  cancelFormatFileContent: vi.fn(),
  formatFileContent: vi.fn(),
  readFileContent: vi.fn(),
  writeFileContent: vi.fn(),
}));

const notifications = vi.hoisted(() => ({ addToast: vi.fn() }));
const ipcListeners = vi.hoisted(() => ({ callbacks: new Map<string, (event: unknown) => void>() }));

function makeSelectableStore<T extends object>(state: T) {
  return vi.fn((selector: (s: T) => unknown) => selector(state));
}

vi.mock('../src/renderer/api/file.api', () => fileApi);
vi.mock('../src/renderer/api/system.api', () => ({ clipboardWrite: vi.fn() }));
vi.mock('../src/renderer/hooks/useIpcListener', () => ({
  useIpcListener: vi.fn((channel: string, callback: (event: unknown) => void) => {
    ipcListeners.callbacks.set(channel, callback);
  }),
}));
vi.mock('../src/renderer/stores', () => ({
  useNotificationStore: makeSelectableStore({ addToast: notifications.addToast }),
}));
vi.mock('../src/renderer/components/shared/ProseMarkdown', () => ({
  ProseMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('../src/renderer/components/file-browser/CodeMirrorEditor', () => ({
  CodeMirrorEditor: () => <div data-testid="editor-stub" />,
}));

const ROOT = '/repo';
const RELATIVE_PATH = 'src/a.ts';

function seedViewer(activeMove: ActiveFileMove | null): void {
  useFileBrowserStore.setState({
    clipboard: null,
    draftResetKey: 0,
    expandedDirs: {},
    findInFileRequestKey: 0,
    folderColors: {},
    isOpen: true,
    activeMove,
    pendingFileSaveHandler: null,
    trees: {},
    viewerCrowded: false,
    viewingFile: {
      content: 'original',
      contentVersion: 'hash-0',
      eol: 'lf',
      hasBom: false,
      loading: false,
      relativePath: RELATIVE_PATH,
      rootPath: ROOT,
    },
  });
}

async function emitUnlink(): Promise<void> {
  await act(async () => {
    ipcListeners.callbacks.get(IPC_EVENT.FILE_CHANGED)?.({
      changeType: 'unlink',
      relativePath: RELATIVE_PATH,
      rootPath: ROOT,
    });
    await vi.advanceTimersByTimeAsync(400);
  });
}

describe('FileViewer deletion suppression during a move', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    ipcListeners.callbacks.clear();
    fileApi.readFileContent.mockResolvedValue({
      kind: 'error',
      code: 'NOT_FOUND',
      message: 'File not found',
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('ignores the source deletion of a file it is moving', async () => {
    // Arrange
    seedViewer({ mode: 'move', paths: [RELATIVE_PATH], rootPath: ROOT });
    render(<FileViewer />);

    // Act
    await emitUnlink();

    // Assert
    expect(fileApi.readFileContent).not.toHaveBeenCalled();
    expect(useFileBrowserStore.getState().viewingFile?.conflictDetected).toBeFalsy();
  });

  it('ignores the deletion of a file carried along inside a moved folder', async () => {
    // Arrange
    seedViewer({ mode: 'move', paths: ['src'], rootPath: ROOT });
    render(<FileViewer />);

    // Act
    await emitUnlink();

    // Assert
    expect(fileApi.readFileContent).not.toHaveBeenCalled();
    expect(useFileBrowserStore.getState().viewingFile?.conflictDetected).toBeFalsy();
  });

  it('still reports a deletion when the move belongs to another root', async () => {
    // Arrange
    seedViewer({ mode: 'move', paths: ['src'], rootPath: '/other-worktree' });
    render(<FileViewer />);

    // Act
    await emitUnlink();

    // Assert
    expect(useFileBrowserStore.getState().viewingFile?.conflictType).toBe('deleted');
  });

  it('does not treat a prefix sibling of a moved folder as part of the move', async () => {
    // Arrange — the open file is src/a.ts; src/app is a different folder that shares a prefix.
    seedViewer({ mode: 'move', paths: ['src/a'], rootPath: ROOT });
    render(<FileViewer />);

    // Act
    await emitUnlink();

    // Assert
    expect(useFileBrowserStore.getState().viewingFile?.conflictType).toBe('deleted');
  });

  it('still reports a deletion when the in-flight operation is a copy', async () => {
    // Arrange — a copy unlinks nothing, so an unlink during one is a real deletion.
    seedViewer({ mode: 'copy', paths: [RELATIVE_PATH], rootPath: ROOT });
    render(<FileViewer />);

    // Act
    await emitUnlink();

    // Assert
    expect(useFileBrowserStore.getState().viewingFile?.conflictType).toBe('deleted');
  });

  it('still reports a genuine deletion for a file that is not moving', async () => {
    // Arrange
    seedViewer({ mode: 'move', paths: ['src/other.ts'], rootPath: ROOT });
    render(<FileViewer />);

    // Act
    await emitUnlink();

    // Assert
    expect(fileApi.readFileContent).toHaveBeenCalled();
    expect(useFileBrowserStore.getState().viewingFile?.conflictType).toBe('deleted');
  });
});
