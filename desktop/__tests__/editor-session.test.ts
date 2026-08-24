import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileWriteRequest, FileWriteResponse } from '../src/shared/ipc-types';
import { EditorSession } from '../src/renderer/components/file-browser/EditorSession';

function successfulWrite(request: FileWriteRequest, hash: string): FileWriteResponse {
  return {
    success: true,
    contentVersion: hash,
    documentVersion: request.documentVersion,
    editorSessionId: request.editorSessionId,
    saveSequence: request.saveSequence,
  };
}

describe('EditorSession', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does O(1) bookkeeping without materializing the document on each edit', () => {
    vi.useFakeTimers();
    const snapshot = vi.fn(() => 'large document');
    const session = new EditorSession({
      contentVersion: 'initial-hash',
      eol: 'lf',
      fileKey: 'file-key',
      hasBom: false,
      relativePath: 'src/app.ts',
      rootPath: '/repo',
      snapshot,
      write: vi.fn(),
    });

    session.documentChanged();
    session.documentChanged();
    session.documentChanged();

    expect(session.documentVersion).toBe(3);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('materializes once after the autosave debounce and emits exact session identity', async () => {
    vi.useFakeTimers();
    const write = vi.fn(async (request: FileWriteRequest) => successfulWrite(request, 'saved-hash'));
    const snapshot = vi.fn(() => 'edited\r\n');
    const session = new EditorSession({
      autosaveDelayMs: 800,
      contentVersion: 'initial-hash',
      eol: 'crlf',
      fileKey: 'file-key',
      hasBom: true,
      id: 'session-1',
      relativePath: 'src/app.ts',
      rootPath: '/repo',
      snapshot,
      write,
    });

    session.documentChanged();
    await vi.advanceTimersByTimeAsync(800);

    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({
      content: 'edited\r\n',
      documentVersion: 1,
      editorSessionId: 'session-1',
      eol: 'crlf',
      expectedContentVersion: 'initial-hash',
      hasBom: true,
      relativePath: 'src/app.ts',
      rootPath: '/repo',
      saveSequence: 1,
    });
    expect(session.contentVersion).toBe('saved-hash');
    expect(session.isDirty).toBe(false);
  });

  it('chains queued saves through returned hashes without marking newer edits clean', async () => {
    vi.useFakeTimers();
    let content = 'first';
    let resolveFirst!: (response: FileWriteResponse) => void;
    const firstResult = new Promise<FileWriteResponse>((resolve) => {
      resolveFirst = resolve;
    });
    const write = vi.fn()
      .mockImplementationOnce(() => firstResult)
      .mockImplementationOnce(async (request: FileWriteRequest) => successfulWrite(request, 'hash-2'));
    const session = new EditorSession({
      autosaveDelayMs: 800,
      contentVersion: 'hash-0',
      eol: 'lf',
      fileKey: 'file-key',
      hasBom: false,
      id: 'session-1',
      relativePath: 'src/app.ts',
      rootPath: '/repo',
      snapshot: () => content,
      write,
    });

    session.documentChanged();
    await vi.advanceTimersByTimeAsync(800);
    content = 'second';
    session.documentChanged();
    await vi.advanceTimersByTimeAsync(800);
    expect(write).toHaveBeenCalledTimes(1);

    resolveFirst(successfulWrite(write.mock.calls[0][0], 'hash-1'));
    await firstResult;
    await vi.runAllTimersAsync();
    await session.waitForPendingSaves();

    expect(write.mock.calls[1][0]).toMatchObject({
      content: 'second',
      documentVersion: 2,
      expectedContentVersion: 'hash-1',
      saveSequence: 2,
    });
    expect(session.contentVersion).toBe('hash-2');
    expect(session.isDirty).toBe(false);
  });

  it('rejects a response for a disposed session even when the same file can reopen', async () => {
    let resolveWrite!: (response: FileWriteResponse) => void;
    const result = new Promise<FileWriteResponse>((resolve) => {
      resolveWrite = resolve;
    });
    const write = vi.fn(() => result);
    const session = new EditorSession({
      contentVersion: 'hash-0',
      eol: 'lf',
      fileKey: 'file-key',
      hasBom: false,
      id: 'closed-session',
      relativePath: 'src/app.ts',
      rootPath: '/repo',
      snapshot: () => 'edited',
      write,
    });
    session.documentChanged();
    const save = session.flush();
    await Promise.resolve();
    session.dispose();

    resolveWrite(successfulWrite(write.mock.calls[0][0], 'stale-hash'));

    await expect(save).resolves.toBe(false);
    expect(session.contentVersion).toBe('hash-0');
  });

  it('restores a missing file and chains the restored hash into the next save', async () => {
    let content = 'restored';
    const write = vi.fn(async (request: FileWriteRequest) => successfulWrite(
      request,
      request.expectedMissing ? 'restored-hash' : 'second-hash',
    ));
    const session = new EditorSession({
      contentVersion: 'deleted-hash',
      eol: 'lf',
      fileKey: 'file-key',
      hasBom: false,
      id: 'session-1',
      relativePath: 'src/app.ts',
      rootPath: '/repo',
      snapshot: () => content,
      write,
    });
    session.documentChanged();

    await expect(session.flush({ expectedMissing: true })).resolves.toBe(true);
    content = 'edited again';
    session.documentChanged();
    await expect(session.flush()).resolves.toBe(true);

    expect(write.mock.calls[0][0]).toMatchObject({
      expectedContentVersion: null,
      expectedMissing: true,
    });
    expect(write.mock.calls[1][0]).toMatchObject({
      expectedContentVersion: 'restored-hash',
    });
  });
});
