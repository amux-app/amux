import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isSelfOrDescendant,
  isValidEntryName,
  normalizeOperationPaths,
  parentDir,
} from '../../../../shared/filePolicy';
import type { FileEntry } from '../../../../shared/ipc-types';
import { copyFile, createDir, createFile, deleteFile, moveFiles, renameFile } from '../../../api/file.api';
import { clipboardWrite } from '../../../api/system.api';
import { useNotificationStore } from '../../../stores';
import {
  useFileBrowserStore,
  type FileClipboard,
  type FileMoveRemap,
} from '../../../stores/file-browser.store';
import { groupUndoMoves, useFileUndoStore } from '../../../stores/file-undo.store';
import { useWorkspaceTabsStore } from '../../../stores/workspace-tabs.store';
import {
  collectReloadDirs,
  pluralizeItems,
  settledResults,
  undoableResults,
  summarizeMove,
} from './fileMoveOrchestration';
import { decideDrop, type MoveMode } from './fileTreeDropPolicy';

const INVALID_NAME_MESSAGE = 'Name cannot contain slashes or path segments';
const MOVE_FAILED_MESSAGE = 'The move could not be completed';
const DELETE_FAILED_MESSAGE = 'Some items could not be moved to Trash';
const UNDO_FAILED_MESSAGE = 'Nothing could be moved back';
const NO_PENDING_DELETE: readonly FileEntry[] = Object.freeze([]);
const NO_MOVES: readonly FileMoveRemap[] = Object.freeze([]);

interface UndoRunner {
  rootPath: string;
  run: () => Promise<void>;
}
const PASTE_INTO_SELF_MESSAGE = 'A folder cannot be pasted into itself';
const FLUSH_REFUSED_MESSAGE =
  'The open file could not be saved, so nothing was moved. Resolve the conflict in the editor and try again.';

function movesOpenFile(rootPath: string, sourcePaths: readonly string[]): boolean {
  const viewingFile = useFileBrowserStore.getState().viewingFile;
  if (viewingFile?.rootPath !== rootPath) return false;
  return sourcePaths.some((source) => isSelfOrDescendant(source, viewingFile.relativePath));
}

interface MoveOptions {
  /** Undo replays a move; recording it again would make the stack cycle forever. */
  recordUndo?: boolean;
  /** Undo reports one aggregate result instead of one toast per restored parent directory. */
  silent?: boolean;
}

export interface FileTreeMutations {
  cancelDelete: () => void;
  confirmDelete: (entries: readonly FileEntry[]) => Promise<void>;
  copyPath: (entry: FileEntry) => void;
  copyRootPath: () => void;
  create: (type: 'file' | 'folder', dirPath: string, name: string) => Promise<boolean>;
  /** Resolves the entries that reached their destination, as `{ from, to }` pairs. */
  moveEntries: (
    paths: string[],
    destDir: string,
    mode: MoveMode,
    options?: MoveOptions,
  ) => Promise<readonly FileMoveRemap[]>;
  pasteInto: (destDir: string) => Promise<void>;
  pendingDelete: readonly FileEntry[];
  renameEntry: (entry: FileEntry, newName: string) => Promise<void>;
  requestDelete: (entries: readonly FileEntry[]) => void;
  setClipboard: (mode: FileClipboard['mode'], paths: string[]) => void;
  undoLastMove: () => Promise<void>;
}

