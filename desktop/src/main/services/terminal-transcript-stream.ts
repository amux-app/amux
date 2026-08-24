import { closeSync, fstatSync, openSync, readSync, statSync, watch } from 'fs';
import { StringDecoder } from 'string_decoder';
import type { TerminalDataSource } from '../../shared/ipc-types.js';
import { log } from './Logger.js';
import type { PaneStream } from './terminal-stream-state.js';

const TRANSCRIPT_READ_CHUNK_BYTES = 256 * 1024;
const TRANSCRIPT_PENDING_HIGHWATER = 512 * 1024;
const TRANSCRIPT_FOLLOW_POLL_MS = 250;
const TRANSCRIPT_FLUSH_MS = 16;
const TRANSCRIPT_REPLAY_MAX_BYTES = 50 * 1024 * 1024;
const TERMINAL_DATA_MAX_CHARS = 512 * 1024;
const AGENT_TRANSCRIPT_STARTUP_SCAN_BYTES = 128 * 1024;
const CLAUDE_STARTUP_BANNER_PREFIX = '╭───';
const CLAUDE_STARTUP_REPLAY_CONTEXT_CHARS = 512;
const CLAUDE_STARTUP_BANNER_MATCH = /Claude[\s\S]{0,80}Code[\s\S]{0,80}v\d[\s\S]{0,512}(Welcome[\s\S]{0,24}back|Tips[\s\S]{0,64}getting)/;
const CLAUDE_PROMPT_PREFIX = '❯';
const CLAUDE_PROMPT_REPLAY_SCAN_CHARS = 16 * 1024;
const CLAUDE_PROMPT_REPLAY_CONTEXT_CHARS = 1536;
const CLAUDE_PROMPT_INITIAL_SAMPLE_CHARS = 160;
const CLAUDE_PROMPT_MIN_VISIBLE_CHARS = 8;
const CLAUDE_PROMPT_MAX_REDRAW_DISTANCE_CHARS = 4096;
const CLAUDE_PROMPT_SIMILARITY_THRESHOLD = 0.6;
const TERMINAL_OSC_SEQUENCE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const TERMINAL_CSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const TERMINAL_ESCAPE_SEQUENCE = /\x1b[()][A-Za-z0-9]|\x1b[=>]/g;
const TERMINAL_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const MEANINGFUL_PROMPT_TEXT = /[\p{L}\p{N}]/u;

interface TerminalTranscriptCallbacks {
  isCurrentStream(stream: PaneStream): boolean;
  onTranscriptActivity?: (stream: PaneStream) => void;
  sendToRenderer(paneId: string, data: string, source: TerminalDataSource, streamId: number): void;
}

interface TerminalTranscriptOptions {
  replayMaxBytes?: number;
}

export interface TerminalTranscriptReplayResult {
  offset: number;
  replayed: boolean;
}

interface OpenTranscript {
  dev: number;
  fd: number;
  ino: number;
  size: number;
}

interface TranscriptIdentitySync {
  activity: boolean;
  replaced: boolean;
}

export class TerminalTranscriptStream {
  private readonly replayMaxBytes: number;

  constructor(
    private readonly callbacks: TerminalTranscriptCallbacks,
    options: TerminalTranscriptOptions = {},
  ) {
    this.replayMaxBytes = options.replayMaxBytes ?? TRANSCRIPT_REPLAY_MAX_BYTES;
  }

  async attach(
    stream: PaneStream,
    transcriptPath: string,
    initialOffset?: number,
  ): Promise<void> {
    stream.transcriptPath = transcriptPath;
    if (!this.callbacks.isCurrentStream(stream)) return;

    stream.transcriptDecoder = new StringDecoder('utf8');
    try {
      const opened = openTranscript(transcriptPath);
      stream.transcriptFd = opened.fd;
      stream.transcriptDev = opened.dev;
      stream.transcriptIno = opened.ino;
      stream.transcriptOffset = resolveTranscriptFollowOffset(initialOffset, opened.size);
      log.debug('terminal', 'Transcript follow attached', {
        initialOffset,
        paneId: stream.paneId,
        resolvedOffset: stream.transcriptOffset,
        streamId: stream.streamId,
        transcriptPath,
        transcriptSize: opened.size,
      });
    } catch (error) {
      log.warn('terminal', 'Failed to open transcript for follow', { paneId: stream.paneId, transcriptPath, error });
      return;
    }

    this.startFollowing(stream);
  }

