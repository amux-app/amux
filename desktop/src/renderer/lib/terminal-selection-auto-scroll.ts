type TerminalSelectionScrollDirection = 'down' | 'up';

export interface TerminalSelectionPointer {
  clientX: number;
  clientY: number;
}

interface TerminalSelectionAutoScrollOptions {
  canStartSelection: (event: MouseEvent) => boolean;
  element: HTMLElement;
  getRowHeight: () => number;
  getSelection: () => string;
  needsCustomScroll: () => boolean;
  onScroll: (
    direction: TerminalSelectionScrollDirection,
    lines: number,
    pointer: TerminalSelectionPointer,
  ) => void;
  onSelectionEnd?: (completed: boolean) => void;
  onSelectionMove?: (pointer: TerminalSelectionPointer) => void;
  onSelectionStart?: (event: MouseEvent) => void;
}

const SCROLL_INTERVAL_MS = 50;
const MAX_SCROLL_LINES = 8;

/**
 * Complements xterm's native drag-selection scrolling for panes whose visible
 * history is owned by tmux or an alternate-screen TUI instead of xterm.
 */
export function attachTerminalSelectionAutoScroll(
  options: TerminalSelectionAutoScrollOptions,
): () => void {
  const document = options.element.ownerDocument;
  const window = document.defaultView;
  let active = false;
  let scrollDirection: TerminalSelectionScrollDirection | null = null;
  let scrollLines = 0;
  let pointer = { clientX: 0, clientY: 0 };
  let timer: ReturnType<typeof setInterval> | null = null;

  const stopTimer = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  const stop = (notifySelectionEnd: boolean = false): void => {
    const wasActive = active;
    active = false;
    scrollDirection = null;
    scrollLines = 0;
    stopTimer();
    if (wasActive) options.onSelectionEnd?.(notifySelectionEnd);
  };

  const tick = (): void => {
    if (!active || !scrollDirection || scrollLines === 0) return;
    if (!options.needsCustomScroll() || !options.getSelection()) return;
    options.onScroll(scrollDirection, scrollLines, pointer);
  };

  const startTimer = (): void => {
    if (timer !== null) return;
    timer = setInterval(tick, SCROLL_INTERVAL_MS);
  };

  const handleMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0 || !options.canStartSelection(event)) return;
    active = true;
    options.onSelectionStart?.(event);
  };

  const handleMouseMove = (event: MouseEvent): void => {
    if (!active) return;
    if ((event.buttons & 1) === 0) {
      stop(true);
      return;
    }

    pointer = { clientX: event.clientX, clientY: event.clientY };
    options.onSelectionMove?.(pointer);
    const rect = options.element.getBoundingClientRect();
    const rowHeight = Math.max(1, options.getRowHeight());
    const edgeSize = Math.max(8, rowHeight);
    if (event.clientY <= rect.top + edgeSize) {
      scrollDirection = 'up';
      scrollLines = getScrollLines(rect.top - event.clientY, rowHeight);
      startTimer();
      return;
    }
    if (event.clientY >= rect.bottom - edgeSize) {
      scrollDirection = 'down';
      scrollLines = getScrollLines(event.clientY - rect.bottom, rowHeight);
      startTimer();
      return;
    }

    scrollDirection = null;
    scrollLines = 0;
    stopTimer();
  };

  options.element.addEventListener('mousedown', handleMouseDown, true);
  document.addEventListener('mousemove', handleMouseMove, true);
  const handleMouseUp = (): void => stop(true);
  const handleWindowBlur = (): void => stop();
  document.addEventListener('mouseup', handleMouseUp, true);
  window?.addEventListener('blur', handleWindowBlur);

  return () => {
    stop();
    options.element.removeEventListener('mousedown', handleMouseDown, true);
    document.removeEventListener('mousemove', handleMouseMove, true);
    document.removeEventListener('mouseup', handleMouseUp, true);
    window?.removeEventListener('blur', handleWindowBlur);
  };
}

function getScrollLines(outsideDistance: number, rowHeight: number): number {
  if (outsideDistance <= 0) return 1;
  return Math.min(MAX_SCROLL_LINES, 1 + Math.floor(outsideDistance / rowHeight));
}