export function useFileTreeMutations(rootPath: string): FileTreeMutations {
  const loadDir = useFileBrowserStore((s) => s.loadDir);
  const addToast = useNotificationStore((s) => s.addToast);
  const [pendingDelete, setPendingDelete] = useState<readonly FileEntry[]>(NO_PENDING_DELETE);
  const moveInFlightRef = useRef(false);
  const undoInFlightRef = useRef(false);
  const undoRequestedForRef = useRef<string | null>(null);
  const undoRunnerRef = useRef<UndoRunner | null>(null);

  const drainQueuedUndo = useCallback(() => {
    const requestedFor = undoRequestedForRef.current;
    undoRequestedForRef.current = null;
    const runner = undoRunnerRef.current;
    if (requestedFor === null || runner?.rootPath !== requestedFor) return;
    void runner.run();
  }, []);

  const create = useCallback(async (type: 'file' | 'folder', dirPath: string, name: string) => {
    if (!isValidEntryName(name)) {
      addToast(INVALID_NAME_MESSAGE, 'error');
      return false;
    }
    const relativePath = dirPath ? `${dirPath}/${name}` : name;
    const result = await (type === 'folder' ? createDir : createFile)({ rootPath, relativePath });
    if (result.success) {
      await loadDir(rootPath, dirPath || '');
    } else {
      addToast(result.error ?? `Failed to create ${type}`, 'error');
    }
    return true;
  }, [addToast, loadDir, rootPath]);

  const renameEntry = useCallback(async (entry: FileEntry, newName: string) => {
    if (!isValidEntryName(newName)) {
      addToast(INVALID_NAME_MESSAGE, 'error');
      return;
    }
    const dir = parentDir(entry.path);
    const newPath = dir ? `${dir}/${newName}` : newName;
    const result = await renameFile({ rootPath, oldPath: entry.path, newPath });
    if (result.success) {
      await loadDir(rootPath, dir);
    } else {
      addToast(result.error ?? 'Failed to rename', 'error');
    }
  }, [addToast, loadDir, rootPath]);

  const confirmDelete = useCallback(async (entries: readonly FileEntry[]) => {
    setPendingDelete(NO_PENDING_DELETE);
    if (entries.length === 0) return;

    const failures: string[] = [];
    const parents = new Set<string>();
    for (const entry of entries) {
      const result = await deleteFile({ rootPath, relativePath: entry.path });
      if (result.success) parents.add(parentDir(entry.path));
      else failures.push(`${entry.path}: ${result.error ?? 'Failed to delete'}`);
    }

    await Promise.all([...parents].map((dir) => loadDir(rootPath, dir)));
    if (failures.length > 0) {
      addToast(DELETE_FAILED_MESSAGE, 'error', { detail: failures.join('\n') });
    }
  }, [addToast, loadDir, rootPath]);

  const setClipboard = useCallback((mode: FileClipboard['mode'], paths: string[]) => {
    useFileBrowserStore.getState().setClipboard({ mode, paths, rootPath });
  }, [rootPath]);

  /**
   * `FILE_COPY` authorizes a source and a destination root independently, so a cross-root copy stays
   * on that channel. `FILE_MOVE` is single-root by design, and a cut clipboard is dropped whenever
   * the root changes, so a cross-root cut can never reach here.
   */
  const copyAcrossRoots = useCallback(async (clipboard: FileClipboard, destDir: string) => {
    const failures: string[] = [];
    for (const sourcePath of normalizeOperationPaths(clipboard.paths)) {
      const result = await copyFile({
        destDir,
        destRootPath: rootPath,
        sourcePath,
        sourceRootPath: clipboard.rootPath,
      });
      if (!result.success) failures.push(result.error ?? sourcePath);
    }

    await loadDir(rootPath, destDir);
    if (failures.length > 0) {
      addToast('Some items could not be copied', 'error', { detail: failures.join('\n') });
    }
  }, [addToast, loadDir, rootPath]);

  const applyMoveResponse = useCallback(async (
    sourcePaths: string[],
    destDir: string,
    mode: MoveMode,
    response: Awaited<ReturnType<typeof moveFiles>>,
    options: MoveOptions,
  ) => {
    const store = useFileBrowserStore.getState();
    const moves = response.error ? [] : settledResults(response);

    if (mode === 'move' && moves.length > 0) {
      store.remapAfterMove(rootPath, moves);
      for (const { from, to } of moves) {
        await useWorkspaceTabsStore.getState().remapFilePath(rootPath, from, to);
      }
      if (options.recordUndo !== false) {
        useFileUndoStore.getState().pushMove({ moves: undoableResults(response), rootPath });
      }
    }

    const expandedDirs = useFileBrowserStore.getState().expandedDirs[rootPath] ?? new Set<string>();
    const dirs = collectReloadDirs(destDir, sourcePaths, moves, expandedDirs);
    await Promise.all(dirs.map((dir) => loadDir(rootPath, dir)));

    if (!options.silent) {
      const summary = summarizeMove(response, mode);
      addToast(summary.message, summary.severity, { detail: summary.detail });
    }
    // Succeeded only: a `partial` left the source in place, so counting it would let an undo that
    // produced a duplicate report itself as a clean restore, and would let a paste that never
    // vacated its source consume the cut clipboard.
    return undoableResults(response);
  }, [addToast, loadDir, rootPath]);

  const moveEntries = useCallback(async (
    paths: string[],
    destDir: string,
    mode: MoveMode,
    options: MoveOptions = {},
  ) => {
    const store = useFileBrowserStore.getState();
    if (moveInFlightRef.current) return NO_MOVES;

    // An entry already sitting in the destination is not a failure to report, it is nothing to do.
    const sourcePaths = normalizeOperationPaths(paths)
      .filter((path) => mode === 'copy' || parentDir(path) !== destDir);
    if (sourcePaths.length === 0) return NO_MOVES;

    // Claimed before the first await, so two rapid invocations cannot both pass the guard. This is
    // only concurrency control; the watcher-suppression window is published separately below,
    // because a refused or slow editor flush must not make a genuine deletion look like our move.
    moveInFlightRef.current = true;

    try {
      if (movesOpenFile(rootPath, sourcePaths) && !await store.flushPendingFileSave()) {
        addToast(FLUSH_REFUSED_MESSAGE, 'error');
        return NO_MOVES;
      }
      store.setActiveMove({ mode, paths: sourcePaths, rootPath });
      const response = await moveFiles({ destDir, mode, rootPath, sourcePaths });
      return await applyMoveResponse(sourcePaths, destDir, mode, response, options);
    } catch (error) {
      // Callers fire this without awaiting, so a transport failure has to surface here or nowhere.
      addToast(error instanceof Error ? error.message : MOVE_FAILED_MESSAGE, 'error');
      return NO_MOVES;
    } finally {
      useFileBrowserStore.getState().setActiveMove(null);
      moveInFlightRef.current = false;
      // Only a move the user asked for can release a held undo. Undo issues one of these per
      // original parent directory, and letting those release it would start a second undo while
      // the first was still walking its remaining groups.
      if (!undoInFlightRef.current) drainQueuedUndo();
    }
  }, [addToast, applyMoveResponse, drainQueuedUndo, rootPath]);

  const pasteInto = useCallback(async (destDir: string) => {
    const clipboard = useFileBrowserStore.getState().clipboard;
    if (!clipboard) return;

    if (clipboard.rootPath !== rootPath) {
      await copyAcrossRoots(clipboard, destDir);
      return;
    }

    const mode = clipboard.mode === 'cut' ? 'move' : 'copy';
    const decision = decideDrop({ paths: clipboard.paths, rootPath }, destDir, rootPath, mode);
    if (!decision.allowed) {
      // Pasting where the entry already lives is a no-op worth no words; pasting a folder into
      // itself is a mistake, and staying silent about it just looks broken.
      if (decision.reason !== 'same-parent') addToast(PASTE_INTO_SELF_MESSAGE, 'error');
      return;
    }

    // Only a paste that actually landed consumes the clipboard; a rejected or failed one is retryable.
    const moved = await moveEntries(clipboard.paths, destDir, mode);
    if (moved.length > 0 && clipboard.mode === 'cut') useFileBrowserStore.getState().clearClipboard();
  }, [addToast, copyAcrossRoots, moveEntries, rootPath]);

  const undoLastMove = useCallback(async (): Promise<void> => {
    // The filesystem side of a move finishes before its remap and reloads do, so the user can see
    // the result and press the shortcut while the guard is still up. Dropping it there would lose a
    // valid command, so exactly one undo is held and replayed once the tree is idle. Repeated
    // presses re-arm the same flag rather than queueing a chain.
    if (moveInFlightRef.current || undoInFlightRef.current) {
      undoRequestedForRef.current = rootPath;
      return;
    }

    const undoStore = useFileUndoStore.getState();
    const entry = undoStore.popMove(rootPath);
    if (!entry) return;

    undoInFlightRef.current = true;
    const restoredSources = new Set<string>();
    try {
      for (const group of groupUndoMoves(entry.moves)) {
        const done = await moveEntries(group.sourcePaths, group.destDir, 'move', {
          recordUndo: false,
          silent: true,
        });
        // An inverse move reports `from` as the path the entry had moved the item *to*.
        for (const move of done) restoredSources.add(move.from);
      }
    } finally {
      undoInFlightRef.current = false;
    }

    // Whatever could not be moved back is still an accurate record, so it goes back on the stack
    // rather than vanishing — a later ⌘Z retries exactly the part that is still displaced.
    const unresolved = entry.moves.filter((move) => !restoredSources.has(move.to));
    if (unresolved.length > 0) undoStore.pushMove({ moves: unresolved, rootPath });

    const restored = entry.moves.length - unresolved.length;
    if (restored === entry.moves.length) {
      addToast(`Undid move of ${pluralizeItems(restored)}`, 'success');
    } else if (restored === 0) {
      addToast(UNDO_FAILED_MESSAGE, 'error');
    } else {
      addToast(`Undid ${restored} of ${entry.moves.length} moved items`, 'warning');
    }

    // A press that arrived while this undo was running runs now, in order, never alongside it.
    drainQueuedUndo();
  }, [addToast, drainQueuedUndo, moveEntries, rootPath]);

  // The tree is reused when the pane changes — `LazyFileTree` gives it no key — so the runner is
  // republished per root and torn down with the effect. A held request records the root it was made
  // for, and the drain runs it only when the installed runner still belongs to that same root.
  useEffect(() => {
    undoRunnerRef.current = { rootPath, run: undoLastMove };
    return () => { undoRunnerRef.current = null; };
  }, [rootPath, undoLastMove]);

  const copyPath = useCallback((entry: FileEntry) => {
    clipboardWrite(`${rootPath}/${entry.path}`);
  }, [rootPath]);

  const copyRootPath = useCallback(() => {
    clipboardWrite(rootPath);
  }, [rootPath]);

  const cancelDelete = useCallback(() => setPendingDelete(NO_PENDING_DELETE), []);

  // Every callback here is already stable; without this the object around them still changed on
  // each render, which defeated every `useMemo` downstream that depends on it.
  return useMemo(() => ({
    cancelDelete,
    confirmDelete,
    copyPath,
    copyRootPath,
    create,
    moveEntries,
    pasteInto,
    pendingDelete,
    renameEntry,
    requestDelete: setPendingDelete,
    setClipboard,
    undoLastMove,
  }), [
    cancelDelete, confirmDelete, copyPath, copyRootPath, create, moveEntries, pasteInto,
    pendingDelete, renameEntry, setClipboard, undoLastMove,
  ]);
}
