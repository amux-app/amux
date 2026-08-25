export const BINARY_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  '7z',
  'avi',
  'bmp',
  'bz2',
  'dll',
  'dylib',
  'eot',
  'exe',
  'gif',
  'gz',
  'ico',
  'jpeg',
  'jpg',
  'class',
  'db',
  'dmg',
  'mov',
  'mp3',
  'mp4',
  'otf',
  'pdf',
  'png',
  'pyc',
  'pyo',
  'rar',
  'so',
  'sqlite',
  'sqlite3',
  'tar',
  'ttf',
  'wav',
  'wasm',
  'webp',
  'woff',
  'woff2',
  'zip',
]);

export const HEAVY_IGNORED_DIRS: ReadonlySet<string> = new Set([
  '.muxbase',
  '.muxbase',
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);

export function isBinaryFileName(fileName: string): boolean {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  return BINARY_FILE_EXTENSIONS.has(extension);
}

export function isValidEntryName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') {
    return false;
  }
  return !/[/\\\0]/.test(trimmed);
}

export function parentDir(relativePath: string): string {
  const lastSlash = relativePath.lastIndexOf('/');
  return lastSlash > 0 ? relativePath.slice(0, lastSlash) : '';
}

/**
 * True when `candidate` is `ancestor` or lives beneath it. Relative POSIX paths only — a bare
 * `startsWith` would make `src/app` swallow `src/application`.
 */
export function isSelfOrDescendant(ancestor: string, candidate: string): boolean {
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

/** Rewrites `path` from under `from` to under `to`. Returns null when `path` is unrelated to `from`. */
export function remapPath(from: string, to: string, path: string): string | null {
  return isSelfOrDescendant(from, path) ? `${to}${path.slice(from.length)}` : null;
}

function hasKeptAncestor(kept: ReadonlySet<string>, path: string): boolean {
  for (let ancestor = parentDir(path); ancestor !== ''; ancestor = parentDir(ancestor)) {
    if (kept.has(ancestor)) return true;
  }
  return false;
}

/**
 * Drops descendants whose ancestor is also present, and de-duplicates. Sorting only guarantees that
 * an ancestor is seen before its own descendants — not that it is adjacent to them, because `/`
 * (0x2F) sorts after `-` and `.`, so `src-b` and `src.d.ts` both land between `src` and `src/a`.
 * Each candidate therefore walks its whole ancestor chain rather than checking one neighbour.
 */
export function normalizeOperationPaths(paths: readonly string[]): string[] {
  const kept = new Set<string>();

  for (const path of [...new Set(paths)].sort()) {
    if (!hasKeptAncestor(kept, path)) kept.add(path);
  }

  return [...kept];
}
