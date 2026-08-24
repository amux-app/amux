import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  FormatDocumentRequest,
  FormatDocumentResponse,
} from '../../src/shared/ipc-types';
import {
  FormatterService,
  type FormatterChildProcess,
} from '../../src/main/services/FormatterService';

class FakeFormatterChild extends EventEmitter implements FormatterChildProcess {
  readonly kill = vi.fn();
  readonly postMessage = vi.fn();
}

function request(requestId: string): FormatDocumentRequest {
  return {
    content: 'const value={answer:42}\n',
    documentVersion: 1,
    editorSessionId: 'session-1',
    eol: 'lf',
    fileKey: '["/repo","src/app.ts"]',
    relativePath: 'src/app.ts',
    requestId,
    rootPath: '/repo',
  };
}

function response(input: FormatDocumentRequest): FormatDocumentResponse {
  return {
    success: true,
    changes: [{ from: 11, to: 11, insert: ' ' }],
    documentVersion: input.documentVersion,
    editorSessionId: input.editorSessionId,
    fileKey: input.fileKey,
    requestId: input.requestId,
    status: 'formatted',
  };
}

describe('FormatterService', () => {
  afterEach(() => vi.useRealTimers());

  it('runs one utility process at a time and supersedes only the older queued request', async () => {
    const children: FakeFormatterChild[] = [];
    const service = new FormatterService({
      spawn: () => {
        const child = new FakeFormatterChild();
        children.push(child);
        return child;
      },
    });
    const firstRequest = request('first');
    const secondRequest = request('second');
    const thirdRequest = request('third');

    const first = service.format(firstRequest);
    const second = service.format(secondRequest);
    const third = service.format(thirdRequest);

    await expect(second).resolves.toMatchObject({ success: false, code: 'SUPERSEDED' });
    expect(children).toHaveLength(1);
    children[0].emit('message', response(firstRequest));
    await expect(first).resolves.toMatchObject({ success: true, requestId: 'first' });
    await Promise.resolve();
    expect(children).toHaveLength(2);
    children[1].emit('message', response(thirdRequest));
    await expect(third).resolves.toMatchObject({ success: true, requestId: 'third' });
    expect(children.every((child) => child.kill.mock.calls.length === 1)).toBe(true);
  });

  it('kills a formatter that exceeds the five-second request budget', async () => {
    vi.useFakeTimers();
    const child = new FakeFormatterChild();
    const service = new FormatterService({ spawn: () => child });

    const format = service.format(request('timeout'));
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(format).resolves.toMatchObject({ success: false, code: 'TIMEOUT' });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('reports a crash and cleans up the utility process', async () => {
    const child = new FakeFormatterChild();
    const service = new FormatterService({ spawn: () => child });

    const format = service.format(request('crash'));
    await Promise.resolve();
    child.emit('exit', 1);

    await expect(format).resolves.toMatchObject({ success: false, code: 'CRASHED' });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('returns a structured failure when sending to the worker throws', async () => {
    const child = new FakeFormatterChild();
    child.postMessage.mockImplementation(() => {
      throw new Error('worker closed');
    });
    const service = new FormatterService({ spawn: () => child });

    await expect(service.format(request('send-failure'))).resolves.toMatchObject({
      success: false,
      code: 'CRASHED',
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('cancels an active request and terminates its utility process', async () => {
    const child = new FakeFormatterChild();
    const service = new FormatterService({ spawn: () => child });

    const format = service.format(request('cancel'));
    await Promise.resolve();
    expect(service.cancel('cancel')).toBe(true);

    await expect(format).resolves.toMatchObject({ success: false, code: 'CANCELLED' });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
