import { closeSync, fstatSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'fs';

const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROTATED_LOG_FILES = 3;
const FLUSH_INTERVAL_MS = 250;
const MAX_BUFFERED_BYTES = 64 * 1024;
const MISSING_FILE_CODE = 'ENOENT';

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === MISSING_FILE_CODE;
}

/**
 * Every app instance shares the daily log file, so a second one can rotate a path away
 * between this instance's own steps. A path that vanished mid-rotation is that race
 * completing, not a failure: its generation already went where this step wanted it.
 */
function ignoringLostRotationRace(step: () => void): void {
  try {
    step();
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function rotateFiles(filePath: string): void {
  ignoringLostRotationRace(() => unlinkSync(`${filePath}.${MAX_ROTATED_LOG_FILES}`));

  for (let index = MAX_ROTATED_LOG_FILES - 1; index >= 1; index -= 1) {
    ignoringLostRotationRace(() => renameSync(`${filePath}.${index}`, `${filePath}.${index + 1}`));
  }

  ignoringLostRotationRace(() => renameSync(filePath, `${filePath}.1`));
}

/**
 * Append-only log sink that keeps one file descriptor open and batches writes.
 * Rotation reads the size from disk once per flush — never per line — because a
 * second app instance can append to and rotate the same daily file.
 */
export class LogFileSink {
  private fd: number | null = null;
  private filePath: string | null = null;
  private fileIno = 0;
  private buffer: string[] = [];
  private bufferedBytes = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly flushOnExit = (): void => {
    this.flush();
  };

  open(filePath: string): void {
    this.close();
    this.filePath = filePath;
    this.openFile(filePath);
    process.on('exit', this.flushOnExit);
  }

  write(line: string, immediate: boolean): void {
    if (this.filePath === null) return;

    this.buffer.push(line);
    this.bufferedBytes += Buffer.byteLength(line, 'utf8');

    if (immediate || this.bufferedBytes >= MAX_BUFFERED_BYTES) {
      this.flush();
      return;
    }

    this.scheduleFlush();
  }

  flush(): void {
    this.clearFlushTimer();
    const filePath = this.filePath;
    if (filePath === null || this.buffer.length === 0) return;

    try {
      this.rotateIfNeeded(filePath, this.bufferedBytes);
      writeSync(this.fd ?? this.openFile(filePath), this.buffer.join(''));
      this.buffer = [];
      this.bufferedBytes = 0;
    } catch {
      // Records stay buffered for the next flush, which reopens the file first.
      this.dropOldestBufferedRecords();
    }
  }

  close(): void {
    this.flush();
    this.closeFd();
    process.off('exit', this.flushOnExit);
    this.filePath = null;
  }

  private openFile(filePath: string): number {
    this.fd = openSync(filePath, 'a');
    this.fileIno = fstatSync(this.fd).ino;
    return this.fd;
  }

  private closeFd(): void {
    if (this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
  }

  private rotateIfNeeded(filePath: string, nextBytes: number): void {
    const stats = statSync(filePath, { throwIfNoEntry: false });
    if (!stats || stats.ino !== this.fileIno) {
      this.closeFd();
      this.openFile(filePath);
      return;
    }

    if (stats.size + nextBytes <= MAX_LOG_FILE_BYTES) return;

    this.closeFd();
    try {
      rotateFiles(filePath);
    } finally {
      // Reopening unconditionally is what keeps a failed rotation recoverable.
      this.openFile(filePath);
    }
  }

  /** A sink that cannot write must not grow without bound; the newest records win. */
  private dropOldestBufferedRecords(): void {
    while (this.bufferedBytes > MAX_BUFFERED_BYTES && this.buffer.length > 0) {
      const [dropped] = this.buffer.splice(0, 1);
      this.bufferedBytes -= Buffer.byteLength(dropped, 'utf8');
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
}
