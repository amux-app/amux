// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  getTerminalFailureTitle,
  getTerminalSelectionCell,
  getTerminalSelectionRange,
  isSameTerminalSize,
  resolveOverlayPalette,
  resolveTerminalFontSize,
} from '../../src/renderer/components/pane-detail/interactive-terminal/terminal-model';
import {
  TERMINAL_ACCENT_COLORS,
  TERMINAL_BACKGROUND_COLORS,
  TERMINAL_FOREGROUND_COLORS,
  TERMINAL_FOREGROUND_MUTED_COLORS,
  TERMINAL_OVERLAY_TRACK_COLORS,
} from '../../src/shared/app-colors';
import { DEFAULT_TERMINAL_FONT_SIZE } from '../../src/shared/terminal-profile';

describe('interactive terminal model', () => {
  it('keeps agent text at the configured size and makes shell text one step smaller', () => {
    expect(resolveTerminalFontSize(15, true)).toBe(15);
    expect(resolveTerminalFontSize(15, false)).toBe(14);
    expect(resolveTerminalFontSize(undefined, true)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(resolveTerminalFontSize(8, false)).toBe(8);
  });

  it('resolves every overlay color from one theme mode', () => {
    expect(resolveOverlayPalette('light')).toEqual({
      accent: TERMINAL_ACCENT_COLORS.light,
      background: TERMINAL_BACKGROUND_COLORS.light,
      foreground: TERMINAL_FOREGROUND_COLORS.light,
      muted: TERMINAL_FOREGROUND_MUTED_COLORS.light,
      track: TERMINAL_OVERLAY_TRACK_COLORS.light,
    });
  });

  it('compares terminal geometry without treating a missing size as equal', () => {
    expect(isSameTerminalSize({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(true);
    expect(isSameTerminalSize({ cols: 80, rows: 24 }, { cols: 100, rows: 24 })).toBe(false);
    expect(isSameTerminalSize(null, { cols: 80, rows: 24 })).toBe(false);
  });

  it('maps failure kinds to stable user-facing headings', () => {
    expect(getTerminalFailureTitle('initialization')).toBe('Terminal unavailable');
    expect(getTerminalFailureTitle('narrow')).toBe('Pane too narrow');
    expect(getTerminalFailureTitle('reconnecting')).toBe('Reconnecting terminal');
    expect(getTerminalFailureTitle('resize')).toBe('Terminal resize failed');
    expect(getTerminalFailureTitle('attach')).toBe('Terminal disconnected');
  });

  it('maps and clips pointers to the visible terminal grid', () => {
    const element = document.createElement('div');
    element.getBoundingClientRect = () => ({
      bottom: 240,
      height: 240,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    expect(getTerminalSelectionCell(
      element,
      80,
      24,
      100,
      { clientX: 405, clientY: 125 },
    )).toEqual({ x: 40, y: 112 });
    expect(getTerminalSelectionCell(
      element,
      80,
      24,
      100,
      { clientX: 400, clientY: -1 },
    )).toEqual({ x: 0, y: 100 });
    expect(getTerminalSelectionCell(
      element,
      80,
      24,
      100,
      { clientX: 400, clientY: 241 },
    )).toEqual({ x: 80, y: 123 });
  });

  it('normalizes forward and reverse selections into one clipped range', () => {
    expect(getTerminalSelectionRange(
      { x: 70, y: 102 },
      { x: 10, y: 101 },
      80,
      24,
      100,
    )).toEqual({ column: 10, length: 140, row: 101 });
    expect(getTerminalSelectionRange(
      { x: 4, y: 99 },
      { x: 6, y: 124 },
      80,
      24,
      100,
    )).toEqual({ column: 0, length: 1920, row: 100 });
    expect(getTerminalSelectionRange(
      { x: 2, y: 100 },
      { x: 2, y: 100 },
      80,
      24,
      100,
    )).toBeNull();
  });
});
