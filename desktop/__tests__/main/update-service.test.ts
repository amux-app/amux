import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UPDATE_FIRST_CHECK_MAX_MS,
  UPDATE_FIRST_CHECK_MIN_MS,
  UPDATE_FRESHNESS_MS,
  UPDATE_RETRY_DELAYS_MS,
  UpdateService,
  resolveUpdateDisabledReason,
  type UpdateClient,
  type UpdateClientEvent,
  type UpdateClientEventMap,
  type UpdateLogger,
} from '../../src/main/services/UpdateService';

class FakeUpdateClient implements UpdateClient {
  allowDowngrade = true;
  allowPrerelease = true;
  autoDownload = false;
  autoInstallOnAppQuit = false;
  channel: string | null = null;
  fullChangelog = true;
  checkCount = 0;
  installCount = 0;
  pendingCheck: Promise<unknown> | null = null;
  private listeners = new Map<UpdateClientEvent, Set<(payload: unknown) => void>>();

  checkForUpdates(): Promise<unknown> {
    this.checkCount += 1;
    return this.pendingCheck ?? Promise.resolve(null);
  }

  emit<Event extends UpdateClientEvent>(event: Event, payload: UpdateClientEventMap[Event]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }

  on<Event extends UpdateClientEvent>(
    event: Event,
    listener: (payload: UpdateClientEventMap[Event]) => void,
  ): () => void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener as (payload: unknown) => void);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener as (payload: unknown) => void);
  }

  quitAndInstall(): void {
    this.installCount += 1;
  }
}

