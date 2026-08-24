import chokidar, { type ChokidarOptions, type FSWatcher } from 'chokidar';
import { BrowserWindow } from 'electron';
import { relative, resolve, sep } from 'node:path';
import { HEAVY_IGNORED_DIRS } from '../../shared/filePolicy.js';
import { IPC_EVENT } from '../../shared/ipc-channels.js';
import type { FileChangedEvent, FileChangedEventType } from '../../shared/ipc-types.js';
import { log } from './Logger.js';
import { projectSearchService } from './ProjectSearchService.js';

function createIgnoredPredicate(rootPath: string): (testPath: string) => boolean {
  return (testPath: string) => {
    const relativePath = relative(rootPath, testPath);
    if (!relativePath || relativePath.startsWith('..')) {
      return false;
    }
    return relativePath.split(sep).some((segment) => HEAVY_IGNORED_DIRS.has(segment));
  };
}

const WATCHED_FILE_EVENT_TYPES = new Set<FileChangedEventType>([
  'add',
  'addDir',
  'change',
  'unlink',
  'unlinkDir',
]);

const WATCHER_CLOSE_TIMEOUT_MS = 1000;
const WATCHER_DEPTH = 0;
const FILE_BROWSER_WATCH_LOG_TAG = 'file-browser-watch';

interface ClosableFileWatcher {
  close: () => Promise<void>;
}

async function closeWatcher(watcher: ClosableFileWatcher, timeoutMs = WATCHER_CLOSE_TIMEOUT_MS): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutReached = new Promise<void>((resolveTimeout) => {
    timeout = setTimeout(resolveTimeout, timeoutMs);
  });

  await Promise.race([watcher.close(), timeoutReached]);
  if (timeout) clearTimeout(timeout);
}

function resolveWatchPath(rootPath: string): string {
  return resolve(rootPath);
}

function isIgnoredRelativePath(relativePath: string): boolean {
  return relativePath.split('/').some((segment) => HEAVY_IGNORED_DIRS.has(segment));
}

function normalizeWatchDirPath(rootPath: string, dirPath: string): string | null {
  const normalizedRootPath = resolveWatchPath(rootPath);
  const normalizedAbsolutePath = resolve(normalizedRootPath, dirPath);
  const relativePath = relative(normalizedRootPath, normalizedAbsolutePath);

  if (relativePath === '') {
    return '';
  }

  if (relativePath.startsWith(`..${sep}`) || relativePath === '..') {
    return null;
  }

  return relativePath.split(sep).join('/');
}

function normalizeWatchDirPaths(rootPath: string, dirPaths: string[] = []): string[] {
  const normalized = new Set<string>(['']);

  for (const dirPath of dirPaths) {
    const normalizedPath = normalizeWatchDirPath(rootPath, dirPath);
    if (normalizedPath !== null && !isIgnoredRelativePath(normalizedPath)) {
      normalized.add(normalizedPath);
    }
  }

  return [...normalized].sort();
}

function createWatchKey(rootPath: string, eventRootPath: string, dirPaths: string[]): string {
  return JSON.stringify([
    resolveWatchPath(rootPath),
    resolveWatchPath(eventRootPath),
    dirPaths,
  ]);
}

function createWatchTargets(rootPath: string, dirPaths: string[]): string[] {
  const normalizedRootPath = resolveWatchPath(rootPath);
  return dirPaths.map((dirPath) => (dirPath ? resolve(normalizedRootPath, dirPath) : normalizedRootPath));
}

function createWatchOptions(rootPath: string): ChokidarOptions {
  return {
    awaitWriteFinish: {
      pollInterval: 50,
      stabilityThreshold: 120,
    },
    depth: WATCHER_DEPTH,
    ignoreInitial: true,
    ignored: createIgnoredPredicate(rootPath),
    persistent: false,
  };
}

function normalizeRelativePath(rootPath: string, absolutePath: string): string | null {
  const normalizedRootPath = resolveWatchPath(rootPath);
  const normalizedAbsolutePath = resolve(absolutePath);
  const relativePath = relative(normalizedRootPath, normalizedAbsolutePath);

  if (relativePath === '') {
    return '';
  }

  if (relativePath.startsWith(`..${sep}`) || relativePath === '..') {
    return null;
  }

  return relativePath.split(sep).join('/');
}

