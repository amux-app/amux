import {
  TERMINAL_ACCENT_COLORS,
  TERMINAL_BACKGROUND_COLORS,
  TERMINAL_FOREGROUND_COLORS,
  TERMINAL_FOREGROUND_MUTED_COLORS,
  TERMINAL_OVERLAY_TRACK_COLORS,
} from '../../../../shared/app-colors';
import { accumulateScrolledTerminalSelection } from '../../../../shared/terminal-selection';
import { DEFAULT_TERMINAL_FONT_SIZE } from '../../../../shared/terminal-profile';
import type { ThemeMode } from '../../../../shared/theme-mode';
import type { TerminalSelectionPointer } from '../../../lib/terminal-selection-auto-scroll';
import type { TerminalSelectionCell } from '../../../lib/terminal-selection-gesture';

export const MAX_ACCUMULATED_SELECTION_CHARS = 2 * 1024 * 1024;
export const NARROW_TERMINAL_FAILURE_MESSAGE = 'Pane is too narrow for its fixed terminal profile. Widen it to reconnect automatically.';
const SHELL_TERMINAL_FONT_SIZE_DELTA = -1;
const TERMINAL_MIN_FONT_SIZE = 8;

export interface ScrolledTerminalSelection {
  accumulatedText: string | null;
  anchorText: string;
  complete: boolean;
  direction: 'down' | 'up';
  rangeVerified: boolean;
  reversalInvalidated: boolean;
}

export interface TerminalFailure {
  kind: 'attach' | 'fit' | 'initialization' | 'narrow' | 'reconnecting' | 'resize';
  message: string;
}

export interface TerminalOverlayPalette {
  accent: string;
  background: string;
  foreground: string;
  muted: string;
  track: string;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface PendingTerminalResize extends TerminalSize {
  requestId: number;
}

export function accumulateSelectionSnapshot(
  selection: ScrolledTerminalSelection,
  snapshot: string,
): 'advanced' | 'unchanged' | 'unverified' {
  if (selection.reversalInvalidated) {
    selection.rangeVerified = false;
    return 'unverified';
  }
  if (selection.accumulatedText === null) {
    selection.rangeVerified = false;
    return 'unverified';
  }
  const previousText = selection.accumulatedText;
  const accumulatedText = accumulateScrolledTerminalSelection(
    previousText,
    snapshot,
    selection.direction,
  );
  // Keep the last verified range across a transient layout-only frame so a
  // later stable repaint can recover. Mark it unverified in the meantime so
  // copy cannot silently use a known-partial range if the gesture ends here.
  if (accumulatedText === null) {
    selection.rangeVerified = false;
    return 'unverified';
  }
  if (accumulatedText.length > MAX_ACCUMULATED_SELECTION_CHARS) {
    selection.accumulatedText = null;
    selection.rangeVerified = false;
    return 'unverified';
  }
  selection.accumulatedText = accumulatedText;
  selection.rangeVerified = true;
  return accumulatedText === previousText ? 'unchanged' : 'advanced';
}

export function getTerminalFailureTitle(kind: TerminalFailure['kind']): string {
  if (kind === 'fit' || kind === 'initialization') return 'Terminal unavailable';
  if (kind === 'narrow') return 'Pane too narrow';
  if (kind === 'reconnecting') return 'Reconnecting terminal';
  if (kind === 'resize') return 'Terminal resize failed';
  return 'Terminal disconnected';
}

export function getTerminalSelectionCell(
  element: HTMLElement,
  cols: number,
  rows: number,
  viewportY: number,
  pointer: TerminalSelectionPointer,
): TerminalSelectionCell {
  const rect = element.getBoundingClientRect();
  const lastRow = viewportY + Math.max(0, rows - 1);
  if (pointer.clientY <= rect.top) return { x: 0, y: viewportY };
  if (pointer.clientY >= rect.bottom) return { x: cols, y: lastRow };

  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  return {
    x: Math.max(0, Math.min(cols, Math.floor(((pointer.clientX - rect.left) / width) * cols))),
    y: viewportY + Math.max(0, Math.min(rows - 1, Math.floor(((pointer.clientY - rect.top) / height) * rows))),
  };
}

export function getTerminalSelectionRange(
  anchor: TerminalSelectionCell,
  pointer: TerminalSelectionCell,
  cols: number,
  rows: number,
  viewportY: number,
): { column: number; length: number; row: number } | null {
  const lastRow = viewportY + Math.max(0, rows - 1);
  const clip = (cell: TerminalSelectionCell): TerminalSelectionCell => {
    if (cell.y < viewportY) return { x: 0, y: viewportY };
    if (cell.y > lastRow) return { x: cols, y: lastRow };
    return { x: Math.max(0, Math.min(cols, cell.x)), y: cell.y };
  };
  const clippedAnchor = clip(anchor);
  const clippedPointer = clip(pointer);
  const anchorFirst = clippedAnchor.y < clippedPointer.y
    || (clippedAnchor.y === clippedPointer.y && clippedAnchor.x <= clippedPointer.x);
  const start = anchorFirst ? clippedAnchor : clippedPointer;
  const end = anchorFirst ? clippedPointer : clippedAnchor;
  const length = (end.y - start.y) * cols + end.x - start.x;
  return length > 0 ? { column: start.x, length, row: start.y } : null;
}

export function isSameTerminalSize(left: TerminalSize | null, right: TerminalSize): boolean {
  return left?.cols === right.cols && left.rows === right.rows;
}

export function resolveOverlayPalette(mode: ThemeMode): TerminalOverlayPalette {
  return {
    accent: TERMINAL_ACCENT_COLORS[mode],
    background: TERMINAL_BACKGROUND_COLORS[mode],
    foreground: TERMINAL_FOREGROUND_COLORS[mode],
    muted: TERMINAL_FOREGROUND_MUTED_COLORS[mode],
    track: TERMINAL_OVERLAY_TRACK_COLORS[mode],
  };
}

export function resolveTerminalFontSize(fontSize: number | undefined, hasAgent: boolean): number {
  const baseFontSize = fontSize || DEFAULT_TERMINAL_FONT_SIZE;
  if (hasAgent) return baseFontSize;
  return Math.max(TERMINAL_MIN_FONT_SIZE, baseFontSize + SHELL_TERMINAL_FONT_SIZE_DELTA);
}
