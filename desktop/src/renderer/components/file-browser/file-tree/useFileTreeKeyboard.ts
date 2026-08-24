import { useEffect, useState, type KeyboardEvent } from 'react';
import { parentDir } from '../../../../shared/filePolicy';
import type { FileTreeRowData } from './fileTreeModel';

interface FileTreeClipboardVerbs {
  onClearClipboard: () => void;
  onCopy: (path: string) => void;
  onCut: (path: string) => void;
  onDelete: (path: string) => void;
  onDuplicate: (path: string) => void;
  onPaste: (destDir: string) => void;
  onRename: (path: string) => void;
  onUndo: () => void;
}

export interface FileTreeKeyboardOptions extends FileTreeClipboardVerbs {
  activePath: string | null;
  focusRowAt: (index: number, extendSelection?: boolean) => void;
  navigableRows: FileTreeRowData[];
  onFileClick?: (relativePath: string) => void;
  onToggleDir: (dirPath: string) => void;
}

function expandOrDescend(
  rows: FileTreeRowData[],
  index: number,
  options: Pick<FileTreeKeyboardOptions, 'focusRowAt' | 'onToggleDir'>,
): boolean {
  const row = rows[index];
  if (!row.isDirectory) return false;

  if (!row.isOpen) {
    options.onToggleDir(row.path);
  } else if (rows[index + 1]?.depth > row.depth) {
    options.focusRowAt(index + 1);
  }
  return true;
}

function collapseOrAscend(
  rows: FileTreeRowData[],
  index: number,
  options: Pick<FileTreeKeyboardOptions, 'focusRowAt' | 'onToggleDir'>,
): void {
  const row = rows[index];
  if (row.isDirectory && row.isOpen) {
    options.onToggleDir(row.path);
    return;
  }
  if (row.depth === 0) return;

  let parentIndex = index - 1;
  while (parentIndex >= 0 && rows[parentIndex].depth !== row.depth - 1) {
    parentIndex -= 1;
  }
  if (parentIndex >= 0) options.focusRowAt(parentIndex);
}

function typeAhead(
  rows: FileTreeRowData[],
  index: number,
  event: KeyboardEvent<HTMLDivElement>,
  focusRowAt: (index: number) => void,
): boolean {
  if (event.key.length !== 1 || event.altKey || event.ctrlKey || event.metaKey) return false;

  const search = event.key.toLocaleLowerCase();
  const matchOffset = [...rows.slice(index + 1), ...rows.slice(0, index + 1)]
    .findIndex((row) => row.name.toLocaleLowerCase().startsWith(search));
  if (matchOffset < 0) return false;

  focusRowAt((index + 1 + matchOffset) % rows.length);
  return true;
}

function findNearestVisibleAncestor(
  rows: FileTreeRowData[],
  activePath: string,
): string | undefined {
  let ancestorPath = parentDir(activePath);
  while (ancestorPath) {
    if (rows.some((row) => row.path === ancestorPath)) return ancestorPath;
    ancestorPath = parentDir(ancestorPath);
  }
  return undefined;
}

/** Keeps the active row on something that still exists after the tree collapses, reloads, or moves. */
export function useActiveRowPath(
  navigableRows: FileTreeRowData[],
  viewingFilePath: string | null,
): [string | null, (path: string | null) => void] {
  const [activePath, setActivePath] = useState<string | null>(null);

  useEffect(() => {
    if (navigableRows.length === 0) {
      if (activePath !== null) setActivePath(null);
      return;
    }
    if (activePath && navigableRows.some((row) => row.path === activePath)) return;

    const ancestorPath = activePath ? findNearestVisibleAncestor(navigableRows, activePath) : undefined;
    if (ancestorPath) {
      setActivePath(ancestorPath);
      return;
    }

    const viewedRow = viewingFilePath
      ? navigableRows.find((row) => row.path === viewingFilePath)
      : undefined;
    setActivePath(viewedRow?.path ?? navigableRows[0].path);
  }, [activePath, navigableRows, viewingFilePath]);

  return [activePath, setActivePath];
}

function isTrashKey(event: KeyboardEvent<HTMLDivElement>): boolean {
  return event.key === 'Delete' || (event.key === 'Backspace' && event.metaKey);
}

/** Verbs that act on the tree rather than on a row, so they still work when no row exists. */
function runTreeVerb(event: KeyboardEvent<HTMLDivElement>, verbs: FileTreeClipboardVerbs): boolean {
  if (event.key === 'Escape') {
    verbs.onClearClipboard();
    return true;
  }
  // Shift+Cmd+Z is redo elsewhere; this tree has no redo, so it must not undo either.
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
    verbs.onUndo();
    return true;
  }
  return false;
}

/** Every drag operation has a keyboard equivalent here; that is the accessibility story, not polish. */
function runClipboardVerb(
  event: KeyboardEvent<HTMLDivElement>,
  row: FileTreeRowData,
  verbs: FileTreeClipboardVerbs,
): boolean {
  if (event.key === 'F2') {
    verbs.onRename(row.path);
    return true;
  }
  if (isTrashKey(event)) {
    verbs.onDelete(row.path);
    return true;
  }
  if (!event.metaKey && !event.ctrlKey) return false;

  switch (event.key.toLowerCase()) {
    case 'c':
      verbs.onCopy(row.path);
      return true;
    case 'x':
      verbs.onCut(row.path);
      return true;
    case 'v':
      verbs.onPaste(row.isDirectory ? row.path : parentDir(row.path));
      return true;
    case 'd':
      verbs.onDuplicate(row.path);
      return true;
    default:
      return false;
  }
}

/**
 * Returns a plain handler rather than a memoized one: the verbs arrive as fresh closures every
 * render, so a `useCallback` here could never hit, and the handler is only ever attached to a
 * single `onKeyDown` prop whose identity nothing depends on.
 */
export function useFileTreeKeyboard(
  options: FileTreeKeyboardOptions,
): (event: KeyboardEvent<HTMLDivElement>) => void {
  const {
    activePath,
    focusRowAt,
    navigableRows,
    onFileClick,
    onToggleDir,
    ...verbs
  } = options;

  return (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;

    if (runTreeVerb(event, verbs)) {
      event.preventDefault();
      return;
    }
    if (navigableRows.length === 0) return;

    const activeIndex = Math.max(0, navigableRows.findIndex((row) => row.path === activePath));
    const activeRow = navigableRows[activeIndex];

    if (runClipboardVerb(event, activeRow, verbs)) {
      event.preventDefault();
      return;
    }

    let handled = true;

    switch (event.key) {
      case 'ArrowDown':
        focusRowAt(activeIndex + 1, event.shiftKey);
        break;
      case 'ArrowUp':
        focusRowAt(activeIndex - 1, event.shiftKey);
        break;
      case 'Home':
        focusRowAt(0);
        break;
      case 'End':
        focusRowAt(navigableRows.length - 1);
        break;
      case 'ArrowRight':
        handled = expandOrDescend(navigableRows, activeIndex, { focusRowAt, onToggleDir });
        break;
      case 'ArrowLeft':
        collapseOrAscend(navigableRows, activeIndex, { focusRowAt, onToggleDir });
        break;
      case 'Enter':
      case ' ':
        if (activeRow.isDirectory) onToggleDir(activeRow.path);
        else onFileClick?.(activeRow.path);
        break;
      default:
        handled = typeAhead(navigableRows, activeIndex, event, focusRowAt);
    }

    if (handled) event.preventDefault();
  };
}
