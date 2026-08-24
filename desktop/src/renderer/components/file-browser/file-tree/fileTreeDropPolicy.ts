import { isSelfOrDescendant, parentDir } from '../../../../shared/filePolicy';
import type { FileTreeRowData } from './fileTreeModel';

export type MoveMode = 'move' | 'copy';

export interface DragPayload {
  rootPath: string;
  paths: string[];
}

type DropRejection =
  | 'cross-root'
  | 'into-self'
  | 'into-descendant'
  | 'same-parent'
  | 'empty';

export type DropDecision =
  | { allowed: true; mode: MoveMode }
  | { allowed: false; reason: DropRejection };

/** Directory a drop on this row lands in. Files resolve to their parent. Root is ''. */
export function resolveDropDir(row: FileTreeRowData | null): string {
  if (!row || row.isPlaceholder) return '';
  return row.isDirectory ? row.path : parentDir(row.path);
}

function findContainmentRejection(paths: string[], destDir: string): DropRejection | null {
  for (const source of paths) {
    if (!isSelfOrDescendant(source, destDir)) continue;
    return source === destDir ? 'into-self' : 'into-descendant';
  }
  return null;
}

export function decideDrop(
  payload: DragPayload,
  destDir: string,
  destRootPath: string,
  mode: MoveMode,
): DropDecision {
  if (payload.paths.length === 0) return { allowed: false, reason: 'empty' };
  if (payload.rootPath !== destRootPath) return { allowed: false, reason: 'cross-root' };

  const containment = findContainmentRejection(payload.paths, destDir);
  if (containment) return { allowed: false, reason: containment };

  if (mode === 'move' && payload.paths.every((source) => parentDir(source) === destDir)) {
    return { allowed: false, reason: 'same-parent' };
  }

  return { allowed: true, mode };
}
