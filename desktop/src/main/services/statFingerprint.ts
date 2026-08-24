import type { Stats } from 'node:fs';

/**
 * Content identity of a stat-ed path, for callers memoizing what they read from
 * it. Append, truncate, replace and in-place rewrite all change it: `ctimeMs` is
 * what covers the rewrite that lands on the same inode at the same size with the
 * same modification time, which no other field distinguishes.
 */
export function statFingerprint(stats: Stats): string {
  return `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.ino}`;
}