  async replayExistingData(stream: PaneStream, transcriptPath: string): Promise<TerminalTranscriptReplayResult> {
    if (!this.callbacks.isCurrentStream(stream)) return { offset: stream.transcriptOffset, replayed: false };

    let replayFd: number | null = null;
    let replayed = false;
    let offset = stream.transcriptOffset;
    stream.transcriptReplayInFlight = true;
    if (stream.transcriptFlushTimer) clearTimeout(stream.transcriptFlushTimer);
    stream.transcriptFlushTimer = null;
    stream.transcriptPending = '';
    stream.transcriptPendingSource = null;
    try {
      replayFd = openSync(transcriptPath, 'r');
      const transcriptSize = statSync(transcriptPath).size;
      const decoder = new StringDecoder('utf8');
      offset = this.resolveReplayStartOffset(stream, replayFd, transcriptSize);
      log.debug('terminal', 'Transcript replay starting', {
        paneId: stream.paneId,
        replayBytes: transcriptSize - offset,
        replayOffset: offset,
        skipScrollbackReplay: stream.skipScrollbackReplay,
        streamId: stream.streamId,
        transcriptPath,
        transcriptSize,
      });

      while (offset < transcriptSize) {
        if (!this.callbacks.isCurrentStream(stream)) return { offset, replayed };

        const remaining = transcriptSize - offset;
        const toRead = Math.min(remaining, TRANSCRIPT_READ_CHUNK_BYTES);
        const buf = Buffer.allocUnsafe(toRead);
        const n = readSync(replayFd, buf, 0, toRead, offset);
        if (n <= 0) break;

        offset += n;
        replayed = this.sendReplayChunk(stream, decoder.write(buf.subarray(0, n))) || replayed;
      }

      replayed = this.sendReplayChunk(stream, decoder.end()) || replayed;
    } catch (error) {
      log.warn('terminal', 'Failed to replay terminal transcript', { paneId: stream.paneId, transcriptPath, error });
    } finally {
      if (replayFd !== null) closeSync(replayFd);
      stream.transcriptOffset = offset;
      if (stream.transcriptFd !== null) {
        stream.transcriptDecoder = new StringDecoder('utf8');
      }
      stream.transcriptReplayInFlight = false;
      log.debug('terminal', 'Transcript replay finished', {
        offset,
        paneId: stream.paneId,
        replayed,
        streamId: stream.streamId,
        transcriptPath,
      });
    }
    return { offset, replayed };
  }

  readNewData(stream: PaneStream): void {
    if (stream.mode !== 'transcript') return;
    if (!this.callbacks.isCurrentStream(stream)) return;
    if (!stream.transcriptPath) return;
    if (stream.transcriptReplayInFlight) return;
    if (stream.transcriptSuppressedUntil > Date.now()) {
      this.discardBufferedDataAndSeekToEnd(stream);
      return;
    }
    if (stream.capturing) return;
    stream.capturing = true;
    let sawSnapshotDrivenData = false;

    try {
      const sync = this.syncTranscriptIdentity(stream, true);
      sawSnapshotDrivenData = sync.activity;
      if (stream.transcriptFd === null || !stream.transcriptDecoder) return;

      const size = fstatSync(stream.transcriptFd).size;
      if (size < stream.transcriptOffset) {
        stream.transcriptOffset = 0;
        stream.transcriptDecoder = new StringDecoder('utf8');
      }
      sawSnapshotDrivenData = this.consumeTranscript(stream, size) || sawSnapshotDrivenData;
    } catch (error) {
      log.debug('terminal', 'Transcript follow read failed', { paneId: stream.paneId, transcriptPath: stream.transcriptPath, error });
    } finally {
      stream.capturing = false;
      if (sawSnapshotDrivenData) {
        this.callbacks.onTranscriptActivity?.(stream);
      }
    }
  }

  queue(
    stream: PaneStream,
    data: string,
    source: TerminalDataSource,
  ): void {
    if (!data) return;
    while (stream.transcriptPending && stream.transcriptPendingSource !== source) {
      this.flush(stream);
    }
    stream.transcriptPending += data;
    stream.transcriptPendingSource = source;
    while (stream.transcriptPending.length > TRANSCRIPT_PENDING_HIGHWATER) {
      this.flush(stream);
    }
    this.scheduleFlush(stream);
  }

