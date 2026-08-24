import * as ContextMenu from '@radix-ui/react-context-menu';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Copy } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { FileEntry } from '../../../../shared/ipc-types';
import { cn } from '../../../lib/cn';
import { resolveRootFolderIcon } from '../../../lib/fileIcons';
import { useFileBrowserStore } from '../../../stores/file-browser.store';
import { useUndoDepth } from '../../../stores/file-undo.store';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { FileIconSprite, FileTypeIcon } from '../FileTypeIcon';
import { FileTreeContextMenu, type FileTreeContextMenuTarget } from './FileTreeMenus';
import type { MoveMode } from './fileTreeDropPolicy';
import {
  buildVisibleFileTreeRows,
  DROP_TARGET_CLASS,
  emptyPathSet,
  ROW_ICON_CLASS,
  type CreatingState,
  type FileTreeRowData,
} from './fileTreeModel';
import { TreeRow } from './TreeRow';
import { ROOT_TARGET_ID, useFileTreeDnd, type DragHandlers } from './useFileTreeDnd';
import { useFileTreeCommands } from './useFileTreeCommands';
import { useActiveRowPath, useFileTreeKeyboard } from './useFileTreeKeyboard';
import { useFileTreeMutations } from './useFileTreeMutations';
import { useFileTreeRowGesture, type RowPointerProps } from './useFileTreeRowGesture';
import { useFileTreeSelection, type SelectionModifiers } from './useFileTreeSelection';

const FALLBACK_VIEWPORT_HEIGHT = 480;
const FALLBACK_OVERSCAN_ROWS = 8;
const ROW_HEIGHT = 26;
const ROOT_ICON = resolveRootFolderIcon(true);
const EMPTY_PATHS = emptyPathSet();

function deleteDialogTitle(entries: readonly FileEntry[]): string {
  if (entries.length > 1) return `Move ${entries.length} items to Trash?`;
  return entries[0]?.isDirectory ? 'Move folder to Trash?' : 'Move file to Trash?';
}

function deleteDialogMessage(entries: readonly FileEntry[]): string {
  if (entries.length === 0) return '';
  if (entries.length > 1) {
    return `${entries.map((entry) => entry.path).join(', ')} will be moved to the system Trash.`;
  }
  const [entry] = entries;
  const contents = entry.isDirectory ? ' (and all of its contents)' : '';
  return `${entry.path}${contents} will be moved to the system Trash.`;
}

function getRootLabel(rootPath: string): string {
  const trimmed = rootPath.replace(/\/+$/, '');
  const segments = trimmed.split('/');
  return segments.at(-1) || rootPath;
}

export interface FileTreeProps {
  rootPath: string;
  onFileClick?: (relativePath: string) => void;
}

interface FileTreeContextValue {
  activePath: string | null;
  cutPaths: ReadonlySet<string>;
  draggedPaths: ReadonlySet<string>;
  dropTargetRowId: string | null;
  folderColors: Record<string, string>;
  rowDragProps: (row: FileTreeRowData) => DragHandlers;
  getRowDomId: (path: string) => string;
  rootPath: string;
  renamingPath: string | null;
  setRenamingPath: (path: string | null) => void;
  setCreating: (state: CreatingState | null) => void;
  onCreate: (type: 'file' | 'folder', dirPath: string, name: string) => void;
  onEntryContextMenu: (entry: FileTreeRowData) => void;
  onRenameFile: (entry: FileEntry, newName: string) => void;
  onCopyPath: (entry: FileEntry) => void;
  onFileClick?: (relativePath: string) => void;
  onFocusTree: () => void;
  onRowAnchor: (path: string) => void;
  rowPointerProps: (path: string) => RowPointerProps;
  onSetActivePath: (path: string) => void;
  onToggleDir: (dirPath: string) => void;
  selectedPaths: ReadonlySet<string>;
  viewingFilePath: string | null;
}

const FileTreeContext = createContext<FileTreeContextValue | null>(null);

export function useFileTreeContext(): FileTreeContextValue {
  const context = useContext(FileTreeContext);
  if (!context) {
    throw new Error('FileTree row rendered outside FileTree context');
  }
  return context;
}

