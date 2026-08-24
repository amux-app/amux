import type { FileEntry } from '../../../../shared/ipc-types';
import { resolveFileIcon, resolveFolderIcon, type FileIconRef } from '../../../lib/fileIcons';

export const PLACEHOLDER_ID = '__file_tree_new_entry__';
export const ROW_ICON_CLASS = 'mr-1.5';
export const DROP_TARGET_CLASS = 'bg-(--accent)/10 ring-1 ring-inset ring-(--accent)';
export const MENU_ITEM_CLASS =
  'flex h-7 cursor-pointer items-center px-3 text-[12px] text-(--text-secondary) outline-none data-highlighted:bg-[rgba(255,255,255,0.06)] data-highlighted:text-(--text)';
export const MENU_SEPARATOR_CLASS = 'mx-2 my-1 h-px bg-(--border)';
/**
 * `ReadonlySet` is a compile-time view only, so a single shared instance would let one stray
 * mutation populate the empty selection, the empty drag set, and the cut highlight at once. Each
 * consumer calls this once at module scope for its own stable-identity empty set.
 */
export function emptyPathSet(): ReadonlySet<string> {
  return new Set<string>();
}
const EMPTY_EXPANDED_DIRS = new Set<string>();

export interface CreatingState {
  dir: string;
  type: 'file' | 'folder';
}

export interface FileTreeRowData {
  depth: number;
  icon: FileIconRef;
  id: string;
  name: string;
  path: string;
  isDirectory: boolean;
  isOpen: boolean;
  isPlaceholder: boolean;
  placeholderKind?: 'file' | 'folder';
  placeholderDir?: string;
}

/** Resolved once per row build so scrolling the virtualized list never re-parses file names. */
function rowIcon(name: string, isDirectory: boolean, isOpen: boolean): FileIconRef {
  return isDirectory ? resolveFolderIcon(name, isOpen) : resolveFileIcon(name);
}

function childTreeKey(rootPath: string, dirPath: string): string {
  return dirPath ? `${rootPath}::${dirPath}` : rootPath;
}

function makePlaceholderRow(creating: CreatingState, depth: number): FileTreeRowData {
  const isDirectory = creating.type === 'folder';
  return {
    depth,
    icon: rowIcon('', isDirectory, false),
    id: `${PLACEHOLDER_ID}:${creating.dir}:${creating.type}`,
    name: '',
    path: '',
    isDirectory,
    isOpen: false,
    isPlaceholder: true,
    placeholderKind: creating.type,
    placeholderDir: creating.dir,
  };
}

function buildVisibleRows(
  rootPath: string,
  dirPath: string,
  depth: number,
  trees: Record<string, FileEntry[]>,
  expandedDirs: ReadonlySet<string>,
  creating: CreatingState | null,
): FileTreeRowData[] {
  const rows: FileTreeRowData[] = [];

  if (creating?.dir === dirPath) {
    rows.push(makePlaceholderRow(creating, depth));
  }

  const entries = trees[childTreeKey(rootPath, dirPath)] ?? [];
  for (const entry of entries) {
    const isOpen = entry.isDirectory && expandedDirs.has(entry.path);
    rows.push({
      icon: rowIcon(entry.name, entry.isDirectory, isOpen),
      id: entry.path,
      name: entry.name,
      path: entry.path,
      isDirectory: entry.isDirectory,
      isPlaceholder: false,
      depth,
      isOpen,
    });

    if (isOpen) {
      rows.push(...buildVisibleRows(rootPath, entry.path, depth + 1, trees, expandedDirs, creating));
    }
  }

  return rows;
}

export function toFileEntry(row: FileTreeRowData): FileEntry {
  return {
    isDirectory: row.isDirectory,
    name: row.name,
    path: row.path,
  };
}

export function buildVisibleFileTreeRows(
  rootPath: string,
  trees: Record<string, FileEntry[]>,
  expandedDirs: ReadonlySet<string> | undefined,
  creating: CreatingState | null,
): FileTreeRowData[] {
  return buildVisibleRows(rootPath, '', 0, trees, expandedDirs ?? EMPTY_EXPANDED_DIRS, creating);
}