  dispose(stream: PaneStream): void {
    this.pauseFollowing(stream);
    stream.transcriptDecoder = null;
    if (stream.transcriptFd !== null) {
      try {
        closeSync(stream.transcriptFd);
      } catch {
      }
      stream.transcriptFd = null;
    }
    stream.transcriptDev = null;
    stream.transcriptIno = null;
  }

  pauseFollowing(stream: PaneStream): void {
    stream.transcriptWatcher?.close();
    if (stream.transcriptPollTimer) clearInterval(stream.transcriptPollTimer);
    if (stream.transcriptFlushTimer) clearTimeout(stream.transcriptFlushTimer);
    stream.transcriptWatcher = null;
    stream.transcriptPollTimer = null;
    stream.transcriptFlushTimer = null;
    stream.transcriptPending = '';
    stream.transcriptPendingSource = null;
  }

  resumeFollowing(stream: PaneStream): void {
    if (stream.mode !== 'transcript') return;
    if (!this.callbacks.isCurrentStream(stream)) return;
    if (!stream.transcriptPath) return;
    if (stream.transcriptWatcher || stream.transcriptPollTimer) return;

    this.discardBufferedDataAndSeekToEnd(stream);
    if (stream.transcriptFd === null) return;
    this.startFollowing(stream);
  }

  discardBufferedDataAndSeekToEnd(stream: PaneStream): void {
    if (stream.transcriptFlushTimer) clearTimeout(stream.transcriptFlushTimer);
    stream.transcriptFlushTimer = null;
    stream.transcriptPending = '';
    stream.transcriptPendingSource = null;
    stream.transcriptDecoder = new StringDecoder('utf8');

    if (!stream.transcriptPath) return;

    try {
      this.syncTranscriptIdentity(stream, false);
      if (stream.transcriptFd === null) return;
      stream.transcriptOffset = fstatSync(stream.transcriptFd).size;
    } catch (error) {
      log.debug('terminal', 'Transcript seek-to-end failed', {
        paneId: stream.paneId,
        transcriptPath: stream.transcriptPath,
        error,
      });
    }
  }

  resumeFollowingFromOffset(stream: PaneStream, offset: number): void {
    if (!stream.transcriptPath) return;

    try {
      const sync = this.syncTranscriptIdentity(stream, true);
      if (stream.transcriptFd === null) return;
      const size = fstatSync(stream.transcriptFd).size;
      stream.transcriptOffset = sync.replaced ? 0 : resolveTranscriptFollowOffset(offset, size);
      stream.transcriptDecoder = new StringDecoder('utf8');
    } catch (error) {
      log.debug('terminal', 'Transcript offset restore failed', {
        paneId: stream.paneId,
        transcriptPath: stream.transcriptPath,
        error,
      });
    }
  }

  private flush(stream: PaneStream): void {
    const pending = stream.transcriptPending;
    if (!pending) {
      stream.transcriptPendingSource = null;
      return;
    }

    const chunk = pending.length > TERMINAL_DATA_MAX_CHARS
      ? pending.slice(0, TERMINAL_DATA_MAX_CHARS)
      : pending;
    stream.transcriptPending = pending.length > TERMINAL_DATA_MAX_CHARS
      ? pending.slice(TERMINAL_DATA_MAX_CHARS)
      : '';
    const source = stream.transcriptPendingSource ?? 'live';
    if (!stream.transcriptPending) {
      stream.transcriptPendingSource = null;
    }
    this.callbacks.sendToRenderer(stream.paneId, chunk, source, stream.streamId);
  }

  private sendReplayChunk(stream: PaneStream, data: string): boolean {
    if (!data) return false;
    // Replay is bounded by replayMaxBytes; live data uses the highwater queue.
    this.callbacks.sendToRenderer(stream.paneId, data, 'replay', stream.streamId);
    return true;
  }

