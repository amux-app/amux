const DEFAULT_MAX_HEADER_BYTES = 8 * 1024;
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const HEADER_SEPARATOR = Buffer.from('\r\n\r\n');

type JsonRpcId = number | string | null;

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface LspFrameParserOptions {
  maxFrameBytes?: number;
  maxHeaderBytes?: number;
}

export class LspFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LspFramingError';
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== '2.0') return false;

  const hasId = hasOwn(message, 'id');
  const id = message.id;
  if (hasId && id !== null && typeof id !== 'number' && typeof id !== 'string') return false;
  if (typeof message.method === 'string') return true;
  if (!hasId) return false;

  const hasResult = hasOwn(message, 'result');
  const hasError = hasOwn(message, 'error');
  if (hasResult === hasError) return false;
  if (!hasError) return true;
  if (typeof message.error !== 'object' || message.error === null) return false;
  const error = message.error as Record<string, unknown>;
  return typeof error.code === 'number' && typeof error.message === 'string';
}

export function encodeLspFrame(message: JsonRpcMessage | unknown): Buffer {
  if (!isJsonRpcMessage(message)) throw new LspFramingError('Invalid JSON-RPC message');
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
    body,
  ]);
}

export class LspFrameParser {
  private bufferedBytes = 0;
  private chunkIndex = 0;
  private chunkOffset = 0;
  private chunks: Buffer[] = [];
  private expectedBodyBytes: number | null = null;
  private failed = false;
  private readonly maxFrameBytes: number;
  private readonly maxHeaderBytes: number;

  constructor(options: LspFrameParserOptions = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.maxHeaderBytes = options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
  }

  push(chunk: Buffer): JsonRpcMessage[] {
    if (this.failed) throw new LspFramingError('LSP byte stream is unusable after a framing failure');
    if (chunk.length === 0) return [];
    this.chunks.push(chunk);
    this.bufferedBytes += chunk.length;
    const messages: JsonRpcMessage[] = [];

    try {
      while (this.bufferedBytes > 0) {
        if (this.expectedBodyBytes === null) {
          const probeLength = Math.min(
            this.bufferedBytes,
            this.maxHeaderBytes + HEADER_SEPARATOR.length,
          );
          const separatorIndex = this.peek(probeLength).indexOf(HEADER_SEPARATOR);
          if (separatorIndex < 0) {
            if (this.bufferedBytes > this.maxHeaderBytes) this.fail('LSP header exceeds configured cap');
            break;
          }
          if (separatorIndex > this.maxHeaderBytes) this.fail('LSP header exceeds configured cap');

          const framedHeader = this.read(separatorIndex + HEADER_SEPARATOR.length);
          const header = framedHeader.subarray(0, separatorIndex).toString('ascii');
          const contentLengthHeader = header
            .split('\r\n')
            .find((line) => line.toLowerCase().startsWith('content-length:'));
          if (!contentLengthHeader) this.fail('LSP frame is missing Content-Length');
          const rawLength = contentLengthHeader.slice(contentLengthHeader.indexOf(':') + 1).trim();
          if (!/^\d+$/.test(rawLength)) this.fail('LSP Content-Length is malformed');
          const contentLength = Number(rawLength);
          if (!Number.isSafeInteger(contentLength)) this.fail('LSP Content-Length is invalid');
          if (contentLength > this.maxFrameBytes) this.fail('LSP frame exceeds configured cap');
          this.expectedBodyBytes = contentLength;
        }

        if (this.bufferedBytes < this.expectedBodyBytes) break;
        const body = this.read(this.expectedBodyBytes).toString('utf8');
        this.expectedBodyBytes = null;

        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          this.fail('LSP frame contains invalid JSON');
        }
        if (!isJsonRpcMessage(parsed)) this.fail('LSP frame contains an invalid JSON-RPC envelope');
        messages.push(parsed);
      }
      return messages;
    } catch (error) {
      this.failed = true;
      this.bufferedBytes = 0;
      this.chunkIndex = 0;
      this.chunkOffset = 0;
      this.chunks = [];
      this.expectedBodyBytes = null;
      throw error;
    }
  }

  private peek(length: number): Buffer {
    const first = this.chunks[this.chunkIndex];
    if (!first || length === 0) return Buffer.alloc(0);
    const firstAvailable = first.length - this.chunkOffset;
    if (firstAvailable >= length) {
      return first.subarray(this.chunkOffset, this.chunkOffset + length);
    }

    const result = Buffer.allocUnsafe(length);
    let copied = 0;
    let index = this.chunkIndex;
    let offset = this.chunkOffset;
    while (copied < length) {
      const current = this.chunks[index];
      const copyLength = Math.min(current.length - offset, length - copied);
      current.copy(result, copied, offset, offset + copyLength);
      copied += copyLength;
      index += 1;
      offset = 0;
    }
    return result;
  }

  private read(length: number): Buffer {
    const result = this.peek(length);
    let remaining = length;
    while (remaining > 0) {
      const current = this.chunks[this.chunkIndex];
      const available = current.length - this.chunkOffset;
      if (remaining < available) {
        this.chunkOffset += remaining;
        remaining = 0;
      } else {
        remaining -= available;
        this.chunkIndex += 1;
        this.chunkOffset = 0;
      }
    }
    this.bufferedBytes -= length;
    if (this.bufferedBytes === 0) {
      this.chunks = [];
      this.chunkIndex = 0;
      this.chunkOffset = 0;
    } else if (this.chunkIndex > 1_024 && this.chunkIndex * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.chunkIndex);
      this.chunkIndex = 0;
    }
    return result;
  }

  private fail(message: string): never {
    throw new LspFramingError(message);
  }
}
