import { open, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

const READ_BYTES = 8 * 1024;

interface TailState {
  device: number;
  inode: number;
  file: FileHandle;
  offset: number;
  decoder: StringDecoder;
  boundary: Buffer;
  path: string;
}

export interface DetachedTranscriptActivity {
  paneId: string;
  data: string;
}

/** Tails live transcript appends without depending on renderer attachment. */
export class DetachedTranscriptActivityTailer {
  private readonly states = new Map<string, TailState>();

  async sync(panes: readonly { id: string; agent?: string; terminalTranscriptPath?: string }[]): Promise<void> {
    const live = new Set<string>();
    for (const pane of panes) {
      if (!pane.agent || !pane.terminalTranscriptPath) continue;
      live.add(pane.id);
      const current = this.states.get(pane.id);
      if (!current || current.path !== pane.terminalTranscriptPath) {
        if (current) await closeState(current);
        const next = await openTail(pane.terminalTranscriptPath);
        if (next) this.states.set(pane.id, next);
        else this.states.delete(pane.id);
      }
    }
    for (const [paneId, state] of this.states) {
      if (live.has(paneId)) continue;
      await closeState(state);
      this.states.delete(paneId);
    }
  }

  async readNewData(): Promise<DetachedTranscriptActivity[]> {
    const activities: DetachedTranscriptActivity[] = [];
    for (const [paneId, state] of this.states) {
      const data = await readState(state);
      if (data) activities.push({ paneId, data });
    }
    return activities;
  }

  async remove(paneId: string): Promise<void> {
    const state = this.states.get(paneId);
    if (!state) return;
    this.states.delete(paneId);
    await closeState(state);
  }

  reset(): void {
    const states = [...this.states.values()];
    this.states.clear();
    for (const state of states) void closeState(state);
  }
}

async function openTail(path: string): Promise<TailState | null> {
  try {
    const file = await open(path, 'r');
    const info = await file.stat();
    const state: TailState = {
      device: info.dev,
      inode: info.ino,
      file,
      offset: info.size,
      decoder: new StringDecoder('utf8'),
      boundary: Buffer.alloc(0),
      path,
    };
    state.boundary = await readBoundary(state);
    return state;
  } catch {
    return null;
  }
}

async function readState(state: TailState): Promise<string> {
  try {
    const info = await stat(state.path);
    if (info.dev !== state.device || info.ino !== state.inode) {
      // The old descriptor remains valid after atomic rotation. Drain only
      // bytes appended to it, then follow the replacement from its EOF.
      const oldData = await readBytes(state);
      await closeState(state);
      const replacement = await openTail(state.path);
      if (replacement) {
        state.device = replacement.device;
        state.inode = replacement.inode;
        state.file = replacement.file;
        state.offset = replacement.offset;
        state.decoder = replacement.decoder;
        state.boundary = replacement.boundary;
      }
      return oldData;
    }
    if (info.size < state.offset) {
      state.offset = 0;
      state.decoder = new StringDecoder('utf8');
      state.boundary = Buffer.alloc(0);
    } else if (state.boundary.length > 0 && !(await boundaryMatches(state))) {
      // A truncate-and-rewrite can grow beyond the old offset, so size alone
      // cannot identify it. The stable bytes immediately before the checkpoint
      // provide a cheap, bounded rewrite detector.
      state.offset = 0;
      state.decoder = new StringDecoder('utf8');
      state.boundary = Buffer.alloc(0);
    }
    const data = await readBytes(state);
    state.boundary = await readBoundary(state);
    return data;
  } catch {
    return '';
  }
}

async function readBoundary(state: TailState): Promise<Buffer> {
  const length = Math.min(32, state.offset);
  if (length === 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  try {
    const result = await state.file.read(buffer, 0, length, state.offset - length);
    return Buffer.from(buffer.subarray(0, result.bytesRead));
  } catch {
    return Buffer.alloc(0);
  }
}

async function boundaryMatches(state: TailState): Promise<boolean> {
  const current = await readBoundary(state);
  return current.length === state.boundary.length && current.equals(state.boundary);
}

async function readBytes(state: TailState): Promise<string> {
  const buffer = Buffer.allocUnsafe(READ_BYTES);
  try {
    const result = await state.file.read(buffer, 0, READ_BYTES, state.offset);
    if (result.bytesRead <= 0) return '';
    state.offset += result.bytesRead;
    return state.decoder.write(buffer.subarray(0, result.bytesRead));
  } catch {
    return '';
  }
}

async function closeState(state: TailState): Promise<void> {
  try {
    await state.file.close();
  } catch {
  }
}