  private findTrimmedAgentReplayOffset(
    stream: PaneStream,
    replayFd: number,
    transcriptSize: number,
    replayStartOffset: number,
  ): number {
    if (!stream.skipScrollbackReplay || transcriptSize <= replayStartOffset) return replayStartOffset;

    const scanBytes = Math.min(transcriptSize - replayStartOffset, AGENT_TRANSCRIPT_STARTUP_SCAN_BYTES);
    const buf = Buffer.allocUnsafe(scanBytes);
    const n = readSync(replayFd, buf, 0, scanBytes, replayStartOffset);
    if (n <= 0) return replayStartOffset;

    const scanText = buf.subarray(0, n).toString('utf8');
    const replayStart = findAgentTranscriptReplayStart(scanText);
    if (replayStart <= 0) {
      log.debug('terminal', 'Agent transcript replay dedup not matched', {
        paneId: stream.paneId,
        replayStartOffset,
        scanBytes,
        transcriptSize,
      });
      return replayStartOffset;
    }

    log.debug('terminal', 'Agent transcript replay dedup matched', {
      paneId: stream.paneId,
      replayStartOffset,
      replayStart,
      scanBytes,
      transcriptSize,
    });
    return replayStartOffset + Buffer.byteLength(scanText.slice(0, replayStart), 'utf8');
  }

  private resolveReplayStartOffset(stream: PaneStream, replayFd: number, transcriptSize: number): number {
    const cappedOffset = Math.max(0, transcriptSize - this.replayMaxBytes);
    const offset = this.findTrimmedAgentReplayOffset(stream, replayFd, transcriptSize, cappedOffset);
    if (cappedOffset > 0) {
      log.debug('terminal', 'Terminal transcript replay capped', {
        paneId: stream.paneId,
        replayBytes: transcriptSize - offset,
        transcriptSize,
      });
    }
    return offset;
  }

  private scheduleFlush(stream: PaneStream): void {
    if (stream.transcriptFlushTimer) return;
    stream.transcriptFlushTimer = setTimeout(() => {
      stream.transcriptFlushTimer = null;
      if (!this.callbacks.isCurrentStream(stream)) {
        stream.transcriptPending = '';
        stream.transcriptPendingSource = null;
        return;
      }
      const pending = stream.transcriptPending;
      if (!pending) return;

      this.flush(stream);

      if (stream.transcriptPending) {
        this.scheduleFlush(stream);
      }
    }, TRANSCRIPT_FLUSH_MS);
  }

  private syncTranscriptIdentity(
    stream: PaneStream,
    drainReplacedTranscript: boolean,
  ): TranscriptIdentitySync {
    const transcriptPath = stream.transcriptPath;
    if (!transcriptPath) return { activity: false, replaced: false };

    if (stream.transcriptFd === null) {
      const opened = openTranscript(transcriptPath);
      stream.transcriptFd = opened.fd;
      stream.transcriptDev = opened.dev;
      stream.transcriptIno = opened.ino;
      stream.transcriptOffset = drainReplacedTranscript ? 0 : opened.size;
      stream.transcriptDecoder = new StringDecoder('utf8');
      this.reinstallWatcherIfFollowing(stream);
      return { activity: false, replaced: true };
    }

    const pathStats = statSync(transcriptPath);
    if (pathStats.dev === stream.transcriptDev && pathStats.ino === stream.transcriptIno) {
      return { activity: false, replaced: false };
    }

    const activity = drainReplacedTranscript
      ? this.consumeTranscript(stream, fstatSync(stream.transcriptFd).size)
      : false;
    const replacement = openTranscript(transcriptPath);
    const previousFd = stream.transcriptFd;
    stream.transcriptFd = replacement.fd;
    stream.transcriptDev = replacement.dev;
    stream.transcriptIno = replacement.ino;
    stream.transcriptOffset = drainReplacedTranscript ? 0 : replacement.size;
    if (!drainReplacedTranscript) {
      stream.transcriptDecoder = new StringDecoder('utf8');
    }
    try {
      closeSync(previousFd);
    } catch {
    }
    this.reinstallWatcherIfFollowing(stream);
    return { activity, replaced: true };
  }

  private consumeTranscript(stream: PaneStream, size: number): boolean {
    if (stream.transcriptFd === null || !stream.transcriptDecoder) return false;
    let sawSnapshotDrivenData = false;

    while (stream.transcriptOffset < size) {
      if (stream.transcriptPending.length > TRANSCRIPT_PENDING_HIGHWATER) break;
      const remaining = size - stream.transcriptOffset;
      const toRead = Math.min(remaining, TRANSCRIPT_READ_CHUNK_BYTES);
      const buf = Buffer.allocUnsafe(toRead);
      const n = readSync(stream.transcriptFd, buf, 0, toRead, stream.transcriptOffset);
      if (n <= 0) break;
      stream.transcriptOffset += n;
      const data = stream.transcriptDecoder.write(buf.subarray(0, n));
      if (stream.skipScrollbackReplay) {
        sawSnapshotDrivenData = sawSnapshotDrivenData || data.length > 0;
      } else {
        this.queue(stream, data, 'live');
      }
    }
    return sawSnapshotDrivenData;
  }

