export const DOUBLE_SHIFT_THRESHOLD_MS = 400;

export type SearchShortcutIntent = 'file' | 'files' | 'project';

interface SearchShortcutEventLike {
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

interface DoubleShiftState {
  key: string;
  lastShiftUp: number;
  now: number;
  shiftChorded: boolean;
}

export function resolveSearchShortcutIntent(
  event: SearchShortcutEventLike,
  hasOpenFile: boolean,
): SearchShortcutIntent | null {
  if (!(event.metaKey || event.ctrlKey)) {
    return null;
  }

  const key = event.key.toLowerCase();
  if (key === 'p' && !event.shiftKey) {
    return 'files';
  }

  if (key !== 'f') {
    return null;
  }

  if (event.shiftKey) {
    return 'project';
  }

  return hasOpenFile ? 'file' : null;
}

export function shouldTriggerProjectSearchOnDoubleShift({
  key,
  lastShiftUp,
  now,
  shiftChorded,
}: DoubleShiftState): boolean {
  return key === 'Shift'
    && !shiftChorded
    && lastShiftUp > 0
    && now - lastShiftUp < DOUBLE_SHIFT_THRESHOLD_MS;
}
