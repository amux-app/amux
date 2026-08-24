import { existsSync, watch, type FSWatcher } from 'fs';
import { log } from '../Logger.js';
import { fileFingerprint } from '../parsing/session-files.js';

export class SessionFileWatcher {
  private watchers = new Map<string, FSWatcher>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSeenFingerprint = '';
  private watchedPaths: string[];
  private readonly debounceMs = 75;
  private readonly pollMs = 250;

  constructor(
    private filePath: string,
    private onChange: () => void,
    watchedPaths?: readonly string[],
  ) {
    this.watchedPaths = [...new Set([filePath, ...(watchedPaths ?? [])])];
  }

  start(): void {
    this.stop();
    this.lastSeenFingerprint = this.getFingerprint();

    // Poll the full file identity as a fallback because fs.watch can coalesce
    // updates. Size also catches appends whose mtime resolution is too coarse.
    this.pollTimer = setInterval(() => {
      const currentFingerprint = this.getFingerprint();
      this.refreshWatchers();
      if (currentFingerprint !== this.lastSeenFingerprint) {
        this.lastSeenFingerprint = currentFingerprint;
        this.scheduleOnChange();
      }
    }, this.pollMs);

    this.refreshWatchers();
    log.debug('session-watcher', 'Watching session files', { files: this.watchedPaths });
  }

  updatePath(newPath: string): void {
    if (newPath === this.filePath) return;
    const oldPath = this.filePath;
    this.filePath = newPath;
    this.watchedPaths = this.watchedPaths.map((path) =>
      path === oldPath || path.startsWith(`${oldPath}-`)
        ? `${newPath}${path.slice(oldPath.length)}`
        : path,
    );
    this.start();
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  private refreshWatchers(): void {
    for (const [path, watcher] of this.watchers) {
      if (existsSync(path)) continue;
      watcher.close();
      this.watchers.delete(path);
    }

    for (const path of this.watchedPaths) {
      if (!existsSync(path) || this.watchers.has(path)) continue;
      this.watchPath(path);
    }
  }

  private watchPath(path: string): void {
    try {
      const watcher = watch(path, () => {
        this.lastSeenFingerprint = this.getFingerprint();
        this.scheduleOnChange();
      });
      watcher.on('error', (err) => {
        watcher.close();
        this.watchers.delete(path);
        log.warn('session-watcher', 'Watch error', { file: path, error: String(err) });
      });
      this.watchers.set(path, watcher);
    } catch (err) {
      log.warn('session-watcher', 'Failed to start watcher', { file: path, error: String(err) });
    }
  }

  private getFingerprint(): string {
    return this.watchedPaths
      .map((path) => fileFingerprint(path) ?? 'absent')
      .join('|');
  }

  private scheduleOnChange(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.onChange();
    }, this.debounceMs);
  }
}
