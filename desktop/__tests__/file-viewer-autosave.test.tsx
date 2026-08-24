// @vitest-environment happy-dom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileWriteRequest, FileWriteResponse, TextChange } from '../src/shared/ipc-types';
import { FileViewer } from '../src/renderer/components/file-browser/FileViewer';
import { useFileBrowserStore } from '../src/renderer/stores/file-browser.store';
import { IPC_EVENT } from '../src/shared/ipc-channels';

const fileApi = vi.hoisted(() => ({
  formatFileContent: vi.fn(),
  readFileContent: vi.fn(),
  writeFileContent: vi.fn(),
}));

const notifications = vi.hoisted(() => ({ addToast: vi.fn() }));
const ipcListeners = vi.hoisted(() => ({
  callbacks: new Map<string, (event: unknown) => void>(),
}));

function makeSelectableStore<T extends object>(state: T) {
  return vi.fn((selector: (store: T) => unknown) => selector(state));
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
  ProseMarkdown: ({ content }: { content: string }) => <div data-testid="markdown-preview">{content}</div>,
}));
vi.mock('../src/renderer/components/file-browser/CodeMirrorEditor', async () => {
  const ReactModule = await vi.importActual<typeof import('react')>('react');
  const { EditorSession } = await vi.importActual<
    typeof import('../src/renderer/components/file-browser/EditorSession')
  >('../src/renderer/components/file-browser/EditorSession');

  return {
    CodeMirrorEditor: (props: {
      content: string;
      contentVersion?: string;
      eol?: 'lf' | 'crlf' | 'cr';
      fileKey: string;
      hasBom?: boolean;
      onConflict?: (response: Extract<FileWriteResponse, { success: false }>) => void;
      onError?: (error: unknown) => void;
      onSaved?: (content: string, response: Extract<FileWriteResponse, { success: true }>) => void;
      onSessionReady?: (session: InstanceType<typeof EditorSession> | null) => void;
      readOnly?: boolean;
      relativePath: string;
      rootPath: string;
    }) => {
      const [value, setValue] = ReactModule.useState(props.content);
      const valueRef = ReactModule.useRef(value);
      const sessionRef = ReactModule.useRef<InstanceType<typeof EditorSession> | null>(null);
      if (!sessionRef.current && props.contentVersion && !props.readOnly) {
        sessionRef.current = new EditorSession({
          contentVersion: props.contentVersion,
          eol: props.eol ?? 'lf',
          fileKey: props.fileKey,
          hasBom: props.hasBom ?? false,
          relativePath: props.relativePath,
          rootPath: props.rootPath,
          snapshot: () => valueRef.current,
          applyChanges: (changes: readonly TextChange[]) => {
            let nextValue = valueRef.current;
            for (let index = changes.length - 1; index >= 0; index -= 1) {
              const change = changes[index];
              nextValue = nextValue.slice(0, change.from) + change.insert + nextValue.slice(change.to);
            }
            valueRef.current = nextValue;
            setValue(nextValue);
            sessionRef.current?.documentChanged();
          },
          write: fileApi.writeFileContent,
          onConflict: props.onConflict,
          onError: props.onError,
          onSaved: props.onSaved,
        });
      }
      ReactModule.useEffect(() => {
        const session = sessionRef.current;
        props.onSessionReady?.(session);
        return () => {
          props.onSessionReady?.(null);
          session?.dispose();
        };
      }, []);

      return (
        <textarea
          aria-label="editor"
          readOnly={props.readOnly}
          value={value}
          onChange={(event) => {
            valueRef.current = event.currentTarget.value;
            setValue(event.currentTarget.value);
            sessionRef.current?.documentChanged();
          }}
        />
      );
    },
  };
});

function success(request: FileWriteRequest, hash = `hash-${request.saveSequence}`): FileWriteResponse {
  return {
    success: true,
    contentVersion: hash,
    documentVersion: request.documentVersion,
    editorSessionId: request.editorSessionId,
    saveSequence: request.saveSequence,
  };
}

function conflict(
  request: FileWriteRequest,
  conflictType: 'deleted' | 'modified' = 'modified',
): FileWriteResponse {
  return {
    success: false,
    conflict: true,
    conflictType,
    documentVersion: request.documentVersion,
    editorSessionId: request.editorSessionId,
    error: 'Disk conflict',
    saveSequence: request.saveSequence,
  };
}

