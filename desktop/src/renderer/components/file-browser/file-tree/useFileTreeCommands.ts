import { useMemo } from 'react';
import { normalizeOperationPaths, parentDir } from '../../../../shared/filePolicy';
import type { FileEntry } from '../../../../shared/ipc-types';
import { toFileEntry, type FileTreeRowData } from './fileTreeModel';
import type { FileTreeMutations } from './useFileTreeMutations';
import type { FileTreeSelection } from './useFileTreeSelection';

/**
 * The verbs a row can be the subject of. Each one resolves the row to the paths the user actually
 * means — the whole selection when the row is part of it — so multi-select needs no special cases
 * at the call sites.
 */
export interface FileTreeCommands {
  clearClipboard: () => void;
  copy: (path: string) => void;
  cut: (path: string) => void;
  duplicate: (path: string) => void;
  paste: (destDir: string) => void;
  requestDelete: (path: string) => void;
  targetCount: (path: string) => number;
  undo: () => void;
}

export function useFileTreeCommands(
  mutations: FileTreeMutations,
  selection: FileTreeSelection,
  navigableRows: FileTreeRowData[],
  clearClipboard: () => void,
): FileTreeCommands {
  const rowsByPath = useMemo(
    () => new Map(navigableRows.map((row) => [row.path, row])),
    [navigableRows],
  );

  return useMemo(() => {
    // Trashing a folder takes its children with it, so a selection holding both would report a
    // spurious ENOENT for the child. Every other batch verb normalizes through `moveEntries`.
    const targetsFor = (path: string): string[] => normalizeOperationPaths(selection.pathsFor(path));

    const entriesFor = (path: string): FileEntry[] => targetsFor(path)
      .map((selected) => rowsByPath.get(selected))
      .filter((row): row is FileTreeRowData => row !== undefined)
      .map(toFileEntry);

    return {
      clearClipboard,
      copy: (path) => mutations.setClipboard('copy', selection.pathsFor(path)),
      cut: (path) => mutations.setClipboard('cut', selection.pathsFor(path)),
      duplicate: (path) => {
        // A duplicate lands beside its original, and one `FILE_MOVE` has one destination, so a
        // selection spanning several folders duplicates only the part sitting next to the row
        // the user acted on.
        const destDir = parentDir(path);
        const targets = selection.pathsFor(path).filter((target) => parentDir(target) === destDir);
        void mutations.moveEntries(targets, destDir, 'copy');
      },
      paste: (destDir) => { void mutations.pasteInto(destDir); },
      requestDelete: (path) => mutations.requestDelete(entriesFor(path)),
      targetCount: (path) => targetsFor(path).length,
      undo: () => { void mutations.undoLastMove(); },
    };
  }, [clearClipboard, mutations, rowsByPath, selection]);
}