function createFileChangedEvent(
  rootPath: string,
  absolutePath: string,
  changeType: FileChangedEventType,
  eventRootPath = rootPath,
): FileChangedEvent | null {
  const relativePath = normalizeRelativePath(rootPath, absolutePath);
  if (relativePath === null) {
    return null;
  }

  return {
    changeType,
    relativePath,
    rootPath: resolveWatchPath(eventRootPath),
  };
}

function toFileChangedEventType(value: string): FileChangedEventType | null {
  return WATCHED_FILE_EVENT_TYPES.has(value as FileChangedEventType)
    ? (value as FileChangedEventType)
    : null;
}

export class FileBrowserWatchService {
  private watchKey: string | null = null;
  private rootPath: string | null = null;
  private watcher: FSWatcher | null = null;
  private window: BrowserWindow | null;

  constructor(window: BrowserWindow | null) {
    this.window = window;
  }

  setWindow(window: BrowserWindow | null): void {
    this.window = window;
  }

  async watchRoot(
    rootPath: string | null,
    dirPaths: string[] = [],
    eventRootPath = rootPath,
  ): Promise<void> {
    const nextRootPath = rootPath ? resolveWatchPath(rootPath) : null;
    const nextEventRootPath = eventRootPath ? resolveWatchPath(eventRootPath) : nextRootPath;
    const nextDirPaths = nextRootPath ? normalizeWatchDirPaths(nextRootPath, dirPaths) : [];
    const nextWatchKey = nextRootPath && nextEventRootPath
      ? createWatchKey(nextRootPath, nextEventRootPath, nextDirPaths)
      : null;
    log.infoThrottled(FILE_BROWSER_WATCH_LOG_TAG, 'watchRoot requested', {
      currentRootPath: this.rootPath,
      currentWatcherKey: this.watchKey,
      dirPathCount: nextDirPaths.length,
      nextEventRootPath,
      nextRootPath,
      nextWatcherKey: nextWatchKey,
      watcherActive: this.watcher !== null,
    });

    if (nextWatchKey === this.watchKey) {
      log.infoThrottled(FILE_BROWSER_WATCH_LOG_TAG, 'watchRoot unchanged', {
        dirPathCount: nextDirPaths.length,
        rootPath: nextRootPath,
      });
      return;
    }

    await this.stop();

    if (!nextRootPath) {
      log.info(FILE_BROWSER_WATCH_LOG_TAG, 'watchRoot cleared');
      return;
    }

    const watchTargets = createWatchTargets(nextRootPath, nextDirPaths);
    const watcher = chokidar.watch(watchTargets, createWatchOptions(nextRootPath));

    watcher.once('ready', () => {
      log.info(FILE_BROWSER_WATCH_LOG_TAG, 'watchRoot ready', {
        rootPath: nextRootPath,
        watchedDirCount: nextDirPaths.length,
      });
    });

    watcher.on('error', (error) => {
      log.warn(FILE_BROWSER_WATCH_LOG_TAG, 'watchRoot error', { error: String(error), rootPath: nextRootPath });
    });

    watcher.on('all', (changeType, changedPath) => {
      const normalizedChangeType = toFileChangedEventType(changeType);
      if (!normalizedChangeType) {
        return;
      }

      const event = createFileChangedEvent(
        nextRootPath,
        changedPath,
        normalizedChangeType,
        nextEventRootPath ?? nextRootPath,
      );
      if (!event) {
        return;
      }

      projectSearchService.invalidate(nextRootPath);
      this.window?.webContents.send(IPC_EVENT.FILE_CHANGED, event);
    });

    this.rootPath = nextRootPath;
    this.watchKey = nextWatchKey;
    this.watcher = watcher;
    log.info(FILE_BROWSER_WATCH_LOG_TAG, 'watchRoot started', {
      rootPath: nextRootPath,
      watchedDirCount: nextDirPaths.length,
    });
  }

  async stop(): Promise<void> {
    log.infoThrottled(FILE_BROWSER_WATCH_LOG_TAG, 'stop requested', {
      rootPath: this.rootPath,
      watcherActive: this.watcher !== null,
    });
    this.rootPath = null;
    this.watchKey = null;
    if (!this.watcher) {
      log.infoThrottled(FILE_BROWSER_WATCH_LOG_TAG, 'stop skipped');
      return;
    }

    const watcher = this.watcher;
    this.watcher = null;
    await closeWatcher(watcher);
    log.info(FILE_BROWSER_WATCH_LOG_TAG, 'stop completed');
  }
}

export const __test__ = {
  closeWatcher,
  createFileChangedEvent,
  createIgnoredPredicate,
  createWatchOptions,
  createWatchTargets,
  normalizeWatchDirPaths,
};
