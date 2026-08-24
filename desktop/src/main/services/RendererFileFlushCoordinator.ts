import type { AppFileFlushResultRequest } from '../../shared/ipc-types.js';

interface PendingFlush {
  promise: Promise<boolean>;
  requestId: string;
  resolve: (success: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 5_000;
let nextRequestId = 0;

export class RendererFileFlushCoordinator {
  private pending: PendingFlush | null = null;

  constructor(private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {}

  request(send: (requestId: string) => void): Promise<boolean> {
    if (this.pending) {
      return this.pending.promise;
    }

    const requestId = `file-flush-${++nextRequestId}`;
    let resolvePromise!: (success: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      resolvePromise = resolve;
    });
    const timeout = setTimeout(() => {
      this.settle(requestId, false);
    }, this.timeoutMs);

    this.pending = {
      promise,
      requestId,
      resolve: resolvePromise,
      timeout,
    };

    try {
      send(requestId);
    } catch {
      this.settle(requestId, false);
    }
    return promise;
  }

  complete(result: AppFileFlushResultRequest): boolean {
    if (this.pending?.requestId !== result.requestId) {
      return false;
    }

    this.settle(result.requestId, result.success);
    return true;
  }

  private settle(requestId: string, success: boolean): void {
    const pending = this.pending;
    if (!pending || pending.requestId !== requestId) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending = null;
    pending.resolve(success);
  }
}
