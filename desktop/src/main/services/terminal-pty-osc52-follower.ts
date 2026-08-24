import { closeSync, fstatSync, openSync, readSync, statSync, watch } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { log } from './Logger.js';

const DEFAULT_MAX_OSC52_SEQUENCE_CHARS = 140_000;
// Reads are driven by fs.watch; this interval only bounds how long a missed
// watcher event can delay a clipboard request or a transcript replacement.
const DEFAULT_FALLBACK_POLL_INTERVAL_MS = 1_000;
const MIN_FALLBACK_POLL_INTERVAL_MS = 10;
const MAX_FALLBACK_POLL_INTERVAL_MS = 5_000;
const READ_CHUNK_BYTES = 64 * 1024;
const OSC52_PREFIX = '\x1b]52;';
const READ_FAILURE_MESSAGE = 'PTY OSC 52 transcript follow read failed';

interface TerminalPtyOsc52FollowerOptions {
  maxSequenceChars?: number;
  pollIntervalMs?: number;
}

export interface TerminalPtyOsc52FollowerHandle {
  dispose(): void;
}

interface Osc52ExtractionResult {
  pending: string;
  sequences: string[];
}

interface OpenTranscriptStats {
  dev: number;
  ino: number;
  size: number;
}

function normalizeMaxSequenceChars(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_OSC52_SEQUENCE_CHARS;
  return Math.min(
    DEFAULT_MAX_OSC52_SEQUENCE_CHARS,
    Math.max(32, Math.floor(value)),
  );
}

function potentialPrefixSuffix(data: string): string {
  const maxLength = Math.min(data.length, OSC52_PREFIX.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = data.slice(-length);
    if (OSC52_PREFIX.startsWith(suffix)) return suffix;
  }
  return '';
}

export function extractPtyOsc52Sequences(
  previousPending: string,
  chunk: string,
  maxSequenceChars = DEFAULT_MAX_OSC52_SEQUENCE_CHARS,
): Osc52ExtractionResult {
  const data = previousPending + chunk;
  const sequenceLimit = normalizeMaxSequenceChars(maxSequenceChars);
  const sequences: string[] = [];
  let cursor = 0;

  while (cursor < data.length) {
    let candidateStart = data.indexOf(OSC52_PREFIX, cursor);
    if (candidateStart < 0) {
      return { pending: potentialPrefixSuffix(data.slice(cursor)), sequences };
    }

    let scan = candidateStart + OSC52_PREFIX.length;
    let terminated = false;
    while (scan < data.length) {
      // An OSC 52 prefix cannot occur in valid base64 payload data. Treat a
      // nested prefix as a fresh candidate so malformed/oversized input cannot
      // hide the next valid request. `scan` only moves forward, keeping this
      // path linear even for adversarial repeated prefixes.
      if (data.startsWith(OSC52_PREFIX, scan)) {
        candidateStart = scan;
        scan += OSC52_PREFIX.length;
        continue;
      }

      const terminatorLength = data[scan] === '\x07'
        ? 1
        : data[scan] === '\x1b' && data[scan + 1] === '\\'
          ? 2
          : 0;
      if (terminatorLength > 0) {
        const end = scan + terminatorLength;
        if (end - candidateStart <= sequenceLimit) {
          sequences.push(data.slice(candidateStart, end));
        }
        cursor = end;
        terminated = true;
        break;
      }

      scan += 1;
    }

    if (!terminated) {
      const candidate = data.slice(candidateStart);
      return {
        pending: candidate.length <= sequenceLimit
          ? candidate
          : potentialPrefixSuffix(candidate),
        sequences,
      };
    }
  }

  return { pending: '', sequences };
}

export class TerminalPtyOsc52Follower {
  private readonly maxSequenceChars: number;
  private readonly pollIntervalMs: number;

  constructor(options: TerminalPtyOsc52FollowerOptions = {}) {
    this.maxSequenceChars = normalizeMaxSequenceChars(
      options.maxSequenceChars ?? DEFAULT_MAX_OSC52_SEQUENCE_CHARS,
    );
    const requestedPollInterval = options.pollIntervalMs ?? DEFAULT_FALLBACK_POLL_INTERVAL_MS;
    this.pollIntervalMs = Number.isFinite(requestedPollInterval)
      ? Math.max(
        MIN_FALLBACK_POLL_INTERVAL_MS,
        Math.min(MAX_FALLBACK_POLL_INTERVAL_MS, Math.floor(requestedPollInterval)),
      )
      : DEFAULT_FALLBACK_POLL_INTERVAL_MS;
  }

