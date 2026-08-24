import { create } from 'zustand';
import { parentDir } from '../../shared/filePolicy';
import type { FileMoveRemap } from './file-browser.store';

const MAX_UNDO_DEPTH = 25;

interface FileMoveUndoEntry {
  /** Every item as it was applied, so sources from different parents each go back to their own. */
  moves: readonly FileMoveRemap[];
  rootPath: string;
}

/** One `FILE_MOVE` call per original parent directory — the channel takes a single destination. */
export interface UndoMoveGroup {
  destDir: string;
  sourcePaths: string[];
}

interface FileUndoState {
  stacks: Record<string, FileMoveUndoEntry[]>;
}

interface FileUndoActions {
  popMove: (rootPath: string) => FileMoveUndoEntry | null;
  pushMove: (entry: FileMoveUndoEntry) => void;
}

/**
 * Copies are deliberately not recorded: undoing one means deleting a file the user may since have
 * edited, whereas a move is losslessly invertible by moving each entry back where it came from.
 */
export const useFileUndoStore = create<FileUndoState & FileUndoActions>((set, get) => ({
  stacks: {},

  pushMove: (entry) => {
    if (entry.moves.length === 0) return;
    set((s) => {
      const stack = [...(s.stacks[entry.rootPath] ?? []), entry];
      return {
        stacks: {
          ...s.stacks,
          [entry.rootPath]: stack.slice(Math.max(0, stack.length - MAX_UNDO_DEPTH)),
        },
      };
    });
  },

  popMove: (rootPath) => {
    const stack = get().stacks[rootPath] ?? [];
    const entry = stack.at(-1);
    if (!entry) return null;
    set((s) => ({ stacks: { ...s.stacks, [rootPath]: stack.slice(0, -1) } }));
    return entry;
  },
}));

export function groupUndoMoves(moves: readonly FileMoveRemap[]): UndoMoveGroup[] {
  const byOriginalParent = new Map<string, string[]>();

  for (const move of moves) {
    const destDir = parentDir(move.from);
    const sourcePaths = byOriginalParent.get(destDir);
    if (sourcePaths) sourcePaths.push(move.to);
    else byOriginalParent.set(destDir, [move.to]);
  }

  return [...byOriginalParent].map(([destDir, sourcePaths]) => ({ destDir, sourcePaths }));
}

export function useUndoDepth(rootPath: string): number {
  return useFileUndoStore((s) => s.stacks[rootPath]?.length ?? 0);
}
