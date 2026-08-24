import { readdirSync, statSync, type Stats } from 'fs';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { statFingerprint } from '../statFingerprint.js';

export const JSONL_EXTENSION = '.jsonl';

const FINGERPRINT_SEPARATOR = '|';
const ABSENT_FINGERPRINT = 'absent';

/** One session file, with every stat projection its callers need. */
export interface SessionFileStat {
  path: string;
  birthtimeMs: number;
  mtimeMs: number;
  size: number;
}

export function statFile(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** Newest of birth and modification time: a rewritten file must not look older. */
export function readSessionFileTime(path: string): number | null {
  const stats = statFile(path);
  return stats ? Math.max(stats.birthtimeMs, stats.mtimeMs) : null;
}

/** Content identity of a path. Append, truncate and replace all change it. */
export function fileFingerprint(path: string): string | null {
  const stats = statFile(path);
  return stats ? statFingerprint(stats) : null;
}

/** Joint identity of a file and its sidecars, e.g. a SQLite `-wal`. */
export function fileGroupFingerprint(path: string, companionSuffixes: string[]): string | null {
  const main = fileFingerprint(path);
  if (!main) return null;
  const parts = [main];
  for (const suffix of companionSuffixes) {
    parts.push(fileFingerprint(`${path}${suffix}`) ?? ABSENT_FINGERPRINT);
  }
  return parts.join(FINGERPRINT_SEPARATOR);
}

export function listDirectoryEntries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

async function statSessionFile(path: string): Promise<SessionFileStat | null> {
  try {
    const stats = await stat(path);
    return { path, birthtimeMs: stats.birthtimeMs, mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  }
}

/** The directory's `.jsonl` files, newest-first, minus `excludePaths`. */
export async function listSessionFilesByMtime(
  dir: string,
  excludePaths?: Set<string>,
): Promise<SessionFileStat[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const paths = names
    .filter((name) => name.endsWith(JSONL_EXTENSION))
    .map((name) => join(dir, name))
    .filter((path) => !excludePaths?.has(path));

  const files = await Promise.all(paths.map(statSessionFile));
  return files
    .filter((file): file is SessionFileStat => file !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}
