import { fileURLToPath } from 'node:url';
import { utilityProcess } from 'electron';
import type {
  FormatDocumentRequest,
  FormatDocumentResponse,
  TextChange,
} from '../../shared/ipc-types.js';
import { EditorRuntimeMetrics } from './EditorRuntimeMetrics.js';

const FORMAT_TIMEOUT_MS = 5_000;

export interface FormatterChildProcess {
  kill(): void;
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'exit', listener: (code: number | null) => void): this;
  postMessage(message: unknown): void;
}

interface FormatterServiceOptions {
  spawn?: () => FormatterChildProcess | Promise<FormatterChildProcess>;
}

interface QueuedFormat {
  request: FormatDocumentRequest;
  resolve: (response: FormatDocumentResponse) => void;
}

function responseIdentity(request: FormatDocumentRequest) {
  return {
    documentVersion: request.documentVersion,
    editorSessionId: request.editorSessionId,
    fileKey: request.fileKey,
    requestId: request.requestId,
  };
}

function errorResponse(
  request: FormatDocumentRequest,
  code: Extract<FormatDocumentResponse, { success: false }>['code'],
  error: string,
): FormatDocumentResponse {
  return { ...responseIdentity(request), success: false, code, error };
}

function isTextChange(value: unknown): value is TextChange {
  if (typeof value !== 'object' || value === null) return false;
  const change = value as Partial<TextChange>;
  return Number.isInteger(change.from)
    && Number.isInteger(change.to)
    && typeof change.insert === 'string'
    && (change.from ?? -1) >= 0
    && (change.to ?? -1) >= (change.from ?? 0);
}

function isMatchingResponse(
  value: unknown,
  request: FormatDocumentRequest,
): value is FormatDocumentResponse {
  if (typeof value !== 'object' || value === null) return false;
  const response = value as Partial<FormatDocumentResponse>;
  if (
    response.documentVersion !== request.documentVersion
    || response.editorSessionId !== request.editorSessionId
    || response.fileKey !== request.fileKey
    || response.requestId !== request.requestId
    || typeof response.success !== 'boolean'
  ) return false;
  if (response.success) {
    return (response.status === 'formatted' || response.status === 'ignored' || response.status === 'unchanged')
      && Array.isArray(response.changes)
      && response.changes.length <= 10_000
      && response.changes.every(isTextChange);
  }
  return typeof (response as { error?: unknown }).error === 'string';
}

async function spawnFormatterWorker(): Promise<FormatterChildProcess> {
  const workerPath = fileURLToPath(new URL('./formatterWorker.js', import.meta.url));
  return utilityProcess.fork(workerPath, [], {
    serviceName: 'Amux document formatter',
  });
}

export class FormatterService {
  private active = false;
  private activeCancel: (() => void) | null = null;
  private activeRequestId: string | null = null;
  private readonly cancelled = new Set<string>();
  private queued: QueuedFormat | null = null;
  private readonly spawn: () => FormatterChildProcess | Promise<FormatterChildProcess>;

  constructor(options: FormatterServiceOptions = {}) {
    this.spawn = options.spawn ?? spawnFormatterWorker;
  }

  format(request: FormatDocumentRequest): Promise<FormatDocumentResponse> {
    if (this.active) {
      if (this.queued) {
        this.queued.resolve(errorResponse(
          this.queued.request,
          'SUPERSEDED',
          'A newer format request superseded this queued request',
        ));
      }
      return new Promise((resolve) => {
        this.queued = { request, resolve };
      });
    }
    this.active = true;
    return this.runAndDrain(request);
  }

  cancel(requestId: string): boolean {
    if (this.queued?.request.requestId === requestId) {
      this.queued.resolve(errorResponse(this.queued.request, 'CANCELLED', 'Format request was cancelled'));
      this.queued = null;
      return true;
    }
    if (this.activeRequestId !== requestId) return false;
    this.cancelled.add(requestId);
    this.activeCancel?.();
    return true;
  }

  private async runAndDrain(request: FormatDocumentRequest): Promise<FormatDocumentResponse> {
    try {
      return await this.run(request);
    } finally {
      const queued = this.queued;
      this.queued = null;
      if (!queued) {
        this.active = false;
      } else {
        void this.runAndDrain(queued.request).then(queued.resolve);
      }
    }
  }

  private async run(request: FormatDocumentRequest): Promise<FormatDocumentResponse> {
    this.activeRequestId = request.requestId;
    let child: FormatterChildProcess;
    try {
      child = await this.spawn();
      EditorRuntimeMetrics.getInstance().recordFormatterStarted();
    } catch (error) {
      this.cancelled.delete(request.requestId);
      this.activeRequestId = null;
      return errorResponse(request, 'CRASHED', `Formatter failed to start: ${String(error)}`);
    }

    if (this.cancelled.delete(request.requestId)) {
      child.kill();
      EditorRuntimeMetrics.getInstance().recordFormatterStopped();
      this.activeRequestId = null;
      return errorResponse(request, 'CANCELLED', 'Format request was cancelled');
    }

    return new Promise((resolve) => {
      let finished = false;
      const finish = (response: FormatDocumentResponse) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try {
          child.kill();
        } catch {
          // The process may already have exited.
        }
        EditorRuntimeMetrics.getInstance().recordFormatterStopped();
        this.activeCancel = null;
        this.activeRequestId = null;
        this.cancelled.delete(request.requestId);
        resolve(response);
      };
      this.activeCancel = () => {
        finish(errorResponse(request, 'CANCELLED', 'Format request was cancelled'));
      };
      const timer = setTimeout(() => {
        finish(errorResponse(request, 'TIMEOUT', 'Formatter exceeded the 5 second limit'));
      }, FORMAT_TIMEOUT_MS);

      child.on('message', (message) => {
        finish(isMatchingResponse(message, request)
          ? message
          : errorResponse(request, 'INVALID_RESPONSE', 'Formatter returned an invalid response'));
      });
      child.on('exit', () => {
        finish(errorResponse(request, 'CRASHED', 'Formatter process exited unexpectedly'));
      });
      try {
        child.postMessage(request);
      } catch (error) {
        finish(errorResponse(request, 'CRASHED', `Formatter request failed: ${String(error)}`));
      }
    });
  }
}
