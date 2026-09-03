import { is } from '@electron-toolkit/utils';
import {
  abortAllConflictMergeTransactions,
  getEnhancedPathAsync,
  listConflictMergeTransactions,
  loadSystemRequirements,
  selectAndFreezeTmuxProvider,
  validateRequiredSystemRequirements,
} from 'muxbase/core';
import { app, BrowserWindow, crashReporter, dialog, Menu, nativeImage, nativeTheme, powerMonitor, session, shell } from 'electron';
import windowStateKeeper from 'electron-window-state';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'path';
import { APP_WINDOW_BACKGROUND_COLORS } from '../shared/app-colors.js';
import { IPC_EVENT } from '../shared/ipc-channels.js';
import { TRAFFIC_LIGHT_ORIGIN } from '../shared/titlebar-metrics.js';
import { createApplicationMenuTemplate } from './app-menu.js';
import {
  isHeadlessE2E,
  resolveE2EActivationPolicy,
  resolveWindowOpacity,
} from './e2e-window-mode.js';
import { applyDebugLoggingLevel, applyWindowSettings } from './ipc/electron-settings.handlers.js';
import { registerAllHandlers } from './ipc/index.js';
import { setMainWindowResolver } from './ipc/ipc-security.js';
import { getAppThemeMode, syncWindowBackgroundColors } from './services/app-theme.js';
import { AppBootService } from './services/AppBootService.js';
import { MuxBaseBridge } from './services/MuxBaseBridge.js';
import { ElectronSettingsService } from './services/ElectronSettingsService.js';
import { createE2EUpdateHarness } from './services/E2EUpdateClient.js';
import { createElectronUpdateService } from './services/ElectronUpdateService.js';
import { log } from './services/Logger.js';
import { PerformanceMonitorService } from './services/PerformanceMonitorService.js';
import { RendererFileFlushCoordinator } from './services/RendererFileFlushCoordinator.js';
import { StartupTimeline } from './services/StartupTimeline.js';
import { recoverTerminalRenderersAfterChildProcessExit } from './services/terminal-renderer-recovery.js';
import {
  waitForOperationSettlement,
  withStartupTimeout,
} from './services/startup-timeout.js';
import {
  resetTerminalManager,
  setTerminalRendererVisibility,
} from './services/TerminalStreamService.js';
import { cleanupDetachedTerminalPtyViewSessions } from './services/terminal-pty-session.js';
import {
  createDiscardUnsavedChangesOptions,
  runGuardedApplicationQuit,
  runGuardedRendererAction,
  runSingleFlight,
  shouldBypassQuitDiscardPrompt,
  type QuitShutdownResult,
  type UnsavedChangesAction,
} from './services/UnsavedChangesGuard.js';
import type { UpdateService } from './services/UpdateService.js';
import { monitorWindowVisibility } from './services/WindowVisibilityMonitor.js';
import { resolveAppIconFileName } from './utils/appIcon.js';
import { isSafeExternalUrl } from './utils/externalUrl.js';
import { isAllowedAppNavigationUrl } from './utils/navigation.js';
import { configureWindowStatePersistence } from './window-state.js';

let mainWindow: BrowserWindow | null = null;
let bridge: MuxBaseBridge | null = null;
let ownedTestUserDataPath: string | null = null;
let updateService: UpdateService | null = null;

let shutdownPromise: Promise<QuitShutdownResult> | null = null;
let quitPreparationPromise: Promise<void> | null = null;
let quitAfterShutdown = false;
let quitForUpdate = false;
let startupAbortController: AbortController | null = null;
let startupOperation: Promise<void> | null = null;
const BRIDGE_INITIALIZATION_TIMEOUT_MS = 30_000;
const QUIT_SHUTDOWN_TIMEOUT_MS = 5_000;
const STARTUP_SHUTDOWN_GRACE_MS = 3_000;
const DISCARD_BUTTON_INDEX = 1;
const appBootService = new AppBootService(() => mainWindow);
const rendererFileFlushCoordinator = new RendererFileFlushCoordinator();

app.name = 'MuxBase';

