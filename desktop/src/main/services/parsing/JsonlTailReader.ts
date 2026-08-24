import { createHash } from 'crypto';
import { open, type FileHandle } from 'fs/promises';
import { EMPTY_BUFFER, readRegion } from './file-regions.js';

const CHUNK_BYTES = 1024 * 1024;
const HEAD_SAMPLE_BYTES = 4096;
const TAIL_SAMPLE_BYTES = 4096;
const HASH_ALGORITHM = 'sha1';
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const CLOSING_BRACE = 0x7d;

/**
 * Durable resume point for one JSONL file. `offset` always lands on a record
 * boundary; file identity plus sampled hashes detect rewrites (`/compact`,
 * truncation, rotation) before the offset is trusted again.
 */
export interface JsonlCheckpoint {
  ctimeMs: number;
  ino: number;
  offset: number;
  size: number;
  headHash: string;
  tailHash: string;
}

export type JsonlLineSink = (line: string) => void;

/**
 * Streams the lines a JSONL file gained since `previous`, or the whole file when
 * the previous checkpoint cannot be trusted. `createSink` is called exactly once,
 * before any line is read, with whether the caller may keep its retained state.
 */
export async function readJsonlTail(
  filePath: string,
  previous: JsonlCheckpoint | null | undefined,
  createSink: (resumed: boolean) => JsonlLineSink,
): Promise<JsonlCheckpoint> {
  const handle = await open(filePath, 'r');
  try {
    const stats = await handle.stat();
    const resumeOffset = await resolveResumeOffset(handle, stats.size, stats.ino, stats.ctimeMs, previous);
    const sink = createSink(resumeOffset > 0);
    const consumed = await consumeLines(handle, resumeOffset, stats.size, sink);
    return {
      ctimeMs: stats.ctimeMs,
      ino: stats.ino,
      offset: consumed,
      size: stats.size,
      headHash: await hashRegion(handle, 0, Math.min(HEAD_SAMPLE_BYTES, consumed)),
      tailHash: await hashRegion(handle, Math.max(0, consumed - TAIL_SAMPLE_BYTES), consumed),
    };
  } finally {
    await handle.close();
  }
}

async function resolveResumeOffset(
  handle: FileHandle,
  size: number,
  ino: number,
  ctimeMs: number,
  previous: JsonlCheckpoint | null | undefined,
): Promise<number> {
  if (!previous || previous.offset <= 0) return 0;
  if (previous.ino !== ino || size < previous.offset) return 0;
  // ctime changes for both appends and rewrites. It is a rewrite signal only
  // when the total size stayed fixed; a larger file remains the normal append
  // path and is still validated by the consumed head/tail hashes below.
  if (previous.size === size && previous.ctimeMs !== ctimeMs) return 0;

  const head = await readRegion(handle, 0, Math.min(HEAD_SAMPLE_BYTES, previous.offset));
  if (hashBuffer(head) !== previous.headHash) return 0;

  const tail = await readRegion(handle, Math.max(0, previous.offset - TAIL_SAMPLE_BYTES), previous.offset);
  if (!endsOnRecordBoundary(tail)) return 0;
  if (hashBuffer(tail) !== previous.tailHash) return 0;

  return previous.offset;
}

async function consumeLines(
  handle: FileHandle,
  start: number,
  size: number,
  sink: JsonlLineSink,
): Promise<number> {
  const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(size - start, 1)));
  let carry = EMPTY_BUFFER;
  let position = start;
  let consumed = start;

  while (position < size) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - position), position);
    if (bytesRead <= 0) break;
    position += bytesRead;

    const pending = joinCarry(carry, chunk.subarray(0, bytesRead));
    const lineStart = emitLines(pending, sink);
    consumed = position - (pending.length - lineStart);
    carry = Buffer.from(pending.subarray(lineStart));
  }

  if (carry.length > 0 && isCompleteJsonRecord(carry)) {
    sink(decodeLine(carry));
    consumed = position;
  }
  return consumed;
}

function joinCarry(carry: Buffer, fresh: Buffer): Buffer {
  return carry.length > 0 ? Buffer.concat([carry, fresh]) : fresh;
}

function emitLines(buffer: Buffer, sink: JsonlLineSink): number {
  let lineStart = 0;
  let newlineIndex = buffer.indexOf(NEWLINE);

  while (newlineIndex !== -1) {
    sink(decodeLine(buffer.subarray(lineStart, newlineIndex)));
    lineStart = newlineIndex + 1;
    newlineIndex = buffer.indexOf(NEWLINE, lineStart);
  }
  return lineStart;
}

function decodeLine(buffer: Buffer): string {
  const end = buffer.length > 0 && buffer[buffer.length - 1] === CARRIAGE_RETURN
    ? buffer.length - 1
    : buffer.length;
  return buffer.toString('utf8', 0, end);
}

/**
 * A trailing fragment is only committed when it is already a whole JSON record,
 * which keeps an incremental read identical to a full read of the same bytes:
 * a strict prefix of a JSON object never parses, so a half-written line waits.
 */
function isCompleteJsonRecord(buffer: Buffer): boolean {
  if (buffer[buffer.length - 1] !== CLOSING_BRACE) return false;
  try {
    JSON.parse(decodeLine(buffer));
    return true;
  } catch {
    return false;
  }
}

function endsOnRecordBoundary(buffer: Buffer): boolean {
  const last = buffer[buffer.length - 1];
  return last === NEWLINE || last === CLOSING_BRACE;
}

function hashBuffer(buffer: Buffer): string {
  return createHash(HASH_ALGORITHM).update(buffer).digest('hex');
}

async function hashRegion(handle: FileHandle, start: number, end: number): Promise<string> {
  return hashBuffer(await readRegion(handle, start, end));
}
