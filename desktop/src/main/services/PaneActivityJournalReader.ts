import { open, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { PaneActivityEvent, PaneActivityEventInput } from '../../shared/pane-activity.js';

const MAX_RECORD_BYTES = 4 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_BYTES_PER_READ_CALL = 256 * 1024;

interface JournalReadBatch {
  events: PaneActivityEventInput[];
  replay: boolean;
}

export interface JournalRead {
  batches: JournalReadBatch[];
}

interface JournalStateRead extends JournalRead {
  atEof: boolean;
  bytesRead: number;
}

interface JournalState {
  device: number;
  inode: number;
  file: FileHandle;
  offset: number;
  pending: Buffer;
  discardOversized: boolean;
  replay: boolean;
  /** Size of the file when opened; everything below it is history, not news. */
  replayUntilOffset: number;
}

/**
 * Bounded, asynchronous NDJSON tail reader for append-only adapter journals.
 * One descriptor is kept per inode and only appended bytes are read. A
 * replacement path is switched to only after the old descriptor is drained.
 */
export class PaneActivityJournalReader {
  private readonly states = new Map<string, JournalState>();
  private readonly liveOnFirstRead = new Set<string>();
  private readonly absentPaths = new Set<string>();

  markLive(path: string): void {
    this.liveOnFirstRead.add(path);
  }

  async read(path: string, receivedAt: number): Promise<JournalRead> {
    let state: JournalState | undefined = this.states.get(path);
    if (!state) {
      const opened = await this.openCurrent(path);
      if (!opened) {
        this.absentPaths.add(path);
        return { batches: [] };
      }
      state = opened;
      this.states.set(path, state);
    } else {
      const pathStats = await safeStat(path);
      if (!pathStats) {
        const read = await this.readState(state, receivedAt);
        return { batches: read.batches };
      }
      if (pathStats.dev !== state.device || pathStats.ino !== state.inode) {
        const oldRead = await this.readState(state, receivedAt);
        // Keep the old descriptor until it reaches EOF. Otherwise a rotation
        // could discard the unread tail of a bounded read.
        if (!oldRead.atEof) return { batches: oldRead.batches };
        await this.closeState(state);
        const replacement = await this.openCurrent(path, false);
        if (!replacement) {
          this.states.delete(path);
          return { batches: oldRead.batches };
        }
        this.states.set(path, replacement);
        const replacementRead = await this.readState(
          replacement,
          receivedAt,
          MAX_BYTES_PER_READ_CALL - oldRead.bytesRead,
        );
        return { batches: mergeBatches([...oldRead.batches, ...replacementRead.batches]) };
      }
      if (pathStats.size < state.offset) {
        state.offset = 0;
        state.pending = Buffer.alloc(0);
        state.discardOversized = false;
        // An in-place truncation happened after this reader opened the file;
        // all subsequent bytes are live relative to this process.
        state.replay = false;
        state.replayUntilOffset = 0;
      }
    }

    const read = await this.readState(state, receivedAt);
    return { batches: read.batches };
  }

  remove(path: string): void {
    const state = this.states.get(path);
    if (state) void this.closeState(state);
    this.states.delete(path);
    this.liveOnFirstRead.delete(path);
    this.absentPaths.delete(path);
  }

  reset(): void {
    for (const state of this.states.values()) void this.closeState(state);
    this.states.clear();
    this.liveOnFirstRead.clear();
    this.absentPaths.clear();
  }

  async dispose(): Promise<void> {
    const states = [...this.states.values()];
    this.states.clear();
    await Promise.all(states.map((state) => this.closeState(state)));
  }

  private async openCurrent(path: string, replayOverride?: boolean): Promise<JournalState | null> {
    try {
      const file = await open(path, 'r');
      const fileStats = await file.stat();
      const isFirstRead = !this.absentPaths.has(path) && !this.states.has(path);
      const replay = replayOverride ?? (isFirstRead && !this.liveOnFirstRead.has(path));
      this.liveOnFirstRead.delete(path);
      this.absentPaths.delete(path);
      return {
        device: fileStats.dev,
        inode: fileStats.ino,
        file,
        offset: 0,
        pending: Buffer.alloc(0),
        discardOversized: false,
        replay,
        replayUntilOffset: replay ? fileStats.size : 0,
      };
    } catch {
      return null;
    }
  }

  private async readState(
    state: JournalState,
    receivedAt: number,
    byteBudget = MAX_BYTES_PER_READ_CALL,
  ): Promise<JournalStateRead> {
    const batches: JournalReadBatch[] = [];
    let bytesReadThisCall = 0;
    let atEof = false;
    while (bytesReadThisCall < byteBudget) {
      if (state.replay && state.offset >= state.replayUntilOffset) state.replay = false;
      const replay = state.replay;
      const bytesUntilWatermark = replay ? state.replayUntilOffset - state.offset : Number.POSITIVE_INFINITY;
      const size = Math.min(READ_CHUNK_BYTES, byteBudget - bytesReadThisCall, bytesUntilWatermark);
      if (size <= 0) continue;
      const buffer = Buffer.allocUnsafe(size);
      let bytesRead = 0;
      try {
        const result = await state.file.read(buffer, 0, size, state.offset);
        bytesRead = result.bytesRead;
      } catch {
        // A transient read failure is not proof that a rotated inode drained.
        // Keep the descriptor and retry it on the next poll.
        break;
      }
      if (bytesRead <= 0) {
        atEof = true;
        // Falling short of the captured watermark means the file was
        // truncated after open; bytes appended from here are live.
        if (state.replay) {
          state.replay = false;
          state.replayUntilOffset = state.offset;
        }
        break;
      }
      state.offset += bytesRead;
      bytesReadThisCall += bytesRead;
      const events: PaneActivityEventInput[] = [];
      this.consumeBytes(state, buffer.subarray(0, bytesRead), receivedAt, events);
      if (events.length > 0) appendBatch(batches, { events, replay });
      if (state.replay && state.offset >= state.replayUntilOffset) state.replay = false;
      if (bytesRead < size) {
        atEof = true;
        break;
      }
    }
    return { atEof, batches, bytesRead: bytesReadThisCall };
  }

  private consumeBytes(
    state: JournalState,
    bytes: Buffer,
    receivedAt: number,
    events: PaneActivityEventInput[],
  ): void {
    let remaining = bytes;
    if (state.discardOversized) {
      const newline = remaining.indexOf(0x0a);
      if (newline < 0) return;
      state.discardOversized = false;
      remaining = remaining.subarray(newline + 1);
    }

    state.pending = Buffer.concat([state.pending, remaining]);
    while (state.pending.length > 0) {
      const newline = state.pending.indexOf(0x0a);
      if (newline < 0) {
        if (state.pending.length >= MAX_RECORD_BYTES) {
          state.pending = Buffer.alloc(0);
          state.discardOversized = true;
        }
        return;
      }
      const line = state.pending.subarray(0, newline);
      state.pending = state.pending.subarray(newline + 1);
      if (line.length === 0 || line.length >= MAX_RECORD_BYTES) continue;
      const event = parseJournalEvent(line.toString('utf8'), receivedAt);
      if (event) events.push(event);
    }
  }

  private async closeState(state: JournalState): Promise<void> {
    try {
      await state.file.close();
    } catch {
      // The descriptor may already have been closed by an OS error.
    }
  }
}

function appendBatch(batches: JournalReadBatch[], batch: JournalReadBatch): void {
  const previous = batches.at(-1);
  if (previous?.replay === batch.replay) {
    previous.events.push(...batch.events);
    return;
  }
  batches.push(batch);
}

function mergeBatches(batches: JournalReadBatch[]): JournalReadBatch[] {
  const merged: JournalReadBatch[] = [];
  for (const batch of batches) appendBatch(merged, batch);
  return merged;
}

async function safeStat(path: string): Promise<{ dev: number; ino: number; size: number } | null> {
  try {
    const value = await stat(path);
    return { dev: value.dev, ino: value.ino, size: value.size };
  } catch {
    return null;
  }
}

function parseJournalEvent(line: string, receivedAt: number): PaneActivityEventInput | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (!isString(value.eventId) || !isString(value.kind) || !isString(value.origin)
      || !isString(value.paneId) || !isString(value.paneIncarnationId)) return null;
    if (!isActivityKind(value.kind) || value.origin !== 'adapter') return null;
    return {
      eventId: value.eventId,
      kind: value.kind,
      origin: 'adapter',
      paneId: value.paneId,
      paneIncarnationId: value.paneIncarnationId,
      receivedAt,
      emittedAt: isFiniteNumber(value.emittedAt) ? value.emittedAt : undefined,
      entityId: isString(value.entityId) ? value.entityId : undefined,
      entity: parseEntity(value.entity),
      backgroundSnapshot: parseBackgroundSnapshot(value.background_snapshot),
      sessionId: isString(value.sessionId) ? value.sessionId : undefined,
      turnId: isString(value.turnId) ? value.turnId : undefined,
      adapterSupport: value.adapterSupport === 'full' || value.adapterSupport === 'partial' || value.adapterSupport === 'none'
        ? value.adapterSupport
        : undefined,
      adapterVersion: isString(value.adapterVersion) ? value.adapterVersion : undefined,
      adapterCapabilities: parseCapabilities(value.adapterCapabilities),
      waitReason: value.waitReason === 'permission' || value.waitReason === 'question' || value.waitReason === 'elicitation'
        ? value.waitReason
        : undefined,
    };
  } catch {
    return null;
  }
}