const e2eActivationPolicy = resolveE2EActivationPolicy(process.env, process.platform);
if (e2eActivationPolicy) {
  // This must run synchronously during main-process startup, before macOS can
  // activate the normal application and switch away from the user's workspace.
  app.setActivationPolicy(e2eActivationPolicy);
}

if (process.env.NODE_ENV === 'test' && process.env.MUXBASE_E2E === '1') {
  // Only a directory this process created is ours to delete on quit; a
  // caller-supplied one belongs to the caller and is left untouched.
  if (process.env.MUXBASE_E2E_USER_DATA_DIR) {
    app.setPath('userData', resolve(process.env.MUXBASE_E2E_USER_DATA_DIR));
  } else {
    ownedTestUserDataPath = mkdtempSync(join(tmpdir(), 'muxbase-e2e-'));
    app.setPath('userData', ownedTestUserDataPath);
  }
} else if (process.env.MUXBASE_USER_DATA_DIR) {
  // Worktree-scoped dev: each worktree gets its own user-data dir so parallel
  // dev instances don't share electron-store / cookies / window state.
  app.setPath('userData', process.env.MUXBASE_USER_DATA_DIR);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

const crashUploadUrl = process.env.MUXBASE_CRASH_REPORT_URL?.trim();
crashReporter.start({
  productName: 'MuxBase',
  companyName: 'MuxBase',
  submitURL: crashUploadUrl || 'https://example.invalid/muxbase-crash-report-disabled',
  uploadToServer: Boolean(crashUploadUrl),
  compress: true,
  ignoreSystemCrashHandler: false,
  extra: {
    releaseChannel: process.env.MUXBASE_RELEASE_CHANNEL ?? (is.dev ? 'dev' : 'stable'),
  },
});

function openExternalUrl(url: string): void {
  if (isSafeExternalUrl(url)) {
    void shell.openExternal(url).catch((error) => {
      log.warn('app', 'Failed to open external URL', { error: String(error), url });
    });
  } else {
    log.warn('app', 'Blocked unsafe external URL', { url });
  }
}

function getRendererEntryUrl(): string {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    return process.env['ELECTRON_RENDERER_URL'];
  }
  return pathToFileURL(join(__dirname, '../renderer/index.html')).toString();
}

function getAppIconPath(): string {
  return join(__dirname, '../../resources', resolveAppIconFileName(is.dev));
}

// macOS parks the traffic lights off-screen in fullscreen, so the renderer needs
// to know when to reclaim the gutter it reserves for them.
function publishFullScreenState(win: BrowserWindow): void {
  const send = () => win.webContents.send(IPC_EVENT.WINDOW_FULL_SCREEN_CHANGED, win.isFullScreen());
  win.on('enter-full-screen', send);
  win.on('leave-full-screen', send);
  win.webContents.on('did-finish-load', send);
}

function createWindow(): BrowserWindow {
  const iconPath = getAppIconPath();
  const icon = nativeImage.createFromPath(iconPath);
  const headlessE2E = isHeadlessE2E(process.env);
  const rendererEntryUrl = getRendererEntryUrl();

  // Restore the previous normal window bounds before the renderer performs its
  // first layout: terminals fit themselves to the window on attach, so opening
  // at a stale default size forces a tmux-wide resize storm once the user fixes it.
  const windowState = windowStateKeeper({
    defaultWidth: 1200,
    defaultHeight: 800,
    fullScreen: false,
    maximize: false,
  });

  const win = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: APP_WINDOW_BACKGROUND_COLORS[getAppThemeMode()],
    opacity: resolveWindowOpacity(process.env, 1),
    show: false,
    skipTaskbar: headlessE2E,
    icon,
    titleBarStyle: 'hidden',
    trafficLightPosition: TRAFFIC_LIGHT_ORIGIN,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      backgroundThrottling: !headlessE2E,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  configureWindowStatePersistence(win, windowState);
  publishFullScreenState(win);

  monitorWindowVisibility(app, win, (visible) => {
    void setTerminalRendererVisibility(visible);
    bridge?.syncWindowVisibility();
  });
  win.on('ready-to-show', () => {
    if (headlessE2E) {
      win.showInactive();
    } else {
      win.show();
    }
  });

  win.on('close', (e) => {
    if (process.env.NODE_ENV === 'test' || quitAfterShutdown) return;

    e.preventDefault();

    dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Quit', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Quit MuxBase',
      message: 'Are you sure you want to quit?',
      detail: 'Any running agents will continue in the background.',
    }).then(({ response }) => {
      if (response === 0) {
        windowState.saveState(win);
        app.quit();
      }
    });
  });

  win.webContents.setWindowOpenHandler((details) => {
    openExternalUrl(details.url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (isAllowedAppNavigationUrl(url, { isDev: is.dev, rendererUrl: rendererEntryUrl })) return;
    event.preventDefault();
    openExternalUrl(url);
  });

  // Electron resets zoom on every load, so re-apply the persisted factor here
  // instead of once at startup.
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(ElectronSettingsService.getInstance().get('uiZoom'));
  });

  return win;
}

