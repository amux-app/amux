import type {
  AppUpdateDisabledReason,
  AppUpdateError,
  AppUpdateSnapshot,
} from '../../shared/app-update-types.js';
import {
  appUpdateSnapshotSchema,
  buildCanonicalReleaseNotesUrl,
  createInitialUpdateSnapshot,
  normalizeUpdateProgress,
} from '../../shared/app-update-types.js';

export const UPDATE_FIRST_CHECK_MIN_MS = 10_000;
export const UPDATE_FIRST_CHECK_MAX_MS = 30_000;
const UPDATE_CHECK_INTERVAL_MS = 30 * 60_000;
export const UPDATE_FRESHNESS_MS = 10 * 60_000;
export const UPDATE_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000, 2 * 60 * 60_000] as const;

const CHECK_INTERVAL_JITTER = 0.2;
const RETRY_JITTER = 0.2;
const DISABLE_UPDATE_VALUES = new Set(['1', 'true', 'yes']);

export interface UpdateInfoLike {
  version: string;
}

export interface UpdateProgressLike {
  bytesPerSecond?: number;
  percent?: number;
  total?: number;
  transferred?: number;
}

export interface UpdateClientEventMap {
  'before-quit-for-update': undefined;
  'checking-for-update': undefined;
  'download-progress': UpdateProgressLike;
  error: unknown;
  'update-available': UpdateInfoLike;
  'update-downloaded': UpdateInfoLike;
  'update-not-available': UpdateInfoLike;
}

export type UpdateClientEvent = keyof UpdateClientEventMap;

export interface UpdateClient {
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  channel: string | null;
  fullChangelog: boolean;
  checkForUpdates(): Promise<unknown>;
  on<Event extends UpdateClientEvent>(
    event: Event,
    listener: (payload: UpdateClientEventMap[Event]) => void,
  ): () => void;
  quitAndInstall(): void;
}

export interface UpdateLogger {
  debug(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
}

export interface UpdateRuntimeOptions {
  isDev: boolean;
  isInApplicationsFolder: boolean;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  updateChecksDisabled?: string;
}

type UpdateTimer = ReturnType<typeof setTimeout>;

export interface UpdateServiceOptions {
  beforeQuitAndInstall?: () => void;
  clearTimeoutFn?: (timer: UpdateTimer) => void;
  currentVersion: string;
  disabledReason?: AppUpdateDisabledReason;
  logger: UpdateLogger;
  now?: () => number;
  prepareInstall?: () => Promise<boolean>;
  random?: () => number;
  setTimeoutFn?: (handler: () => void, timeoutMs: number) => UpdateTimer;
  subscribeToWakeEvents?: (listener: () => void) => () => void;
  updater: UpdateClient;
}

type SnapshotListener = (snapshot: AppUpdateSnapshot) => void;

export function resolveUpdateDisabledReason(
  options: UpdateRuntimeOptions,
): AppUpdateDisabledReason | undefined {
  if (options.isDev || !options.isPackaged) return 'development';
  if (DISABLE_UPDATE_VALUES.has(options.updateChecksDisabled?.trim().toLowerCase() ?? '')) {
    return 'policy';
  }
  if (options.platform !== 'darwin') return 'policy';
  if (!options.isInApplicationsFolder) return 'not-in-applications';
  return undefined;
}

export class UpdateService {
  private readonly beforeQuitAndInstall: () => void;
  private readonly clearTimeoutFn: (timer: UpdateTimer) => void;
  private readonly disabledReason?: AppUpdateDisabledReason;
  private readonly logger: UpdateLogger;
  private readonly now: () => number;
  private readonly prepareInstall: () => Promise<boolean>;
  private readonly random: () => number;
  private readonly setTimeoutFn: (handler: () => void, timeoutMs: number) => UpdateTimer;
  private readonly subscribeToWakeEvents?: (listener: () => void) => () => void;
  private readonly updater: UpdateClient;
  private readonly subscribers = new Set<SnapshotListener>();
  private readonly unsubscribeUpdater: Array<() => void> = [];
  private checkPromise: Promise<AppUpdateSnapshot> | null = null;
  private installPromise: Promise<boolean> | null = null;
  private lastAttemptAt: number | null = null;
  private retryAttempt = 0;
  private snapshot: AppUpdateSnapshot;
  private started = false;
  private timer: UpdateTimer | null = null;
  private unsubscribeWakeEvents: (() => void) | null = null;