  attach(
    transcriptPath: string,
    onSequence: (sequence: string) => void,
  ): TerminalPtyOsc52FollowerHandle {
    let fd = openSync(transcriptPath, 'r');
    let offset: number;
    try {
      offset = fstatSync(fd).size;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    const maxSequenceChars = this.maxSequenceChars;
    const fallbackPollIntervalMs = this.pollIntervalMs;
    let decoder = new StringDecoder('utf8');
    let pending = '';
    let disposed = false;
    let reading = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let transcriptWatcher: ReturnType<typeof watch> | null = null;

    const resetReader = (): void => {
      offset = 0;
      decoder = new StringDecoder('utf8');
      pending = '';
    };

    const installWatcher = (): void => {
      try {
        transcriptWatcher?.close();
      } catch {
      }
      transcriptWatcher = null;
      const nextWatcher = watch(
        transcriptPath,
        { persistent: false },
        (eventType) => readTranscript(eventType === 'rename'),
      );
      nextWatcher.on('error', (error) => {
        if (disposed) return;
        log.warn('terminal', 'PTY OSC 52 transcript watcher failed', {
          error,
          transcriptPath,
        });
        if (transcriptWatcher === nextWatcher) {
          try {
            nextWatcher.close();
          } catch {
          }
          transcriptWatcher = null;
        }
      });
      transcriptWatcher = nextWatcher;
    };

    const deliver = (sequences: readonly string[]): void => {
      for (const sequence of sequences) {
        if (disposed) return;
        try {
          onSequence(sequence);
        } catch (error) {
          log.warn('terminal', 'PTY OSC 52 delivery callback failed', {
            error,
            transcriptPath,
          });
        }
      }
    };

    const drainTranscript = (size: number): boolean => {
      if (size < offset) resetReader();

      let consumed = false;
      while (!disposed && offset < size) {
        const toRead = Math.min(size - offset, READ_CHUNK_BYTES);
        const buffer = Buffer.allocUnsafe(toRead);
        const bytesRead = readSync(fd, buffer, 0, toRead, offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
        consumed = true;
        const extraction = extractPtyOsc52Sequences(
          pending,
          decoder.write(buffer.subarray(0, bytesRead)),
          maxSequenceChars,
        );
        pending = extraction.pending;
        deliver(extraction.sequences);
      }
      return consumed;
    };

    const reopenIfReplaced = (openFileStats: OpenTranscriptStats): boolean => {
      const pathStats = statSync(transcriptPath);
      if (pathStats.dev === openFileStats.dev && pathStats.ino === openFileStats.ino) return false;

      drainTranscript(openFileStats.size);
      const replacementFd = openSync(transcriptPath, 'r');
      closeSync(fd);
      fd = replacementFd;
      offset = 0;
      installWatcher();
      return true;
    };

    // Replacement detection costs an extra path stat, so it runs on the
    // fallback tick and on watcher rename events only: while the open
    // transcript keeps yielding bytes it is by definition the right inode.
    function readTranscript(checkForReplacement: boolean): void {
      if (disposed || reading) return;
      reading = true;
      try {
        if (!transcriptWatcher) installWatcher();
        let openFileStats = fstatSync(fd);
        if (checkForReplacement && reopenIfReplaced(openFileStats)) {
          openFileStats = fstatSync(fd);
        }
        if (drainTranscript(openFileStats.size)) armFallbackPoll();
      } catch (error) {
        if (!disposed) {
          log.debug('terminal', READ_FAILURE_MESSAGE, { error, transcriptPath });
        }
      } finally {
        reading = false;
      }
    }

    function armFallbackPoll(): void {
      if (disposed) return;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(runFallbackPoll, fallbackPollIntervalMs);
      fallbackTimer.unref?.();
    }

    function runFallbackPoll(): void {
      fallbackTimer = null;
      readTranscript(true);
      armFallbackPoll();
    }

    try {
      installWatcher();
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    armFallbackPoll();

    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        try {
          transcriptWatcher?.close();
        } catch {
        }
        transcriptWatcher = null;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        fallbackTimer = null;
        try {
          closeSync(fd);
        } catch {
        }
        pending = '';
      },
    };
  }
}
