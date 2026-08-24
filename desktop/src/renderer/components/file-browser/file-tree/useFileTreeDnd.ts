import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type RefObject } from 'react';
import {
  decideDrop,
  resolveDropDir,
  type DragPayload,
  type MoveMode,
} from './fileTreeDropPolicy';
import { emptyPathSet, type FileTreeRowData } from './fileTreeModel';

const AUTO_SCROLL_EDGE_PX = 32;
const AUTO_SCROLL_STEP_PX = 8;
const SPRING_OPEN_MS = 600;
const DRAG_IMAGE_OFFSET_PX = 12;

/** Written for other drop targets to recognise; the tree itself reads the payload from a ref. */
const FILE_PATHS_MIME = 'application/x-aumx-file-paths';

export interface DragHandlers {
  draggable?: boolean;
  onDragEnd: (event: DragEvent<HTMLElement>) => void;
  onDragEnter: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragStart?: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}

export interface FileTreeDnd {
  containerDragProps: DragHandlers;
  draggedPaths: ReadonlySet<string>;
  dropTargetRowId: string | null;
  rowDragProps: (row: FileTreeRowData) => DragHandlers;
}

export interface FileTreeDndOptions {
  isExpanded: (dirPath: string) => boolean;
  onExpandDir: (dirPath: string) => void;
  onMove: (paths: string[], destDir: string, mode: MoveMode) => void;
  /** True only when the press removed the row from the selection, leaving the drag nothing to carry. */
  isDragSuppressed: () => boolean;
  /** Re-anchors the selection when a row outside it is grabbed, so the highlight matches the drag. */
  onDragAnchor: (path: string) => void;
  /** Dragging a selected row drags the whole selection; dragging any other row drags just it. */
  pathsFor: (path: string) => string[];
  rootPath: string;
  scrollRef: RefObject<HTMLDivElement | null>;
}

interface DropTarget {
  dir: string;
  rowId: string;
}

export const ROOT_TARGET_ID = '__file_tree_root__';
const EMPTY_PATHS = emptyPathSet();

/**
 * The native drag image is a snapshot of the grabbed row alone, which says nothing about a batch.
 * Inline styles rather than classes so the node renders correctly while detached from the tree.
 */
function createDragImage(paths: readonly string[]): HTMLElement {
  const node = document.createElement('div');
  node.textContent = paths.length === 1
    ? (paths[0].split('/').pop() ?? paths[0])
    : `${paths.length} items`;
  node.style.cssText = [
    'position:fixed',
    'top:-1000px',
    'left:-1000px',
    'padding:4px 10px',
    'border-radius:6px',
    'font-size:12px',
    'font-weight:500',
    'white-space:nowrap',
    'color:var(--accent-contrast)',
    'background:var(--accent)',
    'box-shadow:0 2px 8px rgba(0,0,0,0.35)',
  ].join(';');
  document.body.append(node);
  return node;
}

function readMode(event: DragEvent<HTMLElement>): MoveMode {
  return event.altKey || event.ctrlKey ? 'copy' : 'move';
}

function autoScrollDelta(container: HTMLDivElement, clientY: number): number {
  const rect = container.getBoundingClientRect();
  if (clientY < rect.top + AUTO_SCROLL_EDGE_PX) return -AUTO_SCROLL_STEP_PX;
  if (clientY > rect.bottom - AUTO_SCROLL_EDGE_PX) return AUTO_SCROLL_STEP_PX;
  return 0;
}