function loadRenderer(win: BrowserWindow): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
    return;
  }

  const rendererFile = join(__dirname, '../renderer/index.html');
  if (process.env.NODE_ENV === 'test') {
    void win.loadFile(rendererFile, { query: { e2e: '1' } });
  } else {
    void win.loadFile(rendererFile);
  }
}

app.on('activate', () => {
  if (!hasSingleInstanceLock || BrowserWindow.getAllWindows().length > 0) return;

  log.info('app', 'Reactivating — creating new window');
  mainWindow = createWindow();
  bridge?.setWindow(mainWindow);
  loadRenderer(mainWindow);
});

function shutdownAppServices(): Promise<QuitShutdownResult> {
  if (!hasSingleInstanceLock) return Promise.resolve('complete');
  if (!shutdownPromise) {
    const shutdownOperation = (async () => {
      let teardownStarted = false;
      try {
        // Obtain explicit conflict-merge consent before aborting startup or
        // tearing down services. A cancelled prompt must leave shutdown
        // retryable and must not emit a shutdown-complete log entry.
        if (!await prepareConflictMergesForShutdown(quitForUpdate ? 'update' : 'quit')) {
          return 'cancelled';
        }

        teardownStarted = true;
        log.info('app', 'Before quit — shutting down app services');
        startupAbortController?.abort();
        const startupSettlement = await waitForOperationSettlement(
          startupOperation,
          STARTUP_SHUTDOWN_GRACE_MS,
        );
        if (startupSettlement === 'timed-out') {
          log.error('app', 'Startup did not stop within the shutdown grace period; forcing process exit', {
            graceMs: STARTUP_SHUTDOWN_GRACE_MS,
          });
          return 'force-exit';
        }
        updateService?.stop();
        updateService = null;
        resetTerminalManager();
        await cleanupDetachedPtyViewSessions('shutdown');
        if (bridge) {
          const activeBridge = bridge;
          bridge = null;
          await activeBridge.shutdown();
        }
        return 'complete';
      } catch (error) {
        log.error('app', 'Failed during app shutdown', error);
        return 'complete';
      } finally {
        if (teardownStarted) log.shutdown();
      }
    })();
    shutdownPromise = shutdownOperation;
    void shutdownOperation.then((result) => {
      if (result === 'cancelled' && shutdownPromise === shutdownOperation) {
        shutdownPromise = null;
      }
    });
  }
  return shutdownPromise;
}

function requestRendererFileFlush(): Promise<boolean> {
  const win = mainWindow;
  if (
    !win
    || win.isDestroyed()
    || win.webContents.isDestroyed()
    || win.webContents.isLoading()
  ) {
    return Promise.resolve(true);
  }

  return rendererFileFlushCoordinator.request((requestId) => {
    win.webContents.send(IPC_EVENT.APP_FILE_FLUSH_REQUESTED, { requestId });
  });
}

async function confirmDiscardUnsavedChanges(action: UnsavedChangesAction): Promise<boolean> {
  const options = createDiscardUnsavedChangesOptions(action);
  const win = mainWindow;
  const result = win && !win.isDestroyed()
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);

  if (result.response !== DISCARD_BUTTON_INDEX) {
    const actionLabel = action === 'quit' ? 'Quit' : action === 'reload' ? 'Reload' : 'Update restart';
    log.info('app', `${actionLabel} cancelled — unsaved file changes kept`);
    return false;
  }

  return true;
}

