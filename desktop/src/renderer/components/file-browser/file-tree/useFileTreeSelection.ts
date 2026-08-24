import { useCallback, useEffect, useMemo, useState } from 'react';
import { emptyPathSet, type FileTreeRowData } from './fileTreeModel';

export interface SelectionModifiers {
  /** Shift: take everything between the anchor and this row. */
  extend: boolean;
  /** Cmd/Ctrl: add or remove this row on its own. */
  toggle: boolean;
}

export interface FileTreeSelection {
  /**
   * Paths an action on `path` should apply to: the whole selection when `path` is part of it,
   * otherwise just that row — the rule that keeps a right-click outside the selection from
   * silently operating on rows the user cannot see.
   */
  pathsFor: (path: string) => string[];
  selectRow: (path: string, modifiers: SelectionModifiers) => void;
  selectedPaths: ReadonlySet<string>;
}

interface SelectionState {
  anchor: string | null;
  paths: ReadonlySet<string>;
}

const EMPTY_SELECTION: SelectionState = { anchor: null, paths: emptyPathSet() };

function rangeBetween(rows: FileTreeRowData[], from: string, to: string): Set<string> | null {
  const start = rows.findIndex((row) => row.path === from);
  const end = rows.findIndex((row) => row.path === to);
  if (start < 0 || end < 0) return null;
  const [low, high] = start <= end ? [start, end] : [end, start];
  return new Set(rows.slice(low, high + 1).map((row) => row.path));
}

function toggled(paths: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(paths);
  if (!next.delete(path)) next.add(path);
  return next;
}

/**
 * The selection is only ever what the user picked — clicks and shift-arrows go through `selectRow`.
 * The focus ring is separate state: `useActiveRowPath` can move it onto a survivor after a batch
 * removes rows, and that must not silently select anything. `pathsFor` falls back to the row it is
 * asked about, so a verb still works on the focused row when nothing is selected.
 */
export function useFileTreeSelection(
  navigableRows: FileTreeRowData[],
  rootPath: string,
): FileTreeSelection {
  const [state, setState] = useState<SelectionState>(EMPTY_SELECTION);

  // Paths are root-relative, and the tree does not remount when the pane changes. Without this a
  // selection made in one worktree would re-bind to identically named files in the next one, and a
  // batch delete would take the wrong copies.
  useEffect(() => {
    setState(EMPTY_SELECTION);
  }, [rootPath]);

  // A selected row can disappear under a reload, a collapse, or a move; keeping its path would let
  // a later batch operation act on something the user can no longer see.
  useEffect(() => {
    setState((current) => {
      if (current.paths.size === 0) return current;
      const visible = new Set(navigableRows.map((row) => row.path));
      const pruned = [...current.paths].filter((path) => visible.has(path));
      if (pruned.length === current.paths.size) return current;
      return {
        anchor: current.anchor && visible.has(current.anchor) ? current.anchor : null,
        paths: new Set(pruned),
      };
    });
  }, [navigableRows]);

  const selectRow = useCallback((path: string, modifiers: SelectionModifiers) => {
    setState((current) => {
      if (modifiers.extend && current.anchor) {
        const range = rangeBetween(navigableRows, current.anchor, path);
        if (range) return { anchor: current.anchor, paths: range };
      }
      if (modifiers.toggle) {
        return { anchor: path, paths: toggled(current.paths, path) };
      }
      return { anchor: path, paths: new Set([path]) };
    });
  }, [navigableRows]);

  const orderedPaths = useMemo(
    () => navigableRows.filter((row) => state.paths.has(row.path)).map((row) => row.path),
    [navigableRows, state.paths],
  );

  const pathsFor = useCallback(
    (path: string) => (state.paths.has(path) && orderedPaths.length > 0 ? orderedPaths : [path]),
    [orderedPaths, state.paths],
  );

  return useMemo(
    () => ({ pathsFor, selectRow, selectedPaths: state.paths }),
    [pathsFor, selectRow, state.paths],
  );
}
