import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WORKER_ACTIVE_POLL_INTERVAL,
  WORKER_IDLE_POLL_INTERVAL,
  WORKER_QUIET_TICKS_BEFORE_IDLE,
} from '../../src/constants/timing.js';
import type { CoordinatedPaneCaptureRequest } from '../../src/services/PaneCaptureCoordinator.js';
import type {
  PaneStatusAnalysis,
  PaneStatusAnalyzer,
} from '../../src/services/PaneStatusAnalyzer.js';
import { PaneStatusManager } from '../../src/services/PaneStatusManager.js';
import { NO_INITIAL_PROMPT, type MuxBasePane } from '../../src/types.js';

const IDLE_FRAME = ['⏺ Done.', '│ > ', '  Opus 4.6 · 32% context left'].join('\n');
const WORKING_FRAME = '· Germinating… (esc to interrupt · 42s)';

function makePane(overrides: Partial<MuxBasePane> = {}): MuxBasePane {
  return {
    agent: 'claude',
    id: 'agent-pane',
    paneId: '%1',
    prompt: '',
    slug: 'agent-pane',
    type: 'worktree',
    ...overrides,
  };
}

function replaceCoordinator(
  manager: PaneStatusManager,
  request: ReturnType<typeof vi.fn>,
  stop: ReturnType<typeof vi.fn> = vi.fn(),
): void {
  Reflect.set(manager, 'captureCoordinator', {
    getStats: () => ({ batches: 0, captureRequests: 0, tmuxInvocations: 0 }),
    request,
    stop,
  });
}

function deliver(
  manager: PaneStatusManager,
  request: CoordinatedPaneCaptureRequest,
  content: string,
): void {
  Reflect.get(manager, 'deliverCapture').call(
    manager,
    request,
    { content, visibleFrame: content },
  );
}

