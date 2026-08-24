// WAI-ARIA Radio Pattern keyboard navigation:
// https://www.w3.org/WAI/ARIA/apg/patterns/radio/
//
// Given the pressed key and current selection, returns the next index to select
// (skipping unavailable items, wrapping around). Returns null when the key is
// not a navigation key — caller should not preventDefault in that case.

const FORWARD_KEYS = new Set(['ArrowRight', 'ArrowDown']);
const BACKWARD_KEYS = new Set(['ArrowLeft', 'ArrowUp']);

export function nextRovingIndex(
  key: string,
  current: number,
  isAvailable: (index: number) => boolean,
  count: number,
): number | null {
  if (count === 0) return null;
  if (key === 'Home') return findAvailable(0, 1, isAvailable, count);
  if (key === 'End') return findAvailable(count - 1, -1, isAvailable, count);
  if (FORWARD_KEYS.has(key)) return findAvailable(wrap(current + 1, count), 1, isAvailable, count);
  if (BACKWARD_KEYS.has(key)) return findAvailable(wrap(current - 1, count), -1, isAvailable, count);
  return null;
}

function wrap(index: number, count: number): number {
  return ((index % count) + count) % count;
}

function findAvailable(
  start: number,
  step: 1 | -1,
  isAvailable: (index: number) => boolean,
  count: number,
): number | null {
  let i = start;
  for (let visited = 0; visited < count; visited++) {
    if (isAvailable(i)) return i;
    i = wrap(i + step, count);
  }
  return null;
}
