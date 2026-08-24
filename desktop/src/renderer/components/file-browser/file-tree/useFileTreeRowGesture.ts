import { useCallback, useRef, type MouseEvent } from 'react';
import type { SelectionModifiers } from './useFileTreeSelection';

const PLAIN_SELECTION: SelectionModifiers = { extend: false, toggle: false };
const PRIMARY_BUTTON = 0;

export interface RowPointerProps {
  onMouseDown: (event: MouseEvent<HTMLElement>) => void;
  onMouseUp: (event: MouseEvent<HTMLElement>) => void;
}

export interface FileTreeRowGesture {
  /** True only when the press removed the row from the selection, leaving the drag nothing to carry. */
  isDragSuppressed: () => boolean;
  /** The press turned into a drag, so the selection it was holding open must survive. */
  onDragStarted: () => void;
  rowPointerProps: (path: string) => RowPointerProps;
}

export interface FileTreeRowGestureOptions {
  isSelected: (path: string) => boolean;
  onSelect: (path: string, modifiers: SelectionModifiers) => void;
}

/**
 * Rows are `draggable`, and Chromium turns a press into a `dragstart` as soon as the pointer moves
 * a pixel or two — which no hand avoids. A selection built in `click` therefore never happens for a
 * real shift-click. Selection runs on mousedown instead, the way every file manager does it, with
 * two consequences that fall out of the same rule:
 *
 * - a press that removes a row from the selection cancels the drag, since there is nothing coherent
 *   for it to carry;
 * - an unmodified press on an already-selected row defers its collapse to mouseup, so dragging a
 *   multi-selection carries all of it instead of narrowing to the row under the cursor.
 */
export function useFileTreeRowGesture(options: FileTreeRowGestureOptions): FileTreeRowGesture {
  const { isSelected, onSelect } = options;
  const deferredCollapseRef = useRef<string | null>(null);
  const dragSuppressedRef = useRef(false);

  const rowPointerProps = useCallback((path: string): RowPointerProps => ({
    onMouseDown: (event) => {
      if (event.button !== PRIMARY_BUTTON) return;

      const modifiers: SelectionModifiers = {
        extend: event.shiftKey,
        toggle: event.metaKey || event.ctrlKey,
      };
      const wasSelected = isSelected(path);
      deferredCollapseRef.current = null;
      // Only a press that *removes* the row cancels the drag — dragging a row you just deselected
      // would carry that row alone, which is never what the gesture meant. A shift or add press has
      // already built the selection by the time `dragstart` fires, so the drag that follows carries
      // it: continuing straight from a shift-click into a drag moves the whole range.
      dragSuppressedRef.current = modifiers.toggle && wasSelected;

      if (modifiers.extend || modifiers.toggle || !wasSelected) {
        onSelect(path, modifiers);
        return;
      }
      deferredCollapseRef.current = path;
    },
    onMouseUp: (event) => {
      if (event.button !== PRIMARY_BUTTON) return;
      if (deferredCollapseRef.current === path) onSelect(path, PLAIN_SELECTION);
      deferredCollapseRef.current = null;
      dragSuppressedRef.current = false;
    },
  }), [isSelected, onSelect]);

  return {
    isDragSuppressed: useCallback(() => dragSuppressedRef.current, []),
    onDragStarted: useCallback(() => { deferredCollapseRef.current = null; }, []),
    rowPointerProps,
  };
}
