import electronUpdater from 'electron-updater';
import type { AppUpdateDisabledReason } from '../../shared/app-update-types.js';
import { log } from './Logger.js';
import {
  resolveUpdateDisabledReason,
  UpdateService,
  type UpdateClient,
  type UpdateClientEvent,
  type UpdateClientEventMap,
  type UpdateLogger,
} from './UpdateService.js';

const UPDATE_LOG_TAG = 'updates';

export interface ElectronUpdaterLike {
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  channel: string | null;
  fullChangelog: boolean;
  checkForUpdates(): Promise<unknown>;
  on(event: string, listener: (payload: unknown) => void): unknown;
  quitAndInstall(): void;
  removeListener(event: string, listener: (payload: unknown) => void): unknown;
}

export interface ElectronUpdateServiceOptions {
  beforeQuitAndInstall?: () => void;
  currentVersion: string;
  isDev: boolean;
  isInApplicationsFolder: boolean;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  prepareInstall?: () => Promise<boolean>;
  subscribeToWakeEvents?: (listener: () => void) => () => void;
  updateChecksDisabled?: string;
  updater?: ElectronUpdaterLike;
}

export function createElectronUpdateService(options: ElectronUpdateServiceOptions): UpdateService {
  const disabledReason = resolveUpdateDisabledReason(options);
  const service = new UpdateService({
    beforeQuitAndInstall: options.beforeQuitAndInstall,
    currentVersion: options.currentVersion,
    disabledReason,
    logger: createUpdateLogger(),
    prepareInstall: options.prepareInstall,
    subscribeToWakeEvents: options.subscribeToWakeEvents,
    updater: createElectronUpdateClient(options.updater ?? getAutoUpdater()),
  });

  logUpdateAvailability(disabledReason, options.currentVersion);
  return service;
}

export function createElectronUpdateClient(updater: ElectronUpdaterLike): UpdateClient {
  return {
    get allowDowngrade() {
      return updater.allowDowngrade;
    },
    set allowDowngrade(value: boolean) {
      updater.allowDowngrade = value;
    },
    get allowPrerelease() {
      return updater.allowPrerelease;
    },
    set allowPrerelease(value: boolean) {
      updater.allowPrerelease = value;
    },
    get autoDownload() {
      return updater.autoDownload;
    },
    set autoDownload(value: boolean) {
      updater.autoDownload = value;
    },
    get autoInstallOnAppQuit() {
      return updater.autoInstallOnAppQuit;
    },
    set autoInstallOnAppQuit(value: boolean) {
      updater.autoInstallOnAppQuit = value;
    },
    get channel() {
      return updater.channel;
    },
    set channel(value: string | null) {
      updater.channel = value;
    },
    get fullChangelog() {
      return updater.fullChangelog;
    },
    set fullChangelog(value: boolean) {
      updater.fullChangelog = value;
    },
    checkForUpdates: () => updater.checkForUpdates(),
    on: <Event extends UpdateClientEvent>(
      event: Event,
      listener: (payload: UpdateClientEventMap[Event]) => void,
    ) => {
      const wrapped = (payload: unknown): void => {
        listener(payload as UpdateClientEventMap[Event]);
      };
      updater.on(event, wrapped);
      return () => {
        updater.removeListener(event, wrapped);
      };
    },
    quitAndInstall: () => updater.quitAndInstall(),
  };
}

function createUpdateLogger(): UpdateLogger {
  return {
    debug: (message, data) => log.debug(UPDATE_LOG_TAG, message, data),
    error: (message, data) => log.error(UPDATE_LOG_TAG, message, data),
    info: (message, data) => log.info(UPDATE_LOG_TAG, message, data),
    warn: (message, data) => log.warn(UPDATE_LOG_TAG, message, data),
  };
}

function logUpdateAvailability(
  disabledReason: AppUpdateDisabledReason | undefined,
  currentVersion: string,
): void {
  if (disabledReason) {
    log.info(UPDATE_LOG_TAG, 'Automatic updates disabled', { reason: disabledReason });
  } else {
    const channel = /-beta(?:\.|$)/.test(currentVersion) ? 'beta' : 'stable';
    log.info(UPDATE_LOG_TAG, 'Automatic updates enabled', { channel });
  }
}

function getAutoUpdater(): ElectronUpdaterLike {
  const { autoUpdater } = electronUpdater;
  // electron-updater ships CommonJS types that don't structurally match our ElectronUpdaterLike facade.
  return autoUpdater as unknown as ElectronUpdaterLike;
}
