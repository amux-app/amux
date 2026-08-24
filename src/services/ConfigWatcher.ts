import { watch, type FSWatcher } from 'chokidar';
import { EventEmitter } from 'events';
import { readFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import type { AumxPane } from '../types.js';
import { parseAumxConfig } from '../utils/persistedStateValidation.js';
import { LogService } from './LogService.js';

export interface ConfigData {
  panes: AumxPane[];
}

/**
 * Watches the aumx.config.json file for changes and emits events
 * when the file is modified. Only emits when actual changes occur.
 */
export class ConfigWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private configPath: string;
  private lastValidContent: string = '';
  private paused: boolean = false;
  private missedWhilePaused: boolean = false;

  constructor(configPath: string) {
    super();
    this.configPath = resolve(configPath);
  }

  /**
   * Temporarily pause emitting change events (for atomic operations)
   */
  pause(): void {
    this.paused = true;
  }

  /**
   * Resume emitting change events, replaying any change that landed while paused
   * so a pause window can never swallow a config update.
   */
  resume(): void {
    this.paused = false;
    if (!this.missedWhilePaused) return;
    this.missedWhilePaused = false;
    void this.handleFileChange(this.configPath);
  }

  async start(): Promise<void> {
    // Read initial content
    try {
      const initialContent = await readFile(this.configPath, 'utf-8');
      parseAumxConfig(JSON.parse(initialContent));
      this.lastValidContent = initialContent;
    } catch {
      // The file might not exist yet or may be incomplete. Keep the empty
      // last-known-good state so the first valid replacement is emitted.
      this.lastValidContent = '';
    }

    // Watch for changes
    // Production writers replace the config atomically. Watching the parent
    // directory keeps the subscription on a stable inode across renames; the
    // exact-path filter below prevents unrelated project files from emitting.
    this.watcher = watch(dirname(this.configPath), {
      depth: 0,
      persistent: true,
      ignoreInitial: true, // Don't emit on initial add
      awaitWriteFinish: {
        stabilityThreshold: 100, // Wait 100ms after last write
        pollInterval: 50
      }
    });

    this.watcher.on('change', async (path) => {
      await this.handleFileChange(path);
    });

    this.watcher.on('add', async (path) => {
      // File was created
      await this.handleFileChange(path);
    });

    this.watcher.on('error', (error) => {
      const msg = 'Config watcher error';
      LogService.getInstance().error(msg, 'ConfigWatcher', undefined, error);
    });

    await new Promise<void>((resolveReady, rejectReady) => {
      const handleReady = (): void => {
        this.watcher?.off('error', handleStartupError);
        resolveReady();
      };
      const handleStartupError = (error: unknown): void => {
        this.watcher?.off('ready', handleReady);
        rejectReady(error);
      };
      this.watcher?.once('ready', handleReady);
      this.watcher?.once('error', handleStartupError);
    });
  }

  private async handleFileChange(path: string): Promise<void> {
    if (resolve(path) !== this.configPath) return;

    // Defer while paused (during atomic operations); resume() replays it.
    if (this.paused) {
      this.missedWhilePaused = true;
      return;
    }

    try {
      const newContent = await readFile(path, 'utf-8');

      // Only emit if content actually changed
      if (newContent === this.lastValidContent) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(newContent);
        parseAumxConfig(parsed);
      } catch (parseErr) {
        const msg = 'Failed to validate config file';
        LogService.getInstance().error(msg, 'ConfigWatcher', undefined, parseErr);
        return;
      }

      this.lastValidContent = newContent;
      this.emit('change', parsed as ConfigData);
    } catch (err) {
      const msg = 'Failed to read config file';
      LogService.getInstance().error(msg, 'ConfigWatcher', undefined, err);
    }
  }

  async stop(): Promise<void> {
    const watcher = this.watcher;
    this.watcher = null;
    if (watcher) {
      await watcher.close();
    }
    this.removeAllListeners();
  }

  getConfigPath(): string {
    return this.configPath;
  }
}