function createLogger(): UpdateLogger {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createService(overrides: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) {
  const updater = overrides.updater ?? new FakeUpdateClient();
  const service = new UpdateService({
    currentVersion: '0.1.0',
    logger: createLogger(),
    random: () => 0.5,
    updater,
    ...overrides,
  });
  return { service, updater: updater as FakeUpdateClient };
}

async function moveToReady(service: UpdateService, updater: FakeUpdateClient): Promise<void> {
  let resolveCheck: (() => void) | undefined;
  updater.pendingCheck = new Promise<void>((resolve) => { resolveCheck = resolve; });
  service.start();
  const check = service.checkForUpdates(false);
  updater.emit('update-available', { version: '0.2.0' });
  resolveCheck?.();
  await check;
  updater.emit('update-downloaded', { version: '0.2.0' });
}

describe('resolveUpdateDisabledReason', () => {
  it('enables only packaged production macOS apps installed in an Applications folder', () => {
    expect(resolveUpdateDisabledReason({
      isDev: false,
      isInApplicationsFolder: true,
      isPackaged: true,
      platform: 'darwin',
    })).toBeUndefined();
    expect(resolveUpdateDisabledReason({
      isDev: true,
      isInApplicationsFolder: true,
      isPackaged: true,
      platform: 'darwin',
    })).toBe('development');
    expect(resolveUpdateDisabledReason({
      isDev: false,
      isInApplicationsFolder: false,
      isPackaged: true,
      platform: 'darwin',
    })).toBe('not-in-applications');
    expect(resolveUpdateDisabledReason({
      isDev: false,
      isInApplicationsFolder: true,
      isPackaged: true,
      platform: 'linux',
    })).toBe('policy');
  });

  it('honors the explicit update policy disable flag', () => {
    expect(resolveUpdateDisabledReason({
      isDev: false,
      isInApplicationsFolder: true,
      isPackaged: true,
      platform: 'darwin',
      updateChecksDisabled: 'yes',
    })).toBe('policy');
  });
});

describe('UpdateService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('configures stable updater policy and schedules the first check after renderer readiness', async () => {
    const { service, updater } = createService();

    expect(service.start()).toBe(true);
    expect(updater.checkCount).toBe(0);
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.fullChangelog).toBe(false);
    expect(updater.channel).toBeNull();

    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_CHECK_MIN_MS - 1);
    expect(updater.checkCount).toBe(0);
    await vi.advanceTimersByTimeAsync(
      UPDATE_FIRST_CHECK_MAX_MS - UPDATE_FIRST_CHECK_MIN_MS + 1,
    );
    expect(updater.checkCount).toBe(1);
  });

  it('isolates explicit beta builds from stable releases and accepts newer beta versions', async () => {
    const updater = new FakeUpdateClient();
    let resolveCheck: (() => void) | undefined;
    updater.pendingCheck = new Promise<void>((resolve) => { resolveCheck = resolve; });
    const { service } = createService({ currentVersion: '0.1.0-beta.1', updater });
    service.start();

    expect(updater.channel).toBe('beta');
    expect(updater.allowPrerelease).toBe(true);
    expect(updater.allowDowngrade).toBe(false);

    const check = service.checkForUpdates(false);
    updater.emit('update-available', { version: '0.1.0' });
    expect(service.getSnapshot().phase).toBe('checking');
    updater.emit('update-available', { version: '0.1.0-beta.2' });
    expect(service.getSnapshot()).toMatchObject({
      availableVersion: '0.1.0-beta.2',
      phase: 'available',
    });
    resolveCheck?.();
    await check;
  });

  it('never registers listeners or invokes the updater while disabled', async () => {
    const { service, updater } = createService({ disabledReason: 'not-in-applications' });

    expect(service.start()).toBe(false);
    await service.checkForUpdates(true);

    expect(service.getSnapshot()).toMatchObject({
      disabledReason: 'not-in-applications',
      phase: 'disabled',
    });
    expect(updater.checkCount).toBe(0);
    expect(updater.listenerCount()).toBe(0);
  });

  it('coalesces repeated manual checks and publishes revision-ordered state', async () => {
    const updater = new FakeUpdateClient();
    let resolveCheck: (() => void) | undefined;
    updater.pendingCheck = new Promise<void>((resolve) => { resolveCheck = resolve; });
    const { service } = createService({ updater });
    service.start();

    const revisions: number[] = [];
    service.subscribe((snapshot) => revisions.push(snapshot.revision));
    const first = service.checkForUpdates(true);
    const second = service.checkForUpdates(true);

    expect(updater.checkCount).toBe(1);
    expect(service.getSnapshot()).toMatchObject({ manualCheck: true, phase: 'checking' });
    resolveCheck?.();
    updater.emit('update-not-available', { version: '0.1.0' });
    await Promise.all([first, second]);

    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
    expect(service.getSnapshot()).toMatchObject({
      checkedAt: '2026-08-07T12:00:00.000Z',
      phase: 'idle',
    });
  });

  it('ignores prerelease, downgrade, and stale progress events', async () => {
    const updater = new FakeUpdateClient();
    let resolveCheck: (() => void) | undefined;
    updater.pendingCheck = new Promise<void>((resolve) => { resolveCheck = resolve; });
    const { service } = createService({ updater });
    service.start();
    const check = service.checkForUpdates(true);

    updater.emit('update-available', { version: '0.2.0-beta.1' });
    expect(service.getSnapshot().phase).toBe('checking');
    updater.emit('update-available', { version: '0.0.9' });
    expect(service.getSnapshot().phase).toBe('checking');
    updater.emit('download-progress', {
      bytesPerSecond: 5,
      percent: 50,
      total: 10,
      transferred: 5,
    });
    expect(service.getSnapshot().phase).toBe('checking');
    resolveCheck?.();
    await check;
  });

  it('normalizes download progress and reaches ready for a valid newer version', async () => {
    const updater = new FakeUpdateClient();
    let resolveCheck: (() => void) | undefined;
    updater.pendingCheck = new Promise<void>((resolve) => { resolveCheck = resolve; });
    const { service } = createService({ updater });
    service.start();
    const check = service.checkForUpdates(false);

    updater.emit('update-available', { version: '0.2.0' });
    resolveCheck?.();
    await check;
    updater.emit('download-progress', {
      bytesPerSecond: Number.NaN,
      percent: 120,
      total: 100,
      transferred: 140,
    });
    expect(service.getSnapshot()).toMatchObject({
      availableVersion: '0.2.0',
      phase: 'downloading',
      progress: { bytesPerSecond: 0, percent: 100, total: 100, transferred: 100 },
    });

    updater.emit('update-downloaded', { version: '0.2.0' });
    expect(service.getSnapshot()).toMatchObject({
      availableVersion: '0.2.0',
      phase: 'ready',
      releaseNotesUrl: 'https://github.com/amux-app/amux/releases/tag/v0.2.0',
    });
  });

  it('retries transient background failures with bounded tiered backoff', async () => {
    const updater = new FakeUpdateClient();
    updater.pendingCheck = Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED'));
    const { service } = createService({ updater });
    service.start();

    await service.checkForUpdates(false);
    expect(service.getSnapshot()).toMatchObject({
      error: { kind: 'network', retryable: true },
      manualCheck: false,
      phase: 'error',
    });
    await vi.advanceTimersByTimeAsync(UPDATE_RETRY_DELAYS_MS[0]);
    expect(updater.checkCount).toBe(2);
  });

  it('preserves event-driven retry backoff when the updater promise resolves afterward', async () => {
    const updater = new FakeUpdateClient();
    let resolveCheck: (() => void) | undefined;
    updater.pendingCheck = new Promise<void>((resolve) => { resolveCheck = resolve; });
    const { service } = createService({ updater });
    service.start();

    const check = service.checkForUpdates(false);
    updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
    resolveCheck?.();
    await check;

    await vi.advanceTimersByTimeAsync(UPDATE_RETRY_DELAYS_MS[0]);
    expect(updater.checkCount).toBe(2);
  });

  it('marks updater-initiated quits defensively', () => {
    const beforeQuitAndInstall = vi.fn();
    const { service, updater } = createService({ beforeQuitAndInstall });
    service.start();

    updater.emit('before-quit-for-update', undefined);

    expect(beforeQuitAndInstall).toHaveBeenCalledOnce();
  });

  it('checks after focus or resume only when the last attempt is stale', async () => {
    const { service, updater } = createService();
    service.start();
    await service.checkForUpdates(false);
    expect(updater.checkCount).toBe(1);

    await service.checkIfStale();
    expect(updater.checkCount).toBe(1);
    vi.setSystemTime(Date.now() + UPDATE_FRESHNESS_MS + 1);
    await service.checkIfStale();
    expect(updater.checkCount).toBe(2);
  });

  it('installs through the guarded preparation path exactly once', async () => {
    const beforeQuitAndInstall = vi.fn();
    let finishPreparation: ((allowed: boolean) => void) | undefined;
    const prepareInstall = vi.fn(() => new Promise<boolean>((resolve) => {
      finishPreparation = resolve;
    }));
    const updater = new FakeUpdateClient();
    const { service } = createService({ beforeQuitAndInstall, prepareInstall, updater });
    await moveToReady(service, updater);

    const first = service.installUpdate();
    const second = service.installUpdate();
    expect(service.getSnapshot().phase).toBe('installing');
    finishPreparation?.(true);
    await Promise.all([first, second]);

    expect(prepareInstall).toHaveBeenCalledTimes(1);
    expect(beforeQuitAndInstall).toHaveBeenCalledOnce();
    expect(updater.installCount).toBe(1);
  });

  it('returns to ready when guarded preparation is cancelled', async () => {
    const updater = new FakeUpdateClient();
    const { service } = createService({
      prepareInstall: () => Promise.resolve(false),
      updater,
    });
    await moveToReady(service, updater);

    expect(await service.installUpdate()).toBe(false);
    expect(service.getSnapshot()).toMatchObject({ availableVersion: '0.2.0', phase: 'ready' });
    expect(updater.installCount).toBe(0);
  });

  it('returns to ready when guarded preparation rejects', async () => {
    const updater = new FakeUpdateClient();
    const { service } = createService({
      prepareInstall: () => Promise.reject(new Error('renderer flush failed')),
      updater,
    });
    await moveToReady(service, updater);

    expect(await service.installUpdate()).toBe(false);
    expect(service.getSnapshot()).toMatchObject({ availableVersion: '0.2.0', phase: 'ready' });
    expect(updater.installCount).toBe(0);
  });

  it('clears timers and detaches all updater listeners on stop', () => {
    const unsubscribeWakeEvents = vi.fn();
    const { updater } = createService();
    const wakeAware = new UpdateService({
      currentVersion: '0.1.0',
      logger: createLogger(),
      random: () => 0.5,
      subscribeToWakeEvents: () => unsubscribeWakeEvents,
      updater,
    });
    wakeAware.start();
    expect(updater.listenerCount()).toBeGreaterThan(0);

    wakeAware.stop();

    expect(updater.listenerCount()).toBe(0);
    expect(unsubscribeWakeEvents).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
