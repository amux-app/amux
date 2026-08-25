/**
 * Centralized Logging Service for muxbase
 *
 * Replaces scattered console.log/error calls with a unified logging system
 * that can be viewed in a dedicated UI without messing up pane formatting.
 */

import { EventEmitter } from 'events';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: string;
  timestamp: number;
  level: LogLevel;
  message: string;
  source?: string;  // e.g., 'git', 'tmux', 'paneActions', 'api'
  paneId?: string;  // Associate log with a specific pane
  read: boolean;
  stack?: string;   // Stack trace for errors
}

/**
 * Efficient circular buffer for log entries
 * Provides O(1) insertion and bounded memory usage
 */
class CircularBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0; // Next write position
  private size = 0; // Current number of items

  constructor(private readonly capacity: number) {
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size++;
    }
  }

  /**
   * Get all items in order (oldest to newest)
   */
  toArray(): T[] {
    if (this.size === 0) return [];

    const result: T[] = [];
    const start = this.size < this.capacity ? 0 : this.head;

    for (let i = 0; i < this.size; i++) {
      const idx = (start + i) % this.capacity;
      const item = this.buffer[idx];
      if (item !== undefined) {
        result.push(item);
      }
    }
    return result;
  }

  /**
   * Filter items matching a predicate
   */
  filter(predicate: (item: T) => boolean): T[] {
    return this.toArray().filter(predicate);
  }

  /**
   * Find and modify items in place
   */
  forEach(fn: (item: T) => void): void {
    for (let i = 0; i < this.capacity; i++) {
      const item = this.buffer[i];
      if (item !== undefined) {
        fn(item);
      }
    }
  }

  getSize(): number {
    return this.size;
  }

  clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.size = 0;
  }

  /**
   * Remove items matching predicate (creates new buffer - O(n))
   * Used for clearForPane which is rare
   */
  removeMatching(predicate: (item: T) => boolean): number {
    const kept = this.filter(item => !predicate(item));
    const removed = this.size - kept.length;

    if (removed > 0) {
      this.clear();
      kept.forEach(item => this.push(item));
    }

    return removed;
  }
}

/**
 * LogService singleton - central logging hub for muxbase
 *
 * Performance optimizations:
 * - Uses circular buffer for O(1) log insertion
 * - Bounded memory usage (1000 entries max)
 * - No array shifting on overflow
 */
export class LogService extends EventEmitter {
  private static instance: LogService;
  private logs: CircularBuffer<LogEntry>;
  private readonly maxLogs: number = 1000; // Circular buffer size
  private logCounter: number = 0;

  private constructor() {
    super();
    this.logs = new CircularBuffer(this.maxLogs);
  }

  static getInstance(): LogService {
    if (!LogService.instance) {
      LogService.instance = new LogService();
    }
    return LogService.instance;
  }

  private suppressConsole = false;

  /**
   * Suppress console output (prevents logs from appearing in terminal)
   */
  setSuppressConsole(suppress: boolean): void {
    this.suppressConsole = suppress;
  }

  /**
   * Add a log entry (O(1) operation with circular buffer)
   */
  private addLog(level: LogLevel, message: string, source?: string, paneId?: string, stack?: string): void {
    const entry: LogEntry = {
      id: `log-${Date.now()}-${this.logCounter++}`,
      timestamp: Date.now(),
      level,
      message,
      source,
      paneId,
      read: false,
      stack,
    };

    // O(1) insertion - circular buffer handles overflow automatically
    this.logs.push(entry);

    // Emit event for listeners (StateManager will pick this up)
    this.emit('log-added', entry);

    // Also log to console for development (can be disabled in production)
    if (!this.suppressConsole && (process.env.NODE_ENV !== 'production' || level === 'error')) {
      const prefix = `[${source || 'muxbase'}]`;
      switch (level) {
        case 'error':
          console.error(prefix, message, stack || '');
          break;
        case 'warn':
          console.warn(prefix, message);
          break;
        case 'info':
          console.log(prefix, message);
          break;
        case 'debug':
          // Always show debug logs
          console.log(prefix, message);
          break;
      }
    }
  }