export function useFileTreeDnd(options: FileTreeDndOptions): FileTreeDnd {
  const {
    isDragSuppressed, isExpanded, onDragAnchor, onExpandDir, onMove, pathsFor, rootPath, scrollRef,
  } = options;

  const [draggedPaths, setDraggedPaths] = useState<ReadonlySet<string>>(EMPTY_PATHS);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  // The drag data store is protected outside dragstart/drop, and the source row may be unmounted by
  // the virtualizer, so the payload has to be held here for the whole gesture.
  const payloadRef = useRef<DragPayload | null>(null);
  const enterDepthRef = useRef(0);
  const springTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const scrollDeltaRef = useRef(0);
  const dragImageRef = useRef<HTMLElement | null>(null);

  const clearSpring = useCallback(() => {
    if (springTimerRef.current === null) return;
    clearTimeout(springTimerRef.current);
    springTimerRef.current = null;
  }, []);

  const stopAutoScroll = useCallback(() => {
    scrollDeltaRef.current = 0;
    if (scrollFrameRef.current === null) return;
    cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = null;
  }, []);

  const runAutoScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container || scrollDeltaRef.current === 0) {
      scrollFrameRef.current = null;
      return;
    }
    container.scrollTop += scrollDeltaRef.current;
    scrollFrameRef.current = requestAnimationFrame(runAutoScroll);
  }, [scrollRef]);

  const updateAutoScroll = useCallback((clientY: number) => {
    const container = scrollRef.current;
    if (!container) return;

    scrollDeltaRef.current = autoScrollDelta(container, clientY);
    if (scrollDeltaRef.current === 0) {
      stopAutoScroll();
      return;
    }
    scrollFrameRef.current ??= requestAnimationFrame(runAutoScroll);
  }, [runAutoScroll, scrollRef, stopAutoScroll]);

  const reset = useCallback(() => {
    dragImageRef.current?.remove();
    dragImageRef.current = null;
    payloadRef.current = null;
    enterDepthRef.current = 0;
    clearSpring();
    stopAutoScroll();
    setDraggedPaths(EMPTY_PATHS);
    setDropTarget(null);
  }, [clearSpring, stopAutoScroll]);

  useEffect(() => reset, [reset]);
  useEffect(() => { reset(); }, [reset, rootPath]);

  const handleDragOver = useCallback((
    event: DragEvent<HTMLElement>,
    row: FileTreeRowData | null,
  ) => {
    const payload = payloadRef.current;
    if (!payload) return;

    updateAutoScroll(event.clientY);
    const destDir = resolveDropDir(row);
    const decision = decideDrop(payload, destDir, rootPath, readMode(event));
    if (!decision.allowed) {
      event.dataTransfer.dropEffect = 'none';
      setDropTarget(null);
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = decision.mode;

    // `dragover` fires continuously while the pointer moves; only a genuine target change should
    // re-render the tree.
    const rowId = row?.id ?? ROOT_TARGET_ID;
    setDropTarget((current) => (
      current?.dir === destDir && current.rowId === rowId ? current : { dir: destDir, rowId }
    ));
  }, [rootPath, updateAutoScroll]);

  const handleDragEnter = useCallback((row: FileTreeRowData | null) => {
    enterDepthRef.current += 1;
    // Cleared first: moving onto a row that cannot spring must cancel the folder the pointer left,
    // or that folder expands under the cursor and the drop lands somewhere else entirely.
    clearSpring();
    if (!payloadRef.current || !row?.isDirectory || row.isOpen || isExpanded(row.path)) return;

    const dirPath = row.path;
    springTimerRef.current = setTimeout(() => {
      springTimerRef.current = null;
      onExpandDir(dirPath);
    }, SPRING_OPEN_MS);
  }, [clearSpring, isExpanded, onExpandDir]);

  const handleDragLeave = useCallback(() => {
    enterDepthRef.current -= 1;
    if (enterDepthRef.current > 0) return;
    enterDepthRef.current = 0;
    clearSpring();
    stopAutoScroll();
    setDropTarget(null);
  }, [clearSpring, stopAutoScroll]);

  const handleDrop = useCallback((event: DragEvent<HTMLElement>, row: FileTreeRowData | null) => {
    event.preventDefault();
    event.stopPropagation();

    const payload = payloadRef.current;
    const destDir = resolveDropDir(row);
    const mode = readMode(event);
    reset();
    if (!payload) return;

    const decision = decideDrop(payload, destDir, rootPath, mode);
    if (decision.allowed) onMove(payload.paths, destDir, decision.mode);
  }, [onMove, reset, rootPath]);

  // Row handlers stop propagation: the container is the root drop target, and letting a row event
  // bubble would immediately overwrite the row's decision with the root's.
  const rowDragProps = useCallback((row: FileTreeRowData): DragHandlers => ({
    draggable: !row.isPlaceholder,
    onDragEnd: reset,
    onDragEnter: (event) => {
      event.stopPropagation();
      handleDragEnter(row);
    },
    onDragLeave: (event) => {
      event.stopPropagation();
      handleDragLeave();
    },
    onDragOver: (event) => {
      event.stopPropagation();
      handleDragOver(event, row);
    },
    onDragStart: (event) => {
      if (isDragSuppressed()) {
        event.preventDefault();
        return;
      }
      onDragAnchor(row.path);
      const paths = pathsFor(row.path);
      const payload: DragPayload = { paths, rootPath };
      payloadRef.current = payload;
      event.dataTransfer.effectAllowed = 'copyMove';
      event.dataTransfer.setData(FILE_PATHS_MIME, JSON.stringify(payload));
      event.dataTransfer.setData('text/plain', paths.map((path) => `${rootPath}/${path}`).join('\n'));
      dragImageRef.current = createDragImage(paths);
      event.dataTransfer.setDragImage(dragImageRef.current, DRAG_IMAGE_OFFSET_PX, DRAG_IMAGE_OFFSET_PX);
      setDraggedPaths(new Set(paths));
    },
    onDrop: (event) => handleDrop(event, row),
  }), [
    handleDragEnter, handleDragLeave, handleDragOver, handleDrop, isDragSuppressed, onDragAnchor,
    pathsFor, reset, rootPath,
  ]);

  const containerDragProps = useMemo<DragHandlers>(() => ({
    onDragEnd: reset,
    onDragEnter: () => handleDragEnter(null),
    onDragLeave: handleDragLeave,
    onDragOver: (event) => handleDragOver(event, null),
    onDrop: (event) => handleDrop(event, null),
  }), [handleDragEnter, handleDragLeave, handleDragOver, handleDrop, reset]);

  return {
    containerDragProps,
    draggedPaths,
    dropTargetRowId: dropTarget?.rowId ?? null,
    rowDragProps,
  };
}
