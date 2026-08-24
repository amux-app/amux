import { describe, expect, it } from 'vitest';
import {
  DOUBLE_SHIFT_THRESHOLD_MS,
  resolveSearchShortcutIntent,
  shouldTriggerProjectSearchOnDoubleShift,
} from '../src/renderer/lib/search-shortcut-intents';

describe('search shortcut intents', () => {
  it('uses ctrl+f for in-file find when a file is open', () => {
    expect(resolveSearchShortcutIntent({ ctrlKey: true, key: 'f', metaKey: false, shiftKey: false }, true)).toBe('file');
  });

  it('routes cmd+shift+f to project content search', () => {
    expect(resolveSearchShortcutIntent({ ctrlKey: false, key: 'F', metaKey: true, shiftKey: true }, true)).toBe('project');
  });

  it('routes cmd+p to file name search', () => {
    expect(resolveSearchShortcutIntent({ ctrlKey: false, key: 'p', metaKey: true, shiftKey: false }, false)).toBe('files');
  });

  it('does not claim cmd+f when no file is open', () => {
    expect(resolveSearchShortcutIntent({ ctrlKey: false, key: 'f', metaKey: true, shiftKey: false }, false)).toBeNull();
  });

  it('opens project content search on a clean double shift', () => {
    expect(shouldTriggerProjectSearchOnDoubleShift({
      key: 'Shift',
      lastShiftUp: 1_000,
      now: 1_000 + DOUBLE_SHIFT_THRESHOLD_MS - 1,
      shiftChorded: false,
    })).toBe(true);
  });

  it('ignores a shift release that took part in a chord', () => {
    expect(shouldTriggerProjectSearchOnDoubleShift({
      key: 'Shift',
      lastShiftUp: 1_000,
      now: 1_100,
      shiftChorded: true,
    })).toBe(false);
  });

  it('ignores double shift outside the timing window', () => {
    expect(shouldTriggerProjectSearchOnDoubleShift({
      key: 'Shift',
      lastShiftUp: 1_000,
      now: 1_000 + DOUBLE_SHIFT_THRESHOLD_MS,
      shiftChorded: false,
    })).toBe(false);
  });
});