async function prepareConflictMergesForShutdown(action: 'quit' | 'reload' | 'update'): Promise<boolean> {
  const transactions = listConflictMergeTransactions().filter((transaction) => transaction.state === 'active');
  const transactionCount = bridge ? await bridge.getActiveConflictMergeCount() : transactions.length;
  if (transactionCount === 0) return true;

  const actionLabel = action === 'update' ? 'restart and update' : action;
  const options = {
    buttons: ['Cancel', 'Abort merges and continue'],
    cancelId: 0,
    defaultId: 0,
    detail: `MuxBase found ${transactionCount} active conflict merge${transactionCount === 1 ? '' : 's'} before it can ${actionLabel}. Aborting restores each worktree to a clean state.`,
    message: 'Active conflict resolutions need a decision.',
    noLink: true,
    title: 'Abort Conflict Merges?',
    type: 'warning' as const,
  };
  const win = mainWindow;
  const result = win && !win.isDestroyed()
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);

  if (result.response !== 1) {
    log.info('app', 'Shutdown cancelled while active conflict merges remained');
    return false;
  }

  const aborted = bridge
    ? await bridge.disposeConflictMergesForShutdown()
    : await abortAllConflictMergeTransactions();
  if (aborted.success) return true;

  const failureOptions = {
      buttons: ['OK'],
      detail: aborted.failures.map((failure) => `${failure.repoPath}: ${failure.error}`).join('\n'),
      message: 'MuxBase could not safely abort every active conflict merge.',
      noLink: true,
      title: 'Conflict Merge Cleanup Failed',
      type: 'error' as const,
    };
  if (win && !win.isDestroyed()) {
    await dialog.showMessageBox(win, failureOptions);
  } else {
    await dialog.showMessageBox(failureOptions);
  }
  return false;
}

function confirmQuitDiscard(): Promise<boolean> {
  if (shouldBypassQuitDiscardPrompt(process.env, app.isPackaged)) {
    log.info('app', 'Automated Electron teardown bypassed the unsaved-changes quit prompt');
    return Promise.resolve(true);
  }
  log.warn('app', 'Open file draft could not be saved — asking whether to discard it');
  return confirmDiscardUnsavedChanges('quit');
}

async function performRendererReload(ignoreCache: boolean): Promise<void> {
  const win = mainWindow;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;

  try {
    await runGuardedRendererAction({
      confirmDiscard: () => confirmDiscardUnsavedChanges('reload'),
      perform: async () => {
        if (!await prepareConflictMergesForShutdown('reload')) return false;
        if (win.isDestroyed() || win.webContents.isDestroyed()) return;
        if (ignoreCache) {
          win.webContents.reloadIgnoringCache();
        } else {
          win.reload();
        }
      },
      requestFlush: requestRendererFileFlush,
    });
  } catch (error) {
    log.warn('app', 'Failed to prepare renderer reload', { error, ignoreCache });
  }
}

const reloadRenderer = runSingleFlight(performRendererReload);

function subscribeToUpdateWakeEvents(listener: () => void): () => void {
  app.on('browser-window-focus', listener);
  powerMonitor.on('resume', listener);
  return () => {
    app.removeListener('browser-window-focus', listener);
    powerMonitor.removeListener('resume', listener);
  };
}

async function prepareUpdateInstallation(): Promise<boolean> {
  let prepared = false;
  const completed = await runGuardedApplicationQuit({
    confirmDiscard: () => confirmDiscardUnsavedChanges('update'),
    finishQuit: () => {
      prepared = true;
    },
    forceExit: () => {
      prepared = true;
      log.warn('app', 'Update shutdown exceeded the graceful deadline; continuing with installer restart', {
        timeoutMs: QUIT_SHUTDOWN_TIMEOUT_MS,
      });
    },
    requestFlush: requestRendererFileFlush,
    shutdown: shutdownAppServices,
    shutdownTimeoutMs: QUIT_SHUTDOWN_TIMEOUT_MS,
  });
  return completed && prepared;
}

function installApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(createApplicationMenuTemplate({
    checkForUpdates: () => {
      void updateService?.checkForUpdates(true);
    },
    reloadRenderer: (ignoreCache) => {
      void reloadRenderer(ignoreCache);
    },
  })));
}

async function cleanupDetachedPtyViewSessions(reason: 'startup' | 'shutdown'): Promise<void> {
  try {
    const cleaned = await cleanupDetachedTerminalPtyViewSessions();
    if (cleaned > 0) {
      log.info('app', 'Cleaned detached PTY view sessions', { cleaned, reason });
    }
  } catch (error) {
    log.debug('app', 'Detached PTY view-session cleanup failed', { error, reason });
  }
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  const startupTimeline = new StartupTimeline();
  const enhancedPath = getEnhancedPathAsync();
  const settings = ElectronSettingsService.getInstance().getAll();
  applyDebugLoggingLevel(settings.debugLogging);

  const logRoot = is.dev ? resolve(__dirname, '../../..') : app.getPath('logs');
  log.initialize(logRoot);

  if (!is.dev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: https:; connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
          ],
        },
      });
    });
  }
  log.info('app', 'Electron app ready', { pid: process.pid, dev: is.dev });

  if (process.platform === 'darwin' && app.dock && is.dev) {
    const dockIcon = nativeImage.createFromPath(getAppIconPath());
    app.dock.setIcon(dockIcon);
  }

  mainWindow = createWindow();
  startupTimeline.mark('windowCreated');
  log.info('app', 'Main window created');

  nativeTheme.on('updated', syncWindowBackgroundColors);

  app.on('render-process-gone', (_event, webContents, details) => {
    log.error('app', `Renderer process gone (${details.reason})`, {
      exitCode: details.exitCode,
      webContentsId: webContents.id,
    });
  });

  app.on('child-process-gone', (_event, details) => {
    log.error('app', `Child process gone (${details.type}:${details.reason})`, {
      serviceName: details.serviceName,
      name: details.name,
      exitCode: details.exitCode,
    });
    recoverTerminalRenderersAfterChildProcessExit(mainWindow, details.type);
  });

  applyWindowSettings(mainWindow, settings);

  if (settings.showPerformanceMetrics) {
    PerformanceMonitorService.getInstance().start();
  }

  bridge = MuxBaseBridge.getInstance();
  bridge.setWindow(mainWindow);
  setMainWindowResolver(() => bridge?.getWindow()?.webContents ?? null);

  const e2eUpdateHarness = createE2EUpdateHarness(process.env);
  const activeUpdateService = createElectronUpdateService({
    beforeQuitAndInstall: () => {
      quitForUpdate = true;
    },
    currentVersion: e2eUpdateHarness?.currentVersion ?? app.getVersion(),
    isDev: e2eUpdateHarness ? false : is.dev,
    isInApplicationsFolder: e2eUpdateHarness
      ? e2eUpdateHarness.inApplicationsFolder
      : process.platform === 'darwin' && app.isInApplicationsFolder(),
    isPackaged: e2eUpdateHarness ? true : app.isPackaged,
    platform: process.platform,
    prepareInstall: prepareUpdateInstallation,
    subscribeToWakeEvents: subscribeToUpdateWakeEvents,
    updateChecksDisabled: process.env.MUXBASE_DISABLE_UPDATE_CHECKS,
    updater: e2eUpdateHarness?.updater,
  });
  updateService = activeUpdateService;
  activeUpdateService.subscribe((snapshot) => {
    const win = mainWindow;
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(IPC_EVENT.UPDATE_STATE_CHANGED, snapshot);
  });

  registerAllHandlers(
    bridge,
    appBootService,
    (request) => rendererFileFlushCoordinator.complete(request),
    activeUpdateService,
  );
  log.info('app', 'IPC handlers registered');

  mainWindow.webContents.once('did-finish-load', () => {
    activeUpdateService.start();
    void (startupOperation ?? Promise.resolve())
      .then(() => bridge?.notifyConflictMergeRecovery())
      .catch((error) => {
        log.warn('app', 'Failed to publish interrupted conflict merge recovery notice', {
          error: String(error),
        });
      });
  });
  loadRenderer(mainWindow);
  startupTimeline.mark('rendererRequested');
  log.info('app', 'Renderer load requested');

  installApplicationMenu();

  const controller = new AbortController();
  startupAbortController = controller;
  const startup = (async (): Promise<'blocked' | 'ready'> => {
    const resolvedPath = await enhancedPath;
    controller.signal.throwIfAborted();
    if (resolvedPath) process.env.PATH = resolvedPath;
    const tmuxProvider = await selectAndFreezeTmuxProvider(loadSystemRequirements().tmux.minimum);
    controller.signal.throwIfAborted();
    log.info('app', 'Resolved tmux provider', {
      source: tmuxProvider.source,
      status: tmuxProvider.status,
      tmuxPath: tmuxProvider.path,
      version: tmuxProvider.version ?? tmuxProvider.detected,
    });
    const preflight = await validateRequiredSystemRequirements();
    controller.signal.throwIfAborted();
    startupTimeline.mark('preflightComplete');
    if (!preflight.canRun) {
      appBootService.setBlocked(preflight.errors);
      log.warn('app', 'Startup blocked by missing dependencies', {
        errors: preflight.errors,
        timingsMs: startupTimeline.snapshot(),
      });
      return 'blocked';
    }
    await bridge.initialize({ signal: controller.signal });
    controller.signal.throwIfAborted();
    return 'ready';
  })();
  const trackedStartup = startup.then(() => undefined, () => undefined);
  startupOperation = trackedStartup;
  void trackedStartup.then(() => {
    if (startupOperation === trackedStartup) startupOperation = null;
    if (startupAbortController === controller) startupAbortController = null;
  });

  try {
    const result = await withStartupTimeout(
      startup,
      BRIDGE_INITIALIZATION_TIMEOUT_MS,
      'Workspace startup',
    );
    if (result === 'blocked') return;
    startupTimeline.mark('bridgeReady');
    appBootService.setReady();
    void cleanupDetachedPtyViewSessions('startup');
    startupTimeline.mark('ready');
    log.info('app', 'MuxBaseBridge initialized successfully', {
      timingsMs: startupTimeline.snapshot(),
    });
  } catch (error) {
    const cancellationRequested = controller.signal.aborted;
    controller.abort();
    if (cancellationRequested) {
      log.info('app', 'Startup cancelled during application shutdown');
      return;
    }
    log.error('app', 'Failed to initialize MuxBaseBridge', error);
    appBootService.setFailed(
      error instanceof Error ? error.message : 'MuxBase could not finish starting.',
    );
    log.info('app', 'Startup failed', { timingsMs: startupTimeline.snapshot() });
  }
});

