import type { TerminalSelectionPointer } from './terminal-selection-auto-scroll';

type TerminalSelectionScrollDirection = 'down' | 'up';

interface QueuedSelectionScroll {
  direction: TerminalSelectionScrollDirection;
  pointer: TerminalSelectionPointer;
}

interface TerminalSelectionScrollPumpOptions {
  dispatch: (
    direction: TerminalSelectionScrollDirection,
    pointer: TerminalSelectionPointer,
  ) => void;
  maxQueuedUnits?: number;
  onStall?: (stalled: { direction: TerminalSelectionScrollDirection; pointer: TerminalSelectionPointer }) => void;
  repaintTimeoutMs?: number;
}

export interface TerminalSelectionScrollPump {
  acknowledgeRepaint: () => void;
  cancel: () => void;
  enqueue: (
    direction: TerminalSelectionScrollDirection,
    units: number,
    pointer: TerminalSelectionPointer,
  ) => void;
  pendingUnits: () => number;
  waitForIdle: () => Promise<void>;
}

const DEFAULT_MAX_QUEUED_UNITS = 64;
const DEFAULT_REPAINT_TIMEOUT_MS = 500;

export function createTerminalSelectionScrollPump(
  options: TerminalSelectionScrollPumpOptions,
): TerminalSelectionScrollPump {
  const maxQueuedUnits = Math.max(1, options.maxQueuedUnits ?? DEFAULT_MAX_QUEUED_UNITS);
  const repaintTimeoutMs = Math.max(1, options.repaintTimeoutMs ?? DEFAULT_REPAINT_TIMEOUT_MS);
  const queue: QueuedSelectionScroll[] = [];
  const idleWaiters = new Set<() => void>();
  let inFlightStep: QueuedSelectionScroll | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const resolveIdleWaiters = (): void => {
    if (inFlightStep !== null || queue.length > 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const clearRepaintTimeout = (): void => {
    if (timeout === null) return;
    clearTimeout(timeout);
    timeout = null;
  };

  const cancel = (): void => {
    clearRepaintTimeout();
    queue.length = 0;
    inFlightStep = null;
    resolveIdleWaiters();
  };

  const dispatchNext = (): void => {
    if (inFlightStep !== null) return;
    const next = queue.shift();
    if (!next) return;
    inFlightStep = next;
    options.dispatch(next.direction, next.pointer);
    if (inFlightStep === null) return;
    timeout = setTimeout(() => {
      timeout = null;
      const stalled = inFlightStep;
      queue.length = 0;
      inFlightStep = null;
      if (stalled) options.onStall?.({ direction: stalled.direction, pointer: stalled.pointer });
      resolveIdleWaiters();
    }, repaintTimeoutMs);
  };

  return {
    acknowledgeRepaint: () => {
      if (inFlightStep === null) return;
      clearRepaintTimeout();
      inFlightStep = null;
      dispatchNext();
      resolveIdleWaiters();
    },
    cancel,
    enqueue: (direction, units, pointer) => {
      const oppositeDirection = direction === 'down' ? 'up' : 'down';
      const hasOppositeQueued = queue.some((step) => step.direction === oppositeDirection);
      if (hasOppositeQueued) {
        const queueLengthBefore = queue.length;
        queue.splice(0, queueLengthBefore, { direction, pointer: { ...pointer } });
        dispatchNext();
        return;
      }

      const sameDirQueueCount = queue.filter((s) => s.direction === direction).length;
      const availableCapacity = maxQueuedUnits - queue.length - (inFlightStep !== null ? 1 : 0);
      if (availableCapacity <= 0 && sameDirQueueCount > 0) {
        const lastIdx = queue.length - 1;
        if (lastIdx >= 0) queue[lastIdx] = { direction, pointer: { ...pointer } };
        dispatchNext();
        return;
      }

      const boundedUnits = Math.min(
        Math.max(0, Math.floor(units)),
        Math.max(0, availableCapacity),
      );
      for (let index = 0; index < boundedUnits; index += 1) {
        queue.push({ direction, pointer: { ...pointer } });
      }
      dispatchNext();
    },
    pendingUnits: () => queue.length + (inFlightStep !== null ? 1 : 0),
    waitForIdle: () => {
      if (inFlightStep === null && queue.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.add(resolve));
    },
  };
}
