import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTerminalSelectionScrollPump } from '../../src/renderer/lib/terminal-selection-scroll-pump';

describe('terminal selection scroll pump', () => {
  afterEach(() => vi.useRealTimers());

  it('dispatches at most one scroll unit before each repaint acknowledgement', () => {
    const dispatch = vi.fn();
    const pump = createTerminalSelectionScrollPump({ dispatch });

    pump.enqueue('down', 3, { clientX: 10, clientY: 20 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenLastCalledWith('down', { clientX: 10, clientY: 20 });

    pump.acknowledgeRepaint();
    expect(dispatch).toHaveBeenCalledTimes(2);
    pump.acknowledgeRepaint();
    expect(dispatch).toHaveBeenCalledTimes(3);
    pump.acknowledgeRepaint();
    expect(pump.pendingUnits()).toBe(0);
  });

  it('drops queued work on cancellation', () => {
    const dispatch = vi.fn();
    const pump = createTerminalSelectionScrollPump({ dispatch });

    pump.enqueue('up', 4, { clientX: 1, clientY: 2 });
    pump.cancel();
    pump.acknowledgeRepaint();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(pump.pendingUnits()).toBe(0);
  });

  it('lets selection finalization wait until every queued repaint settles', async () => {
    const dispatch = vi.fn();
    const pump = createTerminalSelectionScrollPump({ dispatch });

    pump.enqueue('down', 2, { clientX: 10, clientY: 20 });
    const idle = pump.waitForIdle();
    let settled = false;
    void idle.then(() => { settled = true; });

    pump.acknowledgeRepaint();
    await Promise.resolve();
    expect(settled).toBe(false);

    pump.acknowledgeRepaint();
    await expect(idle).resolves.toBeUndefined();
  });

  it('unblocks selection finalization when pending work is canceled', async () => {
    const pump = createTerminalSelectionScrollPump({ dispatch: vi.fn() });

    pump.enqueue('down', 2, { clientX: 10, clientY: 20 });
    const idle = pump.waitForIdle();
    pump.cancel();

    await expect(idle).resolves.toBeUndefined();
  });

  it('uses its timeout only as a liveness guard and reports the stalled pump', () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const dispatch = vi.fn();
    const pump = createTerminalSelectionScrollPump({ dispatch, onStall, repaintTimeoutMs: 100 });

    pump.enqueue('down', 5, { clientX: 3, clientY: 4 });
    vi.advanceTimersByTime(100);

    expect(onStall).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(pump.pendingUnits()).toBe(0);
  });

  it('bounds burst input without skipping the in-flight frame', () => {
    const dispatch = vi.fn();
    const pump = createTerminalSelectionScrollPump({ dispatch, maxQueuedUnits: 4 });

    pump.enqueue('down', 100, { clientX: 3, clientY: 4 });
    pump.enqueue('down', 100, { clientX: 5, clientY: 6 });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(pump.pendingUnits()).toBe(4);
  });

  it('passes the stalled step direction and pointer to onStall', () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const dispatch = vi.fn();
    const pump = createTerminalSelectionScrollPump({ dispatch, onStall, repaintTimeoutMs: 100 });

    pump.enqueue('up', 1, { clientX: 7, clientY: 8 });
    vi.advanceTimersByTime(100);

    expect(onStall).toHaveBeenCalledOnce();
    expect(onStall).toHaveBeenCalledWith({ direction: 'up', pointer: { clientX: 7, clientY: 8 } });
  });

  it('drops queued old-direction units on opposite-direction enqueue and keeps newest unit', () => {
    const dispatch = vi.fn();
    const pump = createTerminalSelectionScrollPump({ dispatch, maxQueuedUnits: 4 });

    pump.enqueue('down', 3, { clientX: 1, clientY: 1 });
    expect(pump.pendingUnits()).toBe(3);

    pump.enqueue('up', 1, { clientX: 9, clientY: 9 });

    expect(pump.pendingUnits()).toBe(2);
    pump.acknowledgeRepaint();
    expect(dispatch).toHaveBeenLastCalledWith('up', { clientX: 9, clientY: 9 });
    expect(pump.pendingUnits()).toBe(1);
    pump.acknowledgeRepaint();
    expect(pump.pendingUnits()).toBe(0);
  });

  it('replaces last queued pointer on same-direction enqueue when queue is full', () => {
    const dispatch = vi.fn();
    const pump = createTerminalSelectionScrollPump({ dispatch, maxQueuedUnits: 2 });

    pump.enqueue('down', 2, { clientX: 1, clientY: 1 });
    expect(pump.pendingUnits()).toBe(2);

    pump.enqueue('down', 1, { clientX: 99, clientY: 99 });

    expect(pump.pendingUnits()).toBe(2);
    pump.acknowledgeRepaint();
    pump.acknowledgeRepaint();
    expect(dispatch).toHaveBeenLastCalledWith('down', { clientX: 99, clientY: 99 });
  });
});