app.on('window-all-closed', () => {
  log.info('app', 'All windows closed — quitting');
  app.quit();
});

app.on('before-quit', (event) => {
  // A process that never acquired the lock does not own shared tmux view
  // sessions and must exit without running the primary instance's cleanup.
  if (!hasSingleInstanceLock) return;
  if (quitForUpdate) return;
  if (quitAfterShutdown) return;

  event.preventDefault();
  if (quitPreparationPromise) return;

  quitPreparationPromise = runGuardedApplicationQuit({
    confirmDiscard: confirmQuitDiscard,
    finishQuit: () => {
      quitAfterShutdown = true;
      app.quit();
    },
    forceExit: () => {
      log.warn('app', 'Graceful shutdown did not finish before the quit deadline; forcing process exit', {
        timeoutMs: QUIT_SHUTDOWN_TIMEOUT_MS,
      });
      app.exit(0);
    },
    requestFlush: requestRendererFileFlush,
    shutdown: shutdownAppServices,
    shutdownTimeoutMs: QUIT_SHUTDOWN_TIMEOUT_MS,
  }).catch((error) => {
    log.error('app', 'Failed to prepare application quit', { error });
    return false;
  }).then(() => undefined).finally(() => {
    if (!quitAfterShutdown) {
      quitPreparationPromise = null;
    }
  });
});

app.on('quit', () => {
  if (ownedTestUserDataPath) {
    rmSync(ownedTestUserDataPath, { recursive: true, force: true });
    ownedTestUserDataPath = null;
  }
});