export function FileTree({ rootPath, onFileClick }: FileTreeProps) {
  const toggleDir = useFileBrowserStore((s) => s.toggleDir);
  const trees = useFileBrowserStore((s) => s.trees);
  const clipboard = useFileBrowserStore((s) => s.clipboard);
  const expandedDirs = useFileBrowserStore((s) => s.expandedDirs[rootPath]);
  const folderColors = useFileBrowserStore((s) => s.folderColors);
  const viewingFilePath = useFileBrowserStore((s) =>
    s.viewingFile?.rootPath === rootPath ? s.viewingFile.relativePath : null,
  );
  const mutations = useFileTreeMutations(rootPath);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const storedCreating = useFileBrowserStore((s) => s.creating);
  const creating = storedCreating?.rootPath === rootPath ? storedCreating : null;
  const [contextMenuTarget, setContextMenuTarget] = useState<FileTreeContextMenuTarget>({ kind: 'root' });

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const treeInstanceId = useId();
  const setCreating = useCallback(
    (state: CreatingState | null) => {
      useFileBrowserStore.getState().setCreating(state ? { ...state, rootPath } : null);
    },
    [rootPath],
  );
  const cutPaths = useMemo(
    () => (clipboard?.mode === 'cut' && clipboard.rootPath === rootPath
      ? new Set(clipboard.paths)
      : EMPTY_PATHS),
    [clipboard, rootPath],
  );

  const rootLabel = getRootLabel(rootPath);
  const visibleRows = useMemo(
    () => buildVisibleFileTreeRows(rootPath, trees, expandedDirs, creating),
    [rootPath, trees, expandedDirs, creating],
  );
  const navigableRows = useMemo(
    () => visibleRows.filter((row) => !row.isPlaceholder),
    [visibleRows],
  );
  const [activePath, setActivePath] = useActiveRowPath(navigableRows, viewingFilePath);
  const selection = useFileTreeSelection(navigableRows, rootPath);
  const rowVirtualizer = useVirtualizer({
    count: visibleRows.length,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => visibleRows[index]?.id ?? index,
    getScrollElement: () => scrollRef.current,
    initialRect: { height: FALLBACK_VIEWPORT_HEIGHT, width: 360 },
    overscan: FALLBACK_OVERSCAN_ROWS,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const fallbackVirtualRows = useMemo(() => {
    if (virtualRows.length > 0 || visibleRows.length === 0) {
      return [];
    }
    const visibleCount = Math.ceil(FALLBACK_VIEWPORT_HEIGHT / ROW_HEIGHT) + FALLBACK_OVERSCAN_ROWS;
    const count = Math.min(visibleRows.length, visibleCount);
    return Array.from({ length: count }, (_, index) => ({
      index,
      key: visibleRows[index]?.id ?? index,
      size: ROW_HEIGHT,
      start: index * ROW_HEIGHT,
    }));
  }, [virtualRows.length, visibleRows]);
  const renderedRows = virtualRows.length > 0 ? virtualRows : fallbackVirtualRows;
  const treeHeight = Math.max(rowVirtualizer.getTotalSize(), visibleRows.length * ROW_HEIGHT);

  const getRowDomId = useCallback(
    (path: string) => `${treeInstanceId}-file-tree-row-${encodeURIComponent(path)}`,
    [treeInstanceId],
  );

  useEffect(() => {
    if (creating?.dir && !expandedDirs?.has(creating.dir)) {
      toggleDir(rootPath, creating.dir);
    }
  }, [creating, expandedDirs, rootPath, toggleDir]);

  const { create, renameEntry } = mutations;

  const handleCreate = useCallback(async (type: 'file' | 'folder', dirPath: string, name: string) => {
    if (await create(type, dirPath, name)) setCreating(null);
  }, [create, setCreating]);

  const handleRenameFile = useCallback(async (entry: FileEntry, newName: string) => {
    await renameEntry(entry, newName);
    setRenamingPath(null);
  }, [renameEntry]);

  const handleEntryContextMenu = useCallback((entry: FileTreeRowData) => {
    setContextMenuTarget({ kind: 'entry', entry });
  }, []);

  const clearClipboard = useFileBrowserStore((s) => s.clearClipboard);
  const undoDepth = useUndoDepth(rootPath);

  const handleToggle = useCallback((dirPath: string) => {
    toggleDir(rootPath, dirPath);
  }, [rootPath, toggleDir]);

  const focusRowAt = useCallback((index: number, extendSelection = false) => {
    const boundedIndex = Math.max(0, Math.min(navigableRows.length - 1, index));
    const row = navigableRows[boundedIndex];
    if (!row) return;
    setActivePath(row.path);
    selection.selectRow(row.path, { extend: extendSelection, toggle: false });
    const visibleIndex = visibleRows.findIndex((visibleRow) => visibleRow.id === row.id);
    if (visibleIndex >= 0) rowVirtualizer.scrollToIndex(visibleIndex, { align: 'auto' });
  }, [navigableRows, rowVirtualizer, selection, setActivePath, visibleRows]);

  const isExpanded = useCallback(
    (dirPath: string) => expandedDirs?.has(dirPath) ?? false,
    [expandedDirs],
  );
  const { moveEntries } = mutations;
  const handleMove = useCallback((paths: string[], destDir: string, mode: MoveMode) => {
    void moveEntries(paths, destDir, mode);
  }, [moveEntries]);

  const focusTree = useCallback(() => scrollRef.current?.focus(), []);

  const handleRowSelect = useCallback((path: string, modifiers: SelectionModifiers) => {
    // Pressing a row is also what focuses the tree, so the keyboard verbs work straight afterwards.
    focusTree();
    // Focusing a row the user is removing would leave the ring on something they just dropped.
    const deselecting = modifiers.toggle && selection.selectedPaths.has(path);
    if (!deselecting) setActivePath(path);
    selection.selectRow(path, modifiers);
  }, [focusTree, selection, setActivePath]);

  const isRowSelected = useCallback(
    (path: string) => selection.selectedPaths.has(path),
    [selection.selectedPaths],
  );
  const gesture = useFileTreeRowGesture({ isSelected: isRowSelected, onSelect: handleRowSelect });

  // Shared by dragstart and the context menu: acting on a row outside the selection must make the
  // highlight describe what is about to happen, rather than leaving the old selection tinted.
  const handleRowAnchor = useCallback((path: string) => {
    gesture.onDragStarted();
    if (selection.selectedPaths.has(path)) return;
    selection.selectRow(path, { extend: false, toggle: false });
    setActivePath(path);
  }, [gesture, selection, setActivePath]);

  const dnd = useFileTreeDnd({
    isDragSuppressed: gesture.isDragSuppressed,
    isExpanded,
    onDragAnchor: handleRowAnchor,
    onExpandDir: handleToggle,
    onMove: handleMove,
    pathsFor: selection.pathsFor,
    rootPath,
    scrollRef,
  });

  // Both pieces of state outlive this component, so the root they belong to has to be reconciled
  // here. A cut clipboard is dropped when the root changes, which is why a cross-root cut can never
  // be attempted; a copy clipboard survives, and that is what makes cross-root paste work. An
  // inline create belonging to another root is abandoned rather than resurrected on the way back.
  useEffect(() => {
    const state = useFileBrowserStore.getState();
    if (state.clipboard?.mode === 'cut' && state.clipboard.rootPath !== rootPath) {
      state.clearClipboard();
    }
    if (state.creating && state.creating.rootPath !== rootPath) {
      state.setCreating(null);
    }
  }, [rootPath]);

  const commands = useFileTreeCommands(mutations, selection, navigableRows, clearClipboard);

  const handleTreeKeyDown = useFileTreeKeyboard({
    activePath,
    focusRowAt,
    navigableRows,
    onClearClipboard: commands.clearClipboard,
    onCopy: commands.copy,
    onCut: commands.cut,
    onDelete: commands.requestDelete,
    onDuplicate: commands.duplicate,
    onFileClick,
    onPaste: commands.paste,
    onRename: setRenamingPath,
    onToggleDir: handleToggle,
    onUndo: commands.undo,
  });

  const contextValue = useMemo<FileTreeContextValue>(() => ({
    activePath,
    cutPaths,
    draggedPaths: dnd.draggedPaths,
    dropTargetRowId: dnd.dropTargetRowId,
    folderColors,
    rowDragProps: dnd.rowDragProps,
    getRowDomId,
    rootPath,
    renamingPath,
    setRenamingPath,
    setCreating,
    onCreate: handleCreate,
    onEntryContextMenu: handleEntryContextMenu,
    onRenameFile: handleRenameFile,
    onCopyPath: mutations.copyPath,
    onFileClick,
    onFocusTree: focusTree,
    onRowAnchor: handleRowAnchor,
    rowPointerProps: gesture.rowPointerProps,
    onSetActivePath: setActivePath,
    onToggleDir: handleToggle,
    selectedPaths: selection.selectedPaths,
    viewingFilePath,
  }), [
    activePath, cutPaths, dnd.draggedPaths, dnd.dropTargetRowId, dnd.rowDragProps, focusTree,
    folderColors, getRowDomId, rootPath, renamingPath, handleCreate, handleEntryContextMenu,
    handleRenameFile, handleRowAnchor, gesture.rowPointerProps, mutations.copyPath, onFileClick,
    selection.selectedPaths,
    setActivePath, setCreating, handleToggle, viewingFilePath,
  ]);

  const contextTargetCount = useMemo(
    () => (contextMenuTarget.kind === 'entry' ? commands.targetCount(contextMenuTarget.entry.path) : 1),
    [commands, contextMenuTarget],
  );

  const activeRow = navigableRows.find((row) => row.path === activePath);
  const activeRowIsRendered = activeRow
    ? renderedRows.some((virtualRow) => visibleRows[virtualRow.index]?.id === activeRow.id)
    : false;
  const pendingDelete = mutations.pendingDelete;
  const { confirmDelete } = mutations;

  // The dialog can sit open while an agent rewrites the worktree; only entries still present when
  // the user confirms are trashed, so a path that has since been replaced is left alone.
  const handleConfirmDelete = useCallback(() => {
    const visible = new Set(navigableRows.map((row) => row.path));
    return confirmDelete(pendingDelete.filter((entry) => visible.has(entry.path)));
  }, [confirmDelete, navigableRows, pendingDelete]);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          data-testid="file-tree"
          className="flex h-full flex-col text-[12px] select-none"
          onContextMenuCapture={() => setContextMenuTarget({ kind: 'root' })}
        >
          <FileIconSprite />
          <div
            {...dnd.containerDragProps}
            data-drop-target={dnd.dropTargetRowId === ROOT_TARGET_ID ? 'true' : undefined}
            className={cn(
              'group flex h-6.5 shrink-0 cursor-default items-center px-2 hover:bg-(--surface-raised)',
              dnd.dropTargetRowId === ROOT_TARGET_ID && DROP_TARGET_CLASS,
            )}
          >
            <FileTypeIcon className={ROW_ICON_CLASS} icon={ROOT_ICON} />
            <span className="min-w-0 flex-1 truncate font-medium text-(--text)">{rootLabel}</span>
            <button
              onClick={(e) => { e.stopPropagation(); mutations.copyRootPath(); }}
              aria-label="Copy root path"
              className="ml-1 shrink-0 rounded p-0.5 text-(--text-muted) opacity-0 transition-colors group-hover:opacity-100 focus:opacity-100 focus-visible:outline-2 focus-visible:outline-(--accent) hover:text-(--accent)"
              title="Copy root path"
            >
              <Copy size={11} />
            </button>
          </div>

          <div
            {...dnd.containerDragProps}
            ref={scrollRef}
            aria-activedescendant={activeRow ? getRowDomId(activeRow.path) : undefined}
            aria-label={`Files in ${rootLabel}`}
            aria-multiselectable="true"
            role="tree"
            tabIndex={0}
            onKeyDown={handleTreeKeyDown}
            className="min-h-0 flex-1 overflow-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent)"
            style={{ contain: 'strict', overflowAnchor: 'none' }}
          >
            {activeRow && !activeRowIsRendered && (
              <div
                id={getRowDomId(activeRow.path)}
                aria-current={viewingFilePath === activeRow.path ? 'page' : undefined}
                aria-expanded={activeRow.isDirectory ? activeRow.isOpen : undefined}
                aria-label={activeRow.name}
                aria-level={activeRow.depth + 1}
                aria-selected={selection.selectedPaths.has(activeRow.path)}
                className="sr-only"
                role="treeitem"
              />
            )}
            <FileTreeContext.Provider value={contextValue}>
              <div style={{ height: treeHeight, position: 'relative', width: '100%' }}>
                {renderedRows.map((virtualRow) => {
                  const row = visibleRows[virtualRow.index];
                  if (!row) return null;
                  return (
                    <TreeRow
                      key={virtualRow.key}
                      row={row}
                      style={{
                        height: virtualRow.size,
                        left: 0,
                        position: 'absolute',
                        top: 0,
                        transform: `translateY(${virtualRow.start}px)`,
                        width: '100%',
                      }}
                    />
                  );
                })}
              </div>
            </FileTreeContext.Provider>
          </div>
        </div>
      </ContextMenu.Trigger>

      <FileTreeContextMenu
        canPaste={clipboard !== null}
        canUndo={undoDepth > 0}
        folderColors={folderColors}
        onCopy={commands.copy}
        onCopyPath={mutations.copyPath}
        onCopyRootPath={mutations.copyRootPath}
        onCreate={(dir, type) => setCreating({ dir, type })}
        onCut={commands.cut}
        onDelete={commands.requestDelete}
        onDuplicate={commands.duplicate}
        onPaste={commands.paste}
        onRename={setRenamingPath}
        onUndo={commands.undo}
        preventAutoFocus={creating !== null || renamingPath !== null}
        rootPath={rootPath}
        target={contextMenuTarget}
        targetCount={contextTargetCount}
      />

      <ConfirmDialog
        open={pendingDelete.length > 0}
        title={deleteDialogTitle(pendingDelete)}
        message={deleteDialogMessage(pendingDelete)}
        confirmLabel="Move to Trash"
        cancelLabel="Cancel"
        danger
        onConfirm={handleConfirmDelete}
        onCancel={mutations.cancelDelete}
      />
    </ContextMenu.Root>
  );
}
