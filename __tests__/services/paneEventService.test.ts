import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsyncMock = vi.hoisted(() => vi.fn());
const hookManagerMock = vi.hoisted(() => ({
  areHooksInstalled: vi.fn(),
  cleanup: vi.fn(),
  initialize: vi.fn(),
  installHooks: vi.fn(),
  isActive: vi.fn(),
  onHookTriggered: vi.fn(),
  uninstallHooks: vi.fn(),
}));
const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../src/services/TmuxHookManager.js', () => ({
  TmuxHookManager: {
    getInstance: () => hookManagerMock,
  },
}));

vi.mock('../../src/services/LogService.js', () => ({
  LogService: {
    getInstance: () => loggerMock,
  },
}));

vi.mock('../../src/utils/execAsync.js', () => ({
  execFileAsync: execFileAsyncMock,
}));

import { PaneEventService } from '../../src/services/PaneEventService';
import type { PaneChangeEvent } from '../../src/services/PaneEventService';

function resetSingleton(): PaneEventService {
  Reflect.set(PaneEventService, 'instance', undefined);
  return PaneEventService.getInstance();
}

async function startPolling(service: PaneEventService, sessionName = 'aumx-project'): Promise<void> {
  await service.initialize({ sessionName, pollInterval: 5_000 });
  await service.start(false);
}

async function runScheduledPoll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
}

describe('PaneEventService polling', () => {
  let service: PaneEventService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    service = resetSingleton();
  });

  afterEach(async () => {
    await service.cleanup();
    vi.useRealTimers();
  });

  it('contains no worker-thread polling path', () => {
    const source = readFileSync(
      new URL('../../src/services/PaneEventService.ts', import.meta.url),
      'utf8',
    );

    expect(source).not.toContain('worker_threads');
    expect(source).not.toContain('panePollingWorker');
  });

  it('emits added and removed panes after the initial snapshot', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce('%1\n%2')
      .mockResolvedValueOnce('%2\n%3');
    const events: PaneChangeEvent[] = [];
    service.onPanesChanged((event) => events.push(event));

    await startPolling(service);
    await runScheduledPoll();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(events).toEqual([expect.objectContaining({
      added: ['%3'],
      paneIds: ['%2', '%3'],
      removed: ['%1'],
      source: 'polling',
    })]);
  });

  it('never overlaps polls when tmux is slow', async () => {
    let release: (value: string) => void = () => {};
    execFileAsyncMock.mockImplementationOnce(() => new Promise<string>((resolve) => {
      release = resolve;
    }));

    await startPolling(service);
    await runScheduledPoll();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(execFileAsyncMock).toHaveBeenCalledTimes(1);

    release('%1');
    await Promise.resolve();
    await Promise.resolve();
    execFileAsyncMock.mockResolvedValueOnce('%1');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(execFileAsyncMock).toHaveBeenCalledTimes(2);
  });

  it('prevents a late old-project poll from emitting or scheduling', async () => {
    let release: (value: string) => void = () => {};
    execFileAsyncMock.mockImplementationOnce(() => new Promise<string>((resolve) => {
      release = resolve;
    }));
    const events: PaneChangeEvent[] = [];
    service.onPanesChanged((event) => events.push(event));
    await startPolling(service, 'old-project');
    await runScheduledPoll();

    let stopped = false;
    const stopping = service.stop();
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    const stoppedBeforeRelease = stopped;

    execFileAsyncMock.mockResolvedValue('%new');
    if (stoppedBeforeRelease) {
      await startPolling(service, 'new-project');
      await runScheduledPoll();
    }
    const callCountBeforeRelease = execFileAsyncMock.mock.calls.length;

    release('%old');
    await stopping;
    expect(stoppedBeforeRelease).toBe(true);
    expect(callCountBeforeRelease).toBe(2);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(events).toEqual([]);
    expect(execFileAsyncMock.mock.calls.every(([, args]) =>
      (args as string[]).includes('old-project:')
      || (args as string[]).includes('new-project:'))).toBe(true);
  });

  it('forces one immediate polling event without overlap', async () => {
    execFileAsyncMock.mockResolvedValue('%1');
    const events: PaneChangeEvent[] = [];
    service.onPanesChanged((event) => events.push(event));
    await startPolling(service);
    await runScheduledPoll();

    service.forceCheck();
    await runScheduledPoll();

    expect(events).toEqual([expect.objectContaining({
      added: [],
      paneIds: ['%1'],
      removed: [],
      source: 'polling',
    })]);
  });

  it('isolates a polling error and continues on the next cadence', async () => {
    execFileAsyncMock
      .mockRejectedValueOnce(new Error('tmux unavailable'))
      .mockResolvedValueOnce('%1')
      .mockResolvedValueOnce('%1\n%2');
    const events: PaneChangeEvent[] = [];
    service.onPanesChanged((event) => events.push(event));

    await startPolling(service);
    await runScheduledPoll();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(loggerMock.debug).toHaveBeenCalledWith(
      expect.stringContaining('tmux unavailable'),
      'paneEvents',
    );
    expect(events).toEqual([expect.objectContaining({ added: ['%2'] })]);
  });

  it('uses an updated interval for subsequent polls', async () => {
    execFileAsyncMock.mockResolvedValue('%1');
    await startPolling(service);
    await runScheduledPoll();

    service.setPollingInterval(1_000);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(execFileAsyncMock).toHaveBeenCalledTimes(3);
  });
});