  /**
   * Log an error
   */
  error(message: string, source?: string, paneId?: string, error?: unknown): void {
    const stack = this.getErrorDetails(error);
    this.addLog('error', message, source, paneId, stack);
  }

  private getErrorDetails(error: unknown): string | undefined {
    if (error instanceof Error) {
      return error.stack ?? error.message;
    }
    if (error === undefined) {
      return undefined;
    }
    return String(error);
  }

  /**
   * Log a warning
   */
  warn(message: string, source?: string, paneId?: string): void {
    this.addLog('warn', message, source, paneId);
  }

  /**
   * Log an info message
   */
  info(message: string, source?: string, paneId?: string): void {
    this.addLog('info', message, source, paneId);
  }

  /**
   * Log a debug message
   */
  debug(message: string, source?: string, paneId?: string): void {
    this.addLog('debug', message, source, paneId);
  }

  /**
   * Get all logs with optional filtering
   */
  getLogs(filter?: {
    level?: LogLevel | LogLevel[];
    source?: string;
    paneId?: string;
    unreadOnly?: boolean;
  }): LogEntry[] {
    let filtered = this.logs.toArray();

    if (filter) {
      if (filter.level) {
        const levels = Array.isArray(filter.level) ? filter.level : [filter.level];
        filtered = filtered.filter(log => levels.includes(log.level));
      }

      if (filter.source) {
        filtered = filtered.filter(log => log.source === filter.source);
      }

      if (filter.paneId) {
        filtered = filtered.filter(log => log.paneId === filter.paneId);
      }

      if (filter.unreadOnly) {
        filtered = filtered.filter(log => !log.read);
      }
    }

    // Return oldest first (newest at bottom)
    return filtered;
  }

  /**
   * Get count of unread errors
   */
  getUnreadErrorCount(): number {
    return this.logs.filter(log => log.level === 'error' && !log.read).length;
  }

  /**
   * Get count of unread warnings
   */
  getUnreadWarningCount(): number {
    return this.logs.filter(log => log.level === 'warn' && !log.read).length;
  }

  /**
   * Mark specific logs as read
   */
  markAsRead(logIds: string[]): void {
    const idsSet = new Set(logIds);
    this.logs.forEach(log => {
      if (idsSet.has(log.id)) {
        log.read = true;
      }
    });
    this.emit('logs-marked-read', logIds);
  }

  /**
   * Mark all logs as read
   */
  markAllAsRead(): void {
    this.logs.forEach(log => {
      log.read = true;
    });
    this.emit('all-logs-marked-read');
  }

  /**
   * Mark all logs for a specific level as read
   */
  markLevelAsRead(level: LogLevel): void {
    const markedIds: string[] = [];
    this.logs.forEach(log => {
      if (log.level === level && !log.read) {
        log.read = true;
        markedIds.push(log.id);
      }
    });
    if (markedIds.length > 0) {
      this.emit('logs-marked-read', markedIds);
    }
  }

  /**
   * Clear all logs
   */
  clearAll(): void {
    this.logs.clear();
    this.emit('logs-cleared');
  }

  /**
   * Clear logs for a specific pane
   */
  clearForPane(paneId: string): void {
    const removed = this.logs.removeMatching(log => log.paneId === paneId);
    if (removed > 0) {
      this.emit('logs-cleared', { paneId, count: removed });
    }
  }

  /**
   * Get summary stats
   */
  getStats(): {
    total: number;
    errors: number;
    warnings: number;
    unreadErrors: number;
    unreadWarnings: number;
  } {
    const allLogs = this.logs.toArray();
    return {
      total: allLogs.length,
      errors: allLogs.filter(l => l.level === 'error').length,
      warnings: allLogs.filter(l => l.level === 'warn').length,
      unreadErrors: this.getUnreadErrorCount(),
      unreadWarnings: this.getUnreadWarningCount(),
    };
  }

  /**
   * Reset the service (for testing)
   */
  reset(): void {
    this.logs.clear();
    this.logCounter = 0;
    this.removeAllListeners();
  }

}

// Export singleton instance
export default LogService.getInstance();