describe('PaneStatusManager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates pane-local analyzers and removes them without a shutdown grace', () => {
    vi.useFakeTimers();
    const manager = new PaneStatusManager(vi.fn());

    manager.updateAnalyzers([makePane()]);
    expect(manager.getStats().analyzerCount).toBe(1);

    manager.updateAnalyzers([]);
    expect(manager.getStats().analyzerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enables one-shot input readiness from explicit launch metadata, independent of display prompt', () => {
    vi.useFakeTimers();
    const createAnalyzer = vi.fn(() => ({ analyzeCapture: vi.fn() }) as unknown as PaneStatusAnalyzer);
    const manager = new PaneStatusManager(vi.fn(), createAnalyzer);

    manager.updateAnalyzers([
      makePane({
        agent: 'pi',
        id: 'fresh-pi',
        paneId: '%1',
        prompt: 'display-only task name',
        startedWithoutInitialPrompt: true,
      }),
      makePane({
        agent: 'pi',
        id: 'prompted-pi',
        paneId: '%2',
        prompt: NO_INITIAL_PROMPT,
        startedWithoutInitialPrompt: false,
      }),
    ]);

    expect(createAnalyzer).toHaveBeenNthCalledWith(1, 'pi', true);
    expect(createAnalyzer).toHaveBeenNthCalledWith(2, 'pi', false);
  });

  it('keeps the display sentinel as a compatibility fallback for older fresh panes', () => {
    vi.useFakeTimers();
    const createAnalyzer = vi.fn(() => ({ analyzeCapture: vi.fn() }) as unknown as PaneStatusAnalyzer);
    const manager = new PaneStatusManager(vi.fn(), createAnalyzer);

    manager.updateAnalyzers([
      makePane({ agent: 'pi', prompt: NO_INITIAL_PROMPT }),
    ]);

    expect(createAnalyzer).toHaveBeenCalledWith('pi', true);
  });

  it('shuts down analyzers, scheduling, and capture delivery directly', () => {
    vi.useFakeTimers();
    const manager = new PaneStatusManager(vi.fn());
    const stopCoordinator = vi.fn();
    replaceCoordinator(manager, vi.fn(), stopCoordinator);
    manager.updateAnalyzers([makePane()]);

    manager.shutdown();
    manager.updateAnalyzers([makePane({ id: 'late-pane', paneId: '%2' })]);

    expect(manager.getStats().analyzerCount).toBe(0);
    expect(stopCoordinator).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('schedules every pane due on the same manager-owned cadence', () => {
    vi.useFakeTimers();
    const manager = new PaneStatusManager(vi.fn());
    const request = vi.fn();
    replaceCoordinator(manager, request);
    manager.updateAnalyzers([
      makePane(),
      makePane({ id: 'second-pane', paneId: '%2', slug: 'second-pane' }),
    ]);

    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);

    expect(request.mock.calls.map(([capture]) => capture)).toEqual([
      { generation: 1, paneId: 'agent-pane', tmuxPaneId: '%1' },
      { generation: 1, paneId: 'second-pane', tmuxPaneId: '%2' },
    ]);
  });

  it('requests a redraw-separated capture after a working marker disappears', () => {
    vi.useFakeTimers();
    const analyzer = {
      analyzeCapture: vi.fn(() => ({ active: false, requestIdleConfirmation: true })),
    } as unknown as PaneStatusAnalyzer;
    const manager = new PaneStatusManager(vi.fn(), () => analyzer);
    const request = vi.fn();
    replaceCoordinator(manager, request);
    manager.updateAnalyzers([makePane()]);
    const scheduler = Reflect.get(manager, 'captureScheduler') as { requestImmediate: (paneId: string) => boolean };
    const requestImmediate = vi.spyOn(scheduler, 'requestImmediate');

    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);
    const capture = request.mock.calls[0]?.[0] as CoordinatedPaneCaptureRequest;
    deliver(manager, capture, 'ready frame');
    vi.advanceTimersByTime(200);

    expect(requestImmediate).toHaveBeenCalledWith('agent-pane');
  });

  it('keeps quiet panes aligned on one idle cadence', () => {
    vi.useFakeTimers();
    const manager = new PaneStatusManager(vi.fn());
    const request = vi.fn();
    replaceCoordinator(manager, request);
    manager.updateAnalyzers([
      makePane(),
      makePane({ id: 'second-pane', paneId: '%2', slug: 'second-pane' }),
    ]);

    for (let tick = 0; tick < WORKER_QUIET_TICKS_BEFORE_IDLE; tick++) {
      vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);
      const current = request.mock.calls.slice(-2)
        .map(([capture]) => capture as CoordinatedPaneCaptureRequest);
      for (const capture of current) {
        Reflect.get(manager, 'captureScheduler').complete(
          capture.paneId,
          capture.generation,
          false,
        );
      }
    }

    expect(request).toHaveBeenCalledTimes(WORKER_QUIET_TICKS_BEFORE_IDLE * 2);
    vi.advanceTimersByTime(WORKER_IDLE_POLL_INTERVAL - WORKER_ACTIVE_POLL_INTERVAL);
    expect(request).toHaveBeenCalledTimes(WORKER_QUIET_TICKS_BEFORE_IDLE * 2);
    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);
    expect(request).toHaveBeenCalledTimes((WORKER_QUIET_TICKS_BEFORE_IDLE + 1) * 2);
  });

  it('keeps status and capture history independent across panes', () => {
    vi.useFakeTimers();
    const onStatusChange = vi.fn();
    const manager = new PaneStatusManager(onStatusChange);
    const request = vi.fn();
    replaceCoordinator(manager, request);
    manager.updateAnalyzers([
      makePane(),
      makePane({ id: 'second-pane', paneId: '%2', slug: 'second-pane' }),
    ]);
    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);
    const [first, second] = request.mock.calls.map(
      ([capture]) => capture as CoordinatedPaneCaptureRequest,
    );

    deliver(manager, first, WORKING_FRAME);
    deliver(manager, second, IDLE_FRAME);

    expect(onStatusChange).toHaveBeenCalledOnce();
    expect(onStatusChange).toHaveBeenNthCalledWith(1, 'agent-pane', {
      previousStatus: 'working',
      status: 'working',
    });
  });

  it('ignores mismatched tmux identity and stale scheduler generations', () => {
    vi.useFakeTimers();
    const analyzeCapture = vi.fn<() => PaneStatusAnalysis>(
      () => ({ active: true }),
    );
    const manager = new PaneStatusManager(
      vi.fn(),
      () => ({ analyzeCapture }) as PaneStatusAnalyzer,
    );
    const request = vi.fn();
    replaceCoordinator(manager, request);
    manager.updateAnalyzers([makePane()]);
    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);
    const current = request.mock.calls[0]?.[0] as CoordinatedPaneCaptureRequest;

    deliver(manager, { ...current, tmuxPaneId: '%stale' }, WORKING_FRAME);
    Reflect.get(manager, 'captureScheduler').complete(
      current.paneId,
      current.generation,
      true,
    );
    deliver(manager, current, WORKING_FRAME);

    expect(analyzeCapture).not.toHaveBeenCalled();
  });

  it('fails open for one analyzer without blocking the remaining capture delivery', () => {
    const onStatusChange = vi.fn();
    const failing = vi.fn((): PaneStatusAnalysis => {
      throw new Error('analysis failed');
    });
    const healthy = vi.fn((): PaneStatusAnalysis => ({
      active: false,
      statusChange: { previousStatus: 'idle', status: 'working' },
    }));
    let analyzerIndex = 0;
    const manager = new PaneStatusManager(
      onStatusChange,
      (() => {
        const analyzeCapture = analyzerIndex++ === 0 ? failing : healthy;
        return { analyzeCapture } as PaneStatusAnalyzer;
      }),
    );
    manager.updateAnalyzers([
      makePane(),
      makePane({ id: 'second-pane', paneId: '%2', slug: 'second-pane' }),
    ]);
    const complete = vi.fn();
    Reflect.set(manager, 'captureScheduler', {
      complete,
      isCurrentRequest: () => true,
      stop: vi.fn(),
    });

    deliver(
      manager,
      { generation: 1, paneId: 'agent-pane', tmuxPaneId: '%1' },
      WORKING_FRAME,
    );
    deliver(
      manager,
      { generation: 1, paneId: 'second-pane', tmuxPaneId: '%2' },
      WORKING_FRAME,
    );

    expect(complete).toHaveBeenNthCalledWith(1, 'agent-pane', 1, true);
    expect(complete).toHaveBeenNthCalledWith(2, 'second-pane', 1, false);
    expect(onStatusChange).toHaveBeenCalledOnce();
  });

  it('settles capture cadence before publishing a status change', () => {
    const onStatusChange = vi.fn();
    const manager = new PaneStatusManager(
      onStatusChange,
      () => ({
        analyzeCapture: () => ({
          active: false,
          statusChange: { previousStatus: 'working', status: 'idle' },
        }),
      }) as PaneStatusAnalyzer,
    );
    manager.updateAnalyzers([makePane()]);
    const complete = vi.fn();
    Reflect.set(manager, 'captureScheduler', {
      complete,
      isCurrentRequest: () => true,
      stop: vi.fn(),
    });

    deliver(
      manager,
      { generation: 37, paneId: 'agent-pane', tmuxPaneId: '%1' },
      IDLE_FRAME,
    );

    expect(complete).toHaveBeenCalledWith('agent-pane', 37, false);
    expect(complete.mock.invocationCallOrder[0])
      .toBeLessThan(onStatusChange.mock.invocationCallOrder[0]);
  });

  it('settles capture cadence exactly once when a status listener fails', () => {
    const manager = new PaneStatusManager(
      () => {
        throw new Error('listener failed');
      },
      () => ({
        analyzeCapture: () => ({
          active: false,
          statusChange: { previousStatus: 'working', status: 'idle' },
        }),
      }) as PaneStatusAnalyzer,
    );
    manager.updateAnalyzers([makePane()]);
    const complete = vi.fn();
    Reflect.set(manager, 'captureScheduler', {
      complete,
      isCurrentRequest: () => true,
      stop: vi.fn(),
    });

    deliver(
      manager,
      { generation: 41, paneId: 'agent-pane', tmuxPaneId: '%1' },
      IDLE_FRAME,
    );

    expect(complete).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith('agent-pane', 41, false);
  });

  it('does not notify when the analysis carries no status edge', () => {
    const onStatusChange = vi.fn();
    const manager = new PaneStatusManager(
      onStatusChange,
      () => ({ analyzeCapture: () => ({ active: true }) }) as PaneStatusAnalyzer,
    );
    manager.updateAnalyzers([makePane()]);
    Reflect.set(manager, 'captureScheduler', {
      complete: vi.fn(),
      isCurrentRequest: () => true,
      stop: vi.fn(),
    });

    deliver(manager, { generation: 1, paneId: 'agent-pane', tmuxPaneId: '%1' }, WORKING_FRAME);

    expect(onStatusChange).not.toHaveBeenCalled();
  });

});
