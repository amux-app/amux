import { mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { LogFileSink } from './LogFileSink.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const IMMEDIATE_FLUSH_LEVEL: LogLevel = 'warn';
const LOG_RETENTION_DAYS = 30;
const THROTTLE_WINDOW_MS = 5000;
const DAILY_LOG_FILE_PATTERN = /^muxbase-desktop-(\d{4}-\d{2}-\d{2})\.log(?:\.\d+)?$/;
/** Backstop for the per-file cap: bounds the whole log directory, not just one day. */
export const MAX_LOG_DIR_BYTES = 100 * 1024 * 1024;
/** Cannot occur in a tag or message, so tag+message keys are unambiguous. */
const THROTTLE_KEY_SEPARATOR = '\u0000';

interface LogEntry {
  ts: string;
  level: LogLevel;
  tag: string;
  msg: string;
  suppressed?: number;
  data?: unknown;
}

interface ThrottleWindow {
  windowStart: number;
  suppressed: number;
}

class DesktopLogger {
  private static instance: DesktopLogger;
  private logDir: string | null = null;
  private logFile: string | null = null;
  private minLevel: LogLevel = 'info';
  private initialized = false;
  private readonly sink = new LogFileSink();
  private readonly throttleWindows = new Map<string, ThrottleWindow>();

  private constructor() {}

  static getInstance(): DesktopLogger {
    if (!DesktopLogger.instance) {
      DesktopLogger.instance = new DesktopLogger();
    }
    return DesktopLogger.instance;
  }

  getLogDir(): string | null {
    return this.logDir;
  }

  getLogFile(): string | null {
    return this.logFile;
  }

  initialize(projectRoot?: string): void {
    // Allow re-initialization with a project root (upgrades from userData to project-specific logs)
    if (this.initialized && !projectRoot) return;

    // Use project root if provided, otherwise the app's working directory (not userData)
    const base = projectRoot || process.cwd();
    this.logDir = join(base, '.log');

    try {
      mkdirSync(this.logDir, { recursive: true });
    } catch {
      this.logDir = null;
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    this.logFile = join(this.logDir, `muxbase-desktop-${today}.log`);

    this.deleteExpiredDailyLogs();
    this.enforceSizeCap();

    this.sink.open(this.logFile);
    this.initialized = true;

    this.write('info', 'logger', 'Logger initialized', { logDir: this.logDir });
    this.sink.flush();
  }

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  debug(tag: string, msg: string, data?: unknown): void {
    this.write('debug', tag, msg, data);
  }

  info(tag: string, msg: string, data?: unknown): void {
    this.write('info', tag, msg, data);
  }

  warn(tag: string, msg: string, data?: unknown): void {
    this.write('warn', tag, msg, data);
  }

  error(tag: string, msg: string, data?: unknown): void {
    this.write('error', tag, msg, data);
  }

  /**
   * Info variant for high-frequency repeating records: emits at most one line per
   * tag+message per throttle window and reports how many were coalesced.
   */
  infoThrottled(tag: string, msg: string, data?: unknown): void {
    const key = `${tag}${THROTTLE_KEY_SEPARATOR}${msg}`;
    const now = Date.now();
    const current = this.throttleWindows.get(key);

    if (current && now - current.windowStart < THROTTLE_WINDOW_MS) {
      current.suppressed += 1;
      return;
    }

    this.throttleWindows.set(key, { windowStart: now, suppressed: 0 });
    this.write('info', tag, msg, data, current?.suppressed);
  }

  private write(level: LogLevel, tag: string, msg: string, data?: unknown, suppressed?: number): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.minLevel]) return;

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      tag,
      msg,
    };

    if (suppressed) {
      entry.suppressed = suppressed;
    }

    if (data !== undefined) {
      entry.data = data instanceof Error
        ? { message: data.message, stack: data.stack }
        : data;
    }

    this.sink.write(`${JSON.stringify(entry)}\n`, LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[IMMEDIATE_FLUSH_LEVEL]);

    // Also write to stderr for electron dev console
    const prefix = `[${entry.ts.slice(11, 23)}] [${level.toUpperCase().padEnd(5)}] [${tag}]`;
    if (level === 'error') {
      console.error(prefix, msg, data ?? '');
    } else if (level === 'warn') {
      console.warn(prefix, msg, data ?? '');
    } else {
      console.log(prefix, msg, data ?? '');
    }
  }

  shutdown(): void {
    this.write('info', 'logger', 'Logger shutting down');
    this.sink.close();
    this.throttleWindows.clear();
    this.logFile = null;
    this.initialized = false;
  }

  private deleteExpiredDailyLogs(): void {
    if (!this.logDir) return;

    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    try {
      for (const fileName of readdirSync(this.logDir)) {
        const match = DAILY_LOG_FILE_PATTERN.exec(fileName);
        if (!match) continue;

        const fileTime = Date.parse(`${match[1]}T00:00:00.000Z`);
        if (!Number.isFinite(fileTime) || fileTime >= cutoff) continue;

        rmSync(join(this.logDir, fileName), { force: true });
      }
    } catch (error) {
      this.write('warn', 'logger', 'Log retention cleanup failed', error);
    }
  }

  /** The active file is never a deletion candidate: the sink must keep a file to write to. */
  private enforceSizeCap(): void {
    const logDir = this.logDir;
    if (!logDir) return;

    try {
      const dailyLogs = readdirSync(logDir)
        .filter((fileName) => DAILY_LOG_FILE_PATTERN.test(fileName))
        .map((fileName) => {
          const path = join(logDir, fileName);
          const stats = statSync(path, { throwIfNoEntry: false });
          return { path, size: stats?.size ?? 0, mtimeMs: stats?.mtimeMs ?? 0 };
        });

      let totalBytes = dailyLogs.reduce((sum, entry) => sum + entry.size, 0);
      if (totalBytes <= MAX_LOG_DIR_BYTES) return;

      const oldestFirst = dailyLogs
        .filter((entry) => entry.path !== this.logFile)
        .sort((a, b) => a.mtimeMs - b.mtimeMs);

      for (const entry of oldestFirst) {
        if (totalBytes <= MAX_LOG_DIR_BYTES) return;
        rmSync(entry.path, { force: true });
        totalBytes -= entry.size;
      }
    } catch (error) {
      this.write('warn', 'logger', 'Log size cap cleanup failed', error);
    }
  }

}

export const log = DesktopLogger.getInstance();