function editable(content: string, contentVersion: string) {
  return {
    kind: 'editable-text' as const,
    content,
    contentVersion,
    encoding: 'utf8' as const,
    eol: 'lf' as const,
    hasBom: false,
  };
}

function resetFileBrowserState(relativePath = 'notes.ts'): void {
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
    viewingFile: {
      content: 'original',
      contentVersion: 'hash-0',
      eol: 'lf',
      hasBom: false,
      loading: false,
      relativePath,
      rootPath: '/repo',
    },
  });
}

describe('FileViewer editor session integration', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    ipcListeners.callbacks.clear();
    resetFileBrowserState();
    fileApi.writeFileContent.mockImplementation(async (request: FileWriteRequest) => success(request));
    fileApi.formatFileContent.mockImplementation(async (request) => ({
      success: true,
      changes: [{ from: 0, to: request.content.length, insert: 'formatted\n' }],
      documentVersion: request.documentVersion,
      editorSessionId: request.editorSessionId,
      fileKey: request.fileKey,
      requestId: request.requestId,
      status: 'formatted',
    }));
    fileApi.readFileContent.mockResolvedValue(editable('next file', 'hash-next'));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('flushes the session snapshot before opening another file', async () => {
    render(<FileViewer />);
    fireEvent.change(screen.getByLabelText('editor'), { target: { value: 'edited before switch' } });

    await act(async () => {
      await useFileBrowserStore.getState().openFile('/repo', 'next.ts');
    });

    expect(fileApi.writeFileContent).toHaveBeenCalledWith(expect.objectContaining({
      content: 'edited before switch',
      documentVersion: 1,
      expectedContentVersion: 'hash-0',
      relativePath: 'notes.ts',
      rootPath: '/repo',
      saveSequence: 1,
    }));
    expect(useFileBrowserStore.getState().viewingFile?.relativePath).toBe('next.ts');
  });

  it('keeps a dirty file open and read-only when the flush conflicts', async () => {
    fileApi.writeFileContent.mockImplementation(async (request: FileWriteRequest) => conflict(request));
    render(<FileViewer />);
    fireEvent.change(screen.getByLabelText('editor'), { target: { value: 'local edit' } });

    await act(async () => {
      await useFileBrowserStore.getState().closeFile();
    });

    expect(useFileBrowserStore.getState().viewingFile).toMatchObject({
      conflictDetected: true,
      conflictType: 'modified',
      relativePath: 'notes.ts',
    });
    expect(screen.getByLabelText('editor')).toHaveProperty('readOnly', true);
  });

  it('rejects an external rewrite while the session is dirty', async () => {
    fileApi.readFileContent.mockResolvedValue(editable('external edit', 'external-hash'));
    render(<FileViewer />);
    fireEvent.change(screen.getByLabelText('editor'), { target: { value: 'local edit' } });

    await act(async () => {
      ipcListeners.callbacks.get(IPC_EVENT.FILE_CHANGED)?.({
        changeType: 'change',
        relativePath: 'notes.ts',
        rootPath: '/repo',
      });
      await Promise.resolve();
    });

    expect(useFileBrowserStore.getState().viewingFile?.conflictDetected).toBe(true);
    expect((screen.getByLabelText('editor') as HTMLTextAreaElement).value).toBe('local edit');
  });

  it('preserves the read-only capability tier after an external large-file rewrite', async () => {
    fileApi.readFileContent.mockResolvedValue({
      ...editable('x'.repeat(1_100_000), 'large-hash'),
    });
    render(<FileViewer />);

    await act(async () => {
      ipcListeners.callbacks.get(IPC_EVENT.FILE_CHANGED)?.({
        changeType: 'change',
        relativePath: 'notes.ts',
        rootPath: '/repo',
      });
      await Promise.resolve();
    });

    expect(useFileBrowserStore.getState().viewingFile?.capabilityTier).toBe('read-only');
    expect(screen.getByLabelText('editor')).toHaveProperty('readOnly', true);
  });

  it('remounts a clean session when only its BOM or EOL representation changes', async () => {
    fileApi.readFileContent.mockResolvedValue({
      ...editable('original', 'external-hash'),
      eol: 'crlf',
      hasBom: true,
    });
    render(<FileViewer />);

    await act(async () => {
      ipcListeners.callbacks.get(IPC_EVENT.FILE_CHANGED)?.({
        changeType: 'change',
        relativePath: 'notes.ts',
        rootPath: '/repo',
      });
      await Promise.resolve();
    });
    fireEvent.change(screen.getByLabelText('editor'), { target: { value: 'next edit' } });
    await act(async () => {
      await useFileBrowserStore.getState().closeFile();
    });

    expect(fileApi.writeFileContent).toHaveBeenCalledWith(expect.objectContaining({
      content: 'next edit',
      eol: 'crlf',
      expectedContentVersion: 'external-hash',
      hasBom: true,
    }));
  });

  it('reports deletion only after the rewrite grace period', async () => {
    vi.useFakeTimers();
    fileApi.readFileContent.mockResolvedValue({
      kind: 'error',
      code: 'NOT_FOUND',
      message: 'File not found',
    });
    render(<FileViewer />);
    fireEvent.change(screen.getByLabelText('editor'), { target: { value: 'local edit' } });

    await act(async () => {
      ipcListeners.callbacks.get(IPC_EVENT.FILE_CHANGED)?.({
        changeType: 'unlink',
        relativePath: 'notes.ts',
        rootPath: '/repo',
      });
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(useFileBrowserStore.getState().viewingFile?.conflictDetected).not.toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(useFileBrowserStore.getState().viewingFile?.conflictType).toBe('deleted');
  });

  it('recreates a deleted file from the live editor snapshot', async () => {
    vi.useFakeTimers();
    fileApi.readFileContent.mockResolvedValue({
      kind: 'error',
      code: 'NOT_FOUND',
      message: 'File not found',
    });
    render(<FileViewer />);
    fireEvent.change(screen.getByLabelText('editor'), { target: { value: 'preserved edit' } });
    await act(async () => {
      ipcListeners.callbacks.get(IPC_EVENT.FILE_CHANGED)?.({
        changeType: 'unlink',
        relativePath: 'notes.ts',
        rootPath: '/repo',
      });
      await vi.advanceTimersByTimeAsync(300);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Recreate file from local edits' }));
      await Promise.resolve();
    });

    expect(fileApi.writeFileContent).toHaveBeenCalledWith(expect.objectContaining({
      content: 'preserved edit',
      expectedContentVersion: null,
      expectedMissing: true,
    }));
    expect(useFileBrowserStore.getState().viewingFile?.conflictDetected).toBe(false);
  });

  it('renders mixed-EOL text read-only and never creates a save session', async () => {
    useFileBrowserStore.setState({
      viewingFile: {
        content: 'a\r\nb\n',
        hasBom: false,
        loading: false,
        readOnlyReason: 'mixed-eol',
        relativePath: 'mixed.txt',
        rootPath: '/repo',
        sizeBytes: 5,
      },
    });
    render(<FileViewer />);

    expect(screen.getByText('Mixed line endings')).toBeTruthy();
    expect(screen.getByLabelText('editor')).toHaveProperty('readOnly', true);
    await act(async () => {
      await useFileBrowserStore.getState().flushPendingFileSave();
    });
    expect(fileApi.writeFileContent).not.toHaveBeenCalled();
  });

  it('opens markdown in preview and switches to the editor on demand', async () => {
    resetFileBrowserState('README.md');
    render(<FileViewer />);

    expect(screen.getByTestId('markdown-preview').textContent).toBe('original');
    expect(screen.queryByLabelText('editor')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit markdown' }));
    expect(screen.getByLabelText('editor')).toBeTruthy();
  });

  it('formats only on an explicit command and applies all changes in one editor update', async () => {
    render(<FileViewer />);
    expect(fileApi.formatFileContent).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Format document' }));
      await Promise.resolve();
    });

    expect(fileApi.formatFileContent).toHaveBeenCalledWith(expect.objectContaining({
      content: 'original',
      documentVersion: 0,
      editorSessionId: expect.any(String),
      fileKey: '["/repo","notes.ts"]',
    }));
    expect((screen.getByLabelText('editor') as HTMLTextAreaElement).value).toBe('formatted\n');
  });
});
