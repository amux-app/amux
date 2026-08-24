import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WORKER_ACTIVE_POLL_INTERVAL,
  WORKER_IDLE_POLL_INTERVAL,
  WORKER_QUIET_TICKS_BEFORE_IDLE,
} from '../../src/constants/timing.js';
import {
  PaneStatusScheduler,
  STALE_PENDING_TICKS,
} from '../../src/services/PaneStatusScheduler.js';

function pane(paneId: string, tmuxPaneId: string) {
  return { paneId, tmuxPaneId };
}

function request(paneId: string, tmuxPaneId: string, generation: number) {
  return { generation, paneId, tmuxPaneId };
}

describe('PaneStatusScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aligns panes registered at different times into one manager-owned cadence', () => {
    const onDue = vi.fn();
    const scheduler = new PaneStatusScheduler(onDue);

    scheduler.add(pane('pane-1', '%1'));
    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL / 2);
    scheduler.add(pane('pane-2', '%2'));
    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL / 2);

    expect(onDue).toHaveBeenCalledOnce();
    expect(onDue).toHaveBeenCalledWith([
      request('pane-1', '%1', 1),
      request('pane-2', '%2', 1),
    ]);
  });

  it('captures every quiet pane in one batch per idle cadence', () => {
    const onDue = vi.fn();
    const scheduler = new PaneStatusScheduler(onDue);
    const panes = Array.from({ length: 6 }, (_, index) =>
      pane(`pane-${index + 1}`, `%${index + 1}`));

    panes.forEach((entry) => scheduler.add(entry));

    for (let tick = 0; tick < WORKER_QUIET_TICKS_BEFORE_IDLE; tick++) {
      vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);
      panes.forEach(({ paneId }) => scheduler.complete(paneId, tick + 1, false));
    }

    const batchesBeforeIdleWait = onDue.mock.calls.length;
    vi.advanceTimersByTime(WORKER_IDLE_POLL_INTERVAL - WORKER_ACTIVE_POLL_INTERVAL);
    expect(onDue).toHaveBeenCalledTimes(batchesBeforeIdleWait);

    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);
    expect(onDue).toHaveBeenCalledTimes(batchesBeforeIdleWait + 1);
    expect(onDue).toHaveBeenLastCalledWith(panes.map(({ paneId, tmuxPaneId }) =>
      request(paneId, tmuxPaneId, WORKER_QUIET_TICKS_BEFORE_IDLE + 1)));
  });

  it('coalesces panes that enter the idle tier on adjacent ticks', () => {
    const onDue = vi.fn();
    const scheduler = new PaneStatusScheduler(onDue);
    const first = pane('pane-1', '%1');
    const second = pane('pane-2', '%2');

    scheduler.add(first);
    scheduler.add(second);

    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);
    scheduler.complete(first.paneId, 1, false);
    scheduler.complete(second.paneId, 1, true);

    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);
    scheduler.complete(first.paneId, 2, false);
    scheduler.complete(second.paneId, 2, false);

    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);
    scheduler.complete(first.paneId, 3, false);
    scheduler.complete(second.paneId, 3, false);

    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);
    scheduler.complete(second.paneId, 4, false);

    onDue.mockClear();
    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);
    expect(onDue).not.toHaveBeenCalled();

    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);
    expect(onDue).toHaveBeenCalledOnce();
    expect(onDue).toHaveBeenCalledWith([
      request(first.paneId, first.tmuxPaneId, 4),
      request(second.paneId, second.tmuxPaneId, 5),
    ]);
  });

  it('does not schedule a second capture while the previous capture is unprocessed', () => {
    const onDue = vi.fn();
    const scheduler = new PaneStatusScheduler(onDue);

    scheduler.add(pane('pane-1', '%1'));
    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL * 3);

    expect(onDue).toHaveBeenCalledOnce();

    scheduler.complete('pane-1', 1, true);
    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);
    expect(onDue).toHaveBeenCalledTimes(2);
  });

  it('re-arms a quiet pane on the next active cadence after user activity', () => {
    const onDue = vi.fn();
    const scheduler = new PaneStatusScheduler(onDue);
    scheduler.add(pane('pane-1', '%1'));

    for (let tick = 0; tick < WORKER_QUIET_TICKS_BEFORE_IDLE; tick++) {
      vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);
      scheduler.complete('pane-1', tick + 1, false);
    }

    scheduler.resumeFast('pane-1');
    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);

    expect(onDue).toHaveBeenCalledTimes(WORKER_QUIET_TICKS_BEFORE_IDLE + 1);
  });

  it('issues an out-of-band confirmation capture without waiting for the next poll tick', () => {
    const onDue = vi.fn();
    const scheduler = new PaneStatusScheduler(onDue);
    scheduler.add(pane('pane-1', '%1'));

    expect(scheduler.requestImmediate('pane-1')).toBe(true);
    expect(onDue).toHaveBeenCalledWith([request('pane-1', '%1', 1)]);
  });

  it('honours the latest pause before resuming the active cadence', () => {
    const onDue = vi.fn();
    const scheduler = new PaneStatusScheduler(onDue);
    scheduler.add(pane('pane-1', '%1'));

    scheduler.resumeFast('pane-1', 200);
    scheduler.resumeFast('pane-1', 5000);
    vi.advanceTimersByTime(5000);

    expect(onDue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);
    expect(onDue).toHaveBeenCalledOnce();
  });

  it('re-arms a pane whose capture was never acknowledged', () => {
    // Arrange: the first capture is issued and no completion ever arrives.
    const onDue = vi.fn();
    const scheduler = new PaneStatusScheduler(onDue);
    scheduler.add(pane('pane-1', '%1'));

    // Act
    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL * STALE_PENDING_TICKS);

    // Assert
    expect(onDue).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);
    expect(onDue).toHaveBeenCalledTimes(2);
    expect(onDue).toHaveBeenLastCalledWith([request('pane-1', '%1', 2)]);
  });

  it('drops a late result from a capture the watchdog already abandoned', () => {
    // Arrange: the first capture goes unacknowledged until the watchdog reissues it.
    const onDue = vi.fn();
    const scheduler = new PaneStatusScheduler(onDue);
    scheduler.add(pane('pane-1', '%1'));
    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL * (STALE_PENDING_TICKS + 1));
    expect(onDue).toHaveBeenCalledTimes(2);

    // Act: the reissue settles the cadence, then the abandoned capture lands late.
    scheduler.complete('pane-1', 2, false);
    scheduler.complete('pane-1', 1, true);
    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);
    const dueAfterReissueSettled = onDue.mock.calls.length;
    scheduler.complete('pane-1', 3, false);
    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);

    // Assert: the late result neither re-armed a capture nor consumed the next one.
    expect(dueAfterReissueSettled).toBe(3);
    expect(onDue).toHaveBeenCalledTimes(4);
  });

  it('keeps a working pane on the active cadence when the abandoned result lands first', () => {
    // Arrange: the watchdog abandons generation 1 and reissues it as generation 2.
    const onDue = vi.fn();
    const scheduler = new PaneStatusScheduler(onDue);
    scheduler.add(pane('pane-1', '%1'));
    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL * (STALE_PENDING_TICKS + 1));
    expect(onDue).toHaveBeenCalledTimes(2);

    // Act: on every cycle the abandoned result (inactive) arrives before the
    // real one (active), which is what a reissue race produces.
    onDue.mockClear();
    const cycles = WORKER_QUIET_TICKS_BEFORE_IDLE + 1;
    for (let cycle = 0; cycle < cycles; cycle++) {
      scheduler.complete('pane-1', cycle + 1, false);
      scheduler.complete('pane-1', cycle + 2, true);
      vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);
    }

    // Assert: no stale result settled a capture, so the pane stayed active.
    expect(onDue).toHaveBeenCalledTimes(cycles);
  });

  it('reaches the same cadence when the real result lands before the abandoned one', () => {
    // Arrange: identical reissue race, only the arrival order differs.
    const onDue = vi.fn();
    const scheduler = new PaneStatusScheduler(onDue);
    scheduler.add(pane('pane-1', '%1'));
    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL * (STALE_PENDING_TICKS + 1));

    // Act
    onDue.mockClear();
    const cycles = WORKER_QUIET_TICKS_BEFORE_IDLE + 1;
    for (let cycle = 0; cycle < cycles; cycle++) {
      scheduler.complete('pane-1', cycle + 2, true);
      scheduler.complete('pane-1', cycle + 1, false);
      vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);
    }

    // Assert
    expect(onDue).toHaveBeenCalledTimes(cycles);
  });

  it('recovers the active cadence after the watchdog reissues a never-acknowledged capture', () => {
    // Arrange: the first capture is never acknowledged, so the watchdog reissues it.
    const onDue = vi.fn();
    const scheduler = new PaneStatusScheduler(onDue);
    scheduler.add(pane('pane-1', '%1'));
    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL * (STALE_PENDING_TICKS + 1));
    expect(onDue).toHaveBeenCalledTimes(2);

    // Act: only captures from the reissue onwards are completed, until the pane
    // backs off and user activity re-arms the fast cadence.
    for (let tick = 0; tick < WORKER_QUIET_TICKS_BEFORE_IDLE; tick++) {
      scheduler.complete('pane-1', tick + 2, false);
      vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);
    }
    const dueOnActiveCadence = onDue.mock.calls.length;
    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);
    scheduler.complete('pane-1', WORKER_QUIET_TICKS_BEFORE_IDLE + 2, false);
    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);
    const dueBeforeResume = onDue.mock.calls.length;
    scheduler.resumeFast('pane-1');
    vi.advanceTimersByTime(WORKER_ACTIVE_POLL_INTERVAL);

    // Assert: the reissue settled, so the pane polled on the active cadence
    // instead of the watchdog cadence, backed off, and resumed on demand.
    expect(dueOnActiveCadence).toBe(4);
    expect(dueBeforeResume).toBe(5);
    expect(onDue).toHaveBeenCalledTimes(6);
  });

  it('releases its shared timer when the final pane is removed', () => {
    const scheduler = new PaneStatusScheduler(vi.fn());
    scheduler.add(pane('pane-1', '%1'));
    scheduler.add(pane('pane-2', '%2'));

    expect(vi.getTimerCount()).toBe(1);
    scheduler.remove('pane-1');
    expect(vi.getTimerCount()).toBe(1);
    scheduler.remove('pane-2');
    expect(vi.getTimerCount()).toBe(0);
  });
});