  constructor(options: UpdateServiceOptions) {
    this.beforeQuitAndInstall = options.beforeQuitAndInstall ?? (() => {});
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.disabledReason = options.disabledReason;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.prepareInstall = options.prepareInstall ?? (() => Promise.resolve(false));
    this.random = options.random ?? Math.random;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.subscribeToWakeEvents = options.subscribeToWakeEvents;
    this.updater = options.updater;
    this.snapshot = createInitialUpdateSnapshot(options.currentVersion, options.disabledReason);
  }

  start(): boolean {
    if (this.disabledReason) {
      this.logger.info('Automatic updates unavailable', { reason: this.disabledReason });
      return false;
    }
    if (this.started) return false;

    this.started = true;
    this.configureUpdater();
    this.registerUpdaterListeners();
    this.unsubscribeWakeEvents = this.subscribeToWakeEvents?.(() => {
      void this.checkIfStale();
    }) ?? null;
    this.schedule(this.randomBetween(UPDATE_FIRST_CHECK_MIN_MS, UPDATE_FIRST_CHECK_MAX_MS));
    return true;
  }

  stop(): void {
    this.clearScheduledCheck();
    for (const unsubscribe of this.unsubscribeUpdater.splice(0)) unsubscribe();
    this.unsubscribeWakeEvents?.();
    this.unsubscribeWakeEvents = null;
    this.started = false;
    this.subscribers.clear();
  }

  getSnapshot(): AppUpdateSnapshot {
    return structuredClone(this.snapshot);
  }

  subscribe(listener: SnapshotListener): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  checkIfStale(): Promise<AppUpdateSnapshot> {
    if (this.lastAttemptAt !== null && this.now() - this.lastAttemptAt < UPDATE_FRESHNESS_MS) {
      return Promise.resolve(this.getSnapshot());
    }
    return this.checkForUpdates(false);
  }

  checkForUpdates(manualCheck = false): Promise<AppUpdateSnapshot> {
    if (this.disabledReason || !this.started) return Promise.resolve(this.getSnapshot());
    if (this.checkPromise) {
      if (manualCheck && this.snapshot.phase === 'checking' && !this.snapshot.manualCheck) {
        this.publish({
          checkedAt: this.snapshot.checkedAt,
          currentVersion: this.snapshot.currentVersion,
          manualCheck: true,
          phase: 'checking',
          revision: this.snapshot.revision + 1,
        });
      }
      return this.checkPromise;
    }
    if (['available', 'downloading', 'ready', 'installing'].includes(this.snapshot.phase)) {
      return Promise.resolve(this.getSnapshot());
    }

    this.clearScheduledCheck();
    this.lastAttemptAt = this.now();
    this.publish({
      checkedAt: this.snapshot.checkedAt,
      currentVersion: this.snapshot.currentVersion,
      manualCheck,
      phase: 'checking',
      revision: this.snapshot.revision + 1,
    });

    const operation = this.updater.checkForUpdates()
      .then(() => {
        if (this.snapshot.phase === 'checking') this.publishIdle();
        if (this.snapshot.phase === 'error') return this.getSnapshot();
        this.retryAttempt = 0;
        this.scheduleRegularCheck();
        return this.getSnapshot();
      })
      .catch((error: unknown) => {
        if (this.snapshot.phase !== 'error') this.publishError(error, manualCheck);
        return this.getSnapshot();
      });
    const tracked = operation.finally(() => {
      if (this.checkPromise === tracked) this.checkPromise = null;
    });
    this.checkPromise = tracked;
    return tracked;
  }

