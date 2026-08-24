import { isSelfOrDescendant, remapPath } from '../../shared/filePolicy';
import type { FileEntry } from '../../shared/ipc-types';

export interface FileMoveRemap {
  from: string;
  to: string;
}

export interface ActiveFileMove {
  /** Only a move unlinks its source; a copy leaves it in place. */
  mode: 'move' | 'copy';
  paths: readonly string[];
  rootPath: string;
}

/**
 * A moved folder takes its children with it, so containment — not an exact match — decides whether a
 * path is part of the move. An exact-match check would let the source `unlink` of a file inside a
 * moved folder reach the editor as a genuine on-disk deletion. A copy is excluded outright: it
 * unlinks nothing, so an unlink arriving while one runs really is a deletion.
 */
export function isPathInActiveMove(
  activeMove: ActiveFileMove | null,
  rootPath: string,
  relativePath: string,
): boolean {
  return activeMove?.mode === 'move'
    && activeMove.rootPath === rootPath
    && activeMove.paths.some((path) => isSelfOrDescendant(path, relativePath));
}

export function fileKey(rootPath: string, relativePath: string): string {
  return JSON.stringify([rootPath, relativePath]);
}

export function folderColorKey(rootPath: string, relativePath: string): string {
  return JSON.stringify([rootPath, relativePath]);
}

export function treeKey(rootPath: string, dirPath: string): string {
  return dirPath ? `${rootPath}::${dirPath}` : rootPath;
}

function parseFolderColorKey(key: string): { relativePath: string; rootPath: string } | null {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string'
      ? { relativePath: parsed[1], rootPath: parsed[0] }
      : null;
  } catch {
    return null;
  }
}

/**
 * `trees` is keyed by directory, so a moved subtree stays cached under its old key and would render
 * empty forever — `toggleDir` skips `loadDir` for a directory that is already expanded.
 */
export function dropCachedSubtree(
  trees: Record<string, FileEntry[]>,
  rootPath: string,
  from: string,
): void {
  const exactKey = treeKey(rootPath, from);
  const childPrefix = `${exactKey}/`;
  for (const key of Object.keys(trees)) {
    if (key === exactKey || key.startsWith(childPrefix)) {
      delete trees[key];
    }
  }
}

export function remapExpandedDirs(expanded: Set<string>, { from, to }: FileMoveRemap): void {
  for (const dir of [...expanded]) {
    const next = remapPath(from, to, dir);
    if (next === null) continue;
    expanded.delete(dir);
    expanded.add(next);
  }
}

export function remapFolderColors(
  colors: Record<string, string>,
  rootPath: string,
  { from, to }: FileMoveRemap,
): Record<string, string> {
  let next: Record<string, string> | null = null;

  for (const [key, color] of Object.entries(colors)) {
    const parsed = parseFolderColorKey(key);
    if (parsed?.rootPath !== rootPath) continue;
    const nextPath = remapPath(from, to, parsed.relativePath);
    if (nextPath === null) continue;
    next ??= { ...colors };
    delete next[key];
    next[folderColorKey(rootPath, nextPath)] = color;
  }

  return next ?? colors;
}

/** Generic over the viewing-file shape so this module stays free of the store's state types. */
export function remapViewingFile<T extends { relativePath: string; rootPath: string }>(
  viewingFile: T | null,
  rootPath: string,
  { from, to }: FileMoveRemap,
): T | null {
  if (viewingFile?.rootPath !== rootPath) return viewingFile;
  const relativePath = remapPath(from, to, viewingFile.relativePath);
  return relativePath === null ? viewingFile : { ...viewingFile, relativePath };
}