function parseEntity(value: unknown): PaneActivityEvent['entity'] | undefined {
  if (!isRecord(value) || !isActivityEntityKind(value.kind)
    || (value.mutating !== true && value.mutating !== false && value.mutating !== 'unknown')
    || !isFiniteNumber(value.sinceWallMs)) return undefined;
  return { kind: value.kind, mutating: value.mutating, sinceWallMs: value.sinceWallMs };
}

function parseBackgroundSnapshot(value: unknown): PaneActivityEvent['backgroundSnapshot'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: NonNullable<PaneActivityEvent['backgroundSnapshot']> = [];
  for (const item of value) {
    if (!isRecord(item) || !isString(item.entityId) || !isActivityEntityKind(item.kind)
      || (item.mutating !== true && item.mutating !== false && item.mutating !== 'unknown')
      || !isFiniteNumber(item.sinceWallMs)) return undefined;
    result.push({ entityId: item.entityId, kind: item.kind, mutating: item.mutating, sinceWallMs: item.sinceWallMs });
  }
  return result;
}

function parseCapabilities(value: unknown): PaneActivityEvent['adapterCapabilities'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const capabilities = value.filter((candidate): candidate is NonNullable<PaneActivityEvent['adapterCapabilities']>[number] => (
    candidate === 'turnIds'
      || candidate === 'notifications'
      || candidate === 'backgroundSnapshots'
      || candidate === 'compaction'
      || candidate === 'backgroundEntities'
  ));
  return capabilities.length === value.length ? capabilities : undefined;
}

function isActivityKind(value: string): value is PaneActivityEvent['kind'] {
  return [
    'turn_start_candidate', 'turn_end_candidate', 'turn_failure_candidate', 'wait_started_candidate',
    'turn_started', 'turn_settled', 'turn_failed', 'turn_interrupted',
    'wait_started', 'wait_resolved', 'session_start', 'session_end',
    'adapter_handshake', 'background_started', 'background_ended', 'background_snapshot',
    'compaction_started', 'compaction_settled',
  ].includes(value);
}

function isActivityEntityKind(value: unknown): value is NonNullable<PaneActivityEvent['entity']>['kind'] {
  return value === 'subagent' || value === 'task' || value === 'cron'
    || value === 'shell' || value === 'mcp' || value === 'unknown';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