  installUpdate(): Promise<boolean> {
    if (this.installPromise) return this.installPromise;
    if (this.snapshot.phase !== 'ready') return Promise.resolve(false);

    const availableVersion = this.snapshot.availableVersion;
    this.publishAvailablePhase('installing', availableVersion);
    const operation = this.prepareInstall()
      .then((prepared) => {
        if (!prepared) {
          this.publishAvailablePhase('ready', availableVersion);
          return false;
        }
        this.beforeQuitAndInstall();
        this.updater.quitAndInstall();
        this.logger.info('Restarting to install update', { version: availableVersion });
        return true;
      })
      .catch((_error: unknown) => {
        this.logger.error('Update restart preparation failed', { kind: 'install' });
        this.publishAvailablePhase('ready', availableVersion);
        return false;
      });
    const tracked = operation.finally(() => {
      if (this.installPromise === tracked) this.installPromise = null;
    });
    this.installPromise = tracked;
    return tracked;
  }

  private configureUpdater(): void {
    const betaChannel = isBetaVersion(this.snapshot.currentVersion);
    if (betaChannel) this.updater.channel = 'beta';
    this.updater.allowPrerelease = betaChannel;
    // Setting electron-updater's channel enables downgrades as a side effect,
    // so enforce the no-downgrade policy after selecting the beta channel.
    this.updater.allowDowngrade = false;
    this.updater.autoDownload = true;
    this.updater.autoInstallOnAppQuit = true;
    this.updater.fullChangelog = false;
  }

  private registerUpdaterListeners(): void {
    this.unsubscribeUpdater.push(
      this.updater.on('before-quit-for-update', () => {
        this.beforeQuitAndInstall();
      }),
      this.updater.on('checking-for-update', () => {
        if (this.snapshot.phase === 'checking') this.logger.debug('Checking for updates');
      }),
      this.updater.on('update-available', (info) => this.handleUpdateAvailable(info)),
      this.updater.on('update-not-available', () => {
        if (this.snapshot.phase !== 'checking') return this.logIgnoredEvent('update-not-available');
        this.retryAttempt = 0;
        this.publishIdle();
      }),
      this.updater.on('download-progress', (progress) => this.handleDownloadProgress(progress)),
      this.updater.on('update-downloaded', (info) => this.handleUpdateDownloaded(info)),
      this.updater.on('error', (error) => {
        if (!['checking', 'available', 'downloading'].includes(this.snapshot.phase)) {
          this.logIgnoredEvent('error');
          return;
        }
        this.publishError(error, this.snapshot.phase === 'checking' && !!this.snapshot.manualCheck);
      }),
    );
  }

  private handleUpdateAvailable(info: UpdateInfoLike): void {
    if (this.snapshot.phase !== 'checking' || !isEligibleUpdate(
      this.snapshot.currentVersion,
      info.version,
    )) {
      this.logIgnoredEvent('update-available', { version: sanitizeVersion(info.version) });
      return;
    }
    this.retryAttempt = 0;
    this.publishAvailablePhase('available', info.version);
    this.logger.info('Update available', { version: info.version });
  }

  private handleDownloadProgress(progress: UpdateProgressLike): void {
    const snapshot = this.snapshot;
    if (snapshot.phase !== 'available' && snapshot.phase !== 'downloading') {
      this.logIgnoredEvent('download-progress');
      return;
    }
    const availableVersion = snapshot.availableVersion;
    this.publish({
      availableVersion,
      checkedAt: this.snapshot.checkedAt,
      currentVersion: this.snapshot.currentVersion,
      phase: 'downloading',
      progress: normalizeUpdateProgress(progress),
      releaseNotesUrl: snapshot.releaseNotesUrl,
      revision: this.snapshot.revision + 1,
    });
  }

  private handleUpdateDownloaded(info: UpdateInfoLike): void {
    const snapshot = this.snapshot;
    if (
      (snapshot.phase !== 'available' && snapshot.phase !== 'downloading')
      || snapshot.availableVersion !== info.version
    ) {
      this.logIgnoredEvent('update-downloaded', { version: sanitizeVersion(info.version) });
      return;
    }
    this.publishAvailablePhase('ready', info.version);
    this.logger.info('Update ready to install', { version: info.version });
  }

  private publishIdle(): void {
    this.publish({
      checkedAt: new Date(this.now()).toISOString(),
      currentVersion: this.snapshot.currentVersion,
      phase: 'idle',
      revision: this.snapshot.revision + 1,
    });
  }