  private reinstallWatcherIfFollowing(stream: PaneStream): void {
    if (!stream.transcriptWatcher && !stream.transcriptPollTimer) return;
    this.installWatcher(stream);
  }

  private installWatcher(stream: PaneStream): void {
    const transcriptPath = stream.transcriptPath;
    if (!transcriptPath) return;

    stream.transcriptWatcher?.close();
    stream.transcriptWatcher = null;
    try {
      stream.transcriptWatcher = watch(
        transcriptPath,
        { persistent: false },
        () => this.readNewData(stream),
      );
    } catch (error) {
      log.debug('terminal', 'Transcript watcher installation failed', {
        error,
        paneId: stream.paneId,
        transcriptPath,
      });
    }
  }

  private startFollowing(stream: PaneStream): void {
    const transcriptPath = stream.transcriptPath;
    if (!transcriptPath || stream.transcriptFd === null) return;

    const follow = () => this.readNewData(stream);
    this.installWatcher(stream);
    stream.transcriptPollTimer = setInterval(follow, TRANSCRIPT_FOLLOW_POLL_MS);
    follow();
  }
}

function openTranscript(transcriptPath: string): OpenTranscript {
  const fd = openSync(transcriptPath, 'r');
  try {
    const stats = fstatSync(fd);
    return { dev: stats.dev, fd, ino: stats.ino, size: stats.size };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function findAgentTranscriptReplayStart(data: string): number {
  const claudeBannerStarts = findClaudeStartupBannerStarts(data);
  if (claudeBannerStarts.length === 0) return 0;
  const startupReplayStart = claudeBannerStarts.length >= 2
    ? findReplayBoundaryBefore(data, claudeBannerStarts[claudeBannerStarts.length - 1])
    : 0;
  const promptScanStart = claudeBannerStarts.length >= 2
    ? startupReplayStart
    : findReplayBoundaryBefore(data, claudeBannerStarts[0]);
  const promptReplayStart = findDuplicateClaudePromptReplayStart(data, promptScanStart);
  if (promptReplayStart > promptScanStart) return promptReplayStart;
  return startupReplayStart;
}

function resolveTranscriptFollowOffset(offset: number | undefined, transcriptSize: number): number {
  if (offset === undefined) return transcriptSize;
  if (offset < 0) return 0;
  return Math.min(offset, transcriptSize);
}

function findClaudeStartupBannerStarts(data: string): number[] {
  const starts: number[] = [];
  let offset = 0;
  while (offset < data.length) {
    const index = data.indexOf(CLAUDE_STARTUP_BANNER_PREFIX, offset);
    if (index < 0) return starts;
    const sample = data.slice(index, index + CLAUDE_STARTUP_REPLAY_CONTEXT_CHARS);
    if (hasClaudeStartupFrameBoundary(data, index) && CLAUDE_STARTUP_BANNER_MATCH.test(sample)) {
      starts.push(index);
    }
    offset = index + CLAUDE_STARTUP_BANNER_PREFIX.length;
  }
  return starts;
}

function hasClaudeStartupFrameBoundary(data: string, index: number): boolean {
  if (index === 0) return true;
  const prefix = data.slice(Math.max(0, index - CLAUDE_STARTUP_REPLAY_CONTEXT_CHARS), index);
  const home = prefix.lastIndexOf('\x1b[H');
  const carriageReturn = prefix.lastIndexOf('\r');
  const homeBoundary = home >= 0 ? home + '\x1b[H'.length : -1;
  const carriageReturnBoundary = carriageReturn >= 0 ? carriageReturn + 1 : -1;
  const boundary = Math.max(homeBoundary, carriageReturnBoundary);
  if (boundary < 0) return false;
  return stripTerminalControls(prefix.slice(boundary)).trim() === '';
}

function findReplayBoundaryBefore(data: string, index: number): number {
  const start = Math.max(0, index - CLAUDE_STARTUP_REPLAY_CONTEXT_CHARS);
  const prefix = data.slice(start, index);
  const home = prefix.lastIndexOf('\x1b[H');
  if (home >= 0) return start + home;
  const carriageReturn = prefix.lastIndexOf('\r');
  if (carriageReturn >= 0) return start + carriageReturn;
  return index;
}

interface ClaudePromptRender {
  index: number;
  text: string;
}

function findDuplicateClaudePromptReplayStart(data: string, replayStart: number): number {
  const promptRenders = findClaudePromptRenders(data, replayStart);
  for (let i = 0; i < promptRenders.length - 1; i += 1) {
    const first = promptRenders[i];
    const second = promptRenders[i + 1];
    if (second.index - first.index > CLAUDE_PROMPT_MAX_REDRAW_DISTANCE_CHARS) continue;
    if (areSimilarClaudePrompts(first.text, second.text)) return findPromptFrameBoundary(data, second.index);
  }
  return replayStart;
}

function findClaudePromptRenders(data: string, replayStart: number): ClaudePromptRender[] {
  const renders: ClaudePromptRender[] = [];
  const scanEnd = Math.min(data.length, replayStart + CLAUDE_PROMPT_REPLAY_SCAN_CHARS);
  let offset = replayStart;
  while (offset < scanEnd) {
    const index = data.indexOf(CLAUDE_PROMPT_PREFIX, offset);
    if (index < 0 || index >= scanEnd) return renders;
    const text = getClaudePromptText(data, index);
    if (text) renders.push({ index, text });
    offset = index + CLAUDE_PROMPT_PREFIX.length;
  }
  return renders;
}

function getClaudePromptText(data: string, index: number): string {
  const initial = normalizePromptText(data.slice(index, index + CLAUDE_PROMPT_INITIAL_SAMPLE_CHARS));
  if (!isPromptText(initial)) return '';
  return normalizePromptText(data.slice(index, index + CLAUDE_PROMPT_REPLAY_CONTEXT_CHARS));
}

function isPromptText(text: string): boolean {
  if (text.length < CLAUDE_PROMPT_MIN_VISIBLE_CHARS) return false;
  const firstMeaningful = text.search(MEANINGFUL_PROMPT_TEXT);
  return firstMeaningful >= 0 && firstMeaningful <= 8;
}

function normalizePromptText(value: string): string {
  return stripTerminalControls(value)
    .replace(/\u00a0/g, ' ')
    .replace(/^❯\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTerminalControls(value: string): string {
  return value
    .replace(TERMINAL_OSC_SEQUENCE, '')
    .replace(TERMINAL_CSI_SEQUENCE, '')
    .replace(TERMINAL_ESCAPE_SEQUENCE, '')
    .replace(TERMINAL_CONTROL_CHARS, ' ');
}

function areSimilarClaudePrompts(first: string, second: string): boolean {
  const firstComparable = normalizePromptForCompare(first);
  const secondComparable = normalizePromptForCompare(second);
  if (!firstComparable || !secondComparable) return false;
  if (firstComparable === secondComparable) return true;
  if (firstComparable.includes(secondComparable) || secondComparable.includes(firstComparable)) return true;

  const firstTokens = getPromptTokens(firstComparable);
  const secondTokens = getPromptTokens(secondComparable);
  if (firstTokens.length < 3 || secondTokens.length < 3) return false;

  const firstSet = new Set(firstTokens);
  const secondSet = new Set(secondTokens);
  let shared = 0;
  for (const token of firstSet) {
    if (secondSet.has(token)) shared += 1;
  }
  return shared / Math.min(firstSet.size, secondSet.size) >= CLAUDE_PROMPT_SIMILARITY_THRESHOLD;
}

function normalizePromptForCompare(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getPromptTokens(value: string): string[] {
  return value.split(' ').filter((token) => token.length >= 2);
}

function findPromptFrameBoundary(data: string, index: number): number {
  const start = Math.max(0, index - CLAUDE_STARTUP_REPLAY_CONTEXT_CHARS);
  const prefix = data.slice(start, index);
  const background = prefix.lastIndexOf('\x1b[48;5;237m');
  if (background >= 0) return start + background;
  const carriageReturn = prefix.lastIndexOf('\r');
  if (carriageReturn >= 0) return start + carriageReturn;
  return index;
}
