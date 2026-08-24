import { open, type FileHandle } from 'fs/promises';

export const EMPTY_BUFFER = Buffer.alloc(0);

/** Reads the `[start, end)` byte window of an open file. */
export async function readRegion(handle: FileHandle, start: number, end: number): Promise<Buffer> {
  const length = Math.max(0, end - start);
  if (length === 0) return EMPTY_BUFFER;
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, start);
  return buffer.subarray(0, bytesRead);
}

/**
 * Lines of the `[start, end)` window. A window that does not begin at byte 0 opens
 * mid-record, so its first fragment is dropped rather than parsed.
 */
export async function readRegionLines(handle: FileHandle, start: number, end: number): Promise<string[]> {
  const lines = (await readRegion(handle, start, end)).toString('utf8').split('\n');
  if (start > 0) lines.shift();
  return lines;
}

/** Reads at most the last `maxBytes` of a file as text. */
export async function readFileTailText(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    return (await readRegion(handle, Math.max(0, size - maxBytes), size)).toString('utf8');
  } finally {
    await handle.close();
  }
}