  private publishAvailablePhase(
    phase: 'available' | 'ready' | 'installing',
    availableVersion: string,
  ): void {
    this.publish({
      availableVersion,
      checkedAt: this.snapshot.checkedAt,
      currentVersion: this.snapshot.currentVersion,
      phase,
      releaseNotesUrl: buildCanonicalReleaseNotesUrl(availableVersion) ?? undefined,
      revision: this.snapshot.revision + 1,
    });
  }

  private publishError(error: unknown, manualCheck: boolean): void {
    const sanitized = classifyUpdateError(error, this.snapshot.phase);
    this.publish({
      checkedAt: this.snapshot.checkedAt,
      currentVersion: this.snapshot.currentVersion,
      error: sanitized,
      manualCheck,
      phase: 'error',
      revision: this.snapshot.revision + 1,
    });
    this.logger.warn('Update operation failed', sanitized);
    if (sanitized.retryable) this.scheduleRetry();
  }

  private publish(snapshot: AppUpdateSnapshot): void {
    const parsed = appUpdateSnapshotSchema.parse(snapshot);
    if (parsed.revision <= this.snapshot.revision) {
      this.logIgnoredEvent('state', { revision: parsed.revision });
      return;
    }
    this.snapshot = parsed;
    for (const listener of this.subscribers) {
      try {
        listener(this.getSnapshot());
      } catch {
        this.logger.warn('Update state subscriber failed');
      }
    }
  }

  private scheduleRegularCheck(): void {
    if (!this.started || this.snapshot.phase === 'ready' || this.snapshot.phase === 'installing') return;
    this.schedule(this.jitter(UPDATE_CHECK_INTERVAL_MS, CHECK_INTERVAL_JITTER));
  }

  private scheduleRetry(): void {
    const index = Math.min(this.retryAttempt, UPDATE_RETRY_DELAYS_MS.length - 1);
    const delay = UPDATE_RETRY_DELAYS_MS[index];
    this.retryAttempt += 1;
    this.schedule(this.jitter(delay, RETRY_JITTER));
  }

  private schedule(delayMs: number): void {
    this.clearScheduledCheck();
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      void this.checkForUpdates(false);
    }, Math.max(0, Math.round(delayMs)));
  }

  private clearScheduledCheck(): void {
    if (this.timer === null) return;
    this.clearTimeoutFn(this.timer);
    this.timer = null;
  }

  private jitter(baseMs: number, ratio: number): number {
    return baseMs * (1 - ratio + 2 * ratio * this.random());
  }

  private randomBetween(min: number, max: number): number {
    return min + (max - min) * this.random();
  }

  private logIgnoredEvent(event: string, data?: unknown): void {
    this.logger.debug('Ignored stale or invalid updater event', { event, phase: this.snapshot.phase, ...asRecord(data) });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function sanitizeVersion(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 64 ? value : undefined;
}

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

function parseVersion(version: string): ParsedVersion | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split('.') ?? [],
  };
}

function isBetaVersion(version: string): boolean {
  return parseVersion(version)?.prerelease[0] === 'beta';
}

function isEligibleUpdate(currentVersion: string, availableVersion: string): boolean {
  const current = parseVersion(currentVersion);
  const available = parseVersion(availableVersion);
  if (!current || !available) return false;

  const currentIsBeta = current.prerelease[0] === 'beta';
  const availableIsBeta = available.prerelease[0] === 'beta';
  if (currentIsBeta !== availableIsBeta) return false;
  if (!currentIsBeta && (current.prerelease.length > 0 || available.prerelease.length > 0)) {
    return false;
  }
  return compareVersions(available, current) > 0;
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return 1;
    if (rightPart === undefined) return -1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function classifyUpdateError(error: unknown, phase: AppUpdateSnapshot['phase']): AppUpdateError {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (/err_|econn|enotfound|network|offline|internet|timed?\s*out/.test(message)) {
    return { kind: 'network', retryable: true };
  }
  if (phase === 'available' || phase === 'downloading') {
    return { kind: 'download', retryable: true };
  }
  if (/404|feed|latest-mac|sha512|yaml/.test(message)) {
    return { kind: 'feed', retryable: true };
  }
  return { kind: 'unknown', retryable: true };
}
