import { isSelfOrDescendant, parentDir } from '../../../../shared/filePolicy';
import type { FileMoveItemResult, FileMoveResponse } from '../../../../shared/ipc-types';
import type { FileMoveRemap } from '../../../stores/file-browser.store';
import type { MoveMode } from './fileTreeDropPolicy';

export interface MoveSummary {
  detail?: string;
  message: string;
  severity: 'success' | 'error' | 'warning';
}

function verb(mode: MoveMode): string {
  return mode === 'copy' ? 'Copied' : 'Moved';
}

export function pluralizeItems(count: number): string {
  return count === 1 ? '1 item' : `${count} items`;
}

function describe(results: readonly FileMoveItemResult[]): string {
  return results
    .map((result) => (result.status === 'succeeded' ? result.sourcePath : `${result.sourcePath}: ${result.error}`))
    .join('\n');
}

/** Settled means a target now exists — `partial` included, since the tree and tabs must point at it. */
export function settledResults(response: FileMoveResponse): FileMoveRemap[] {
  const results: readonly FileMoveItemResult[] = response.results;
  return results
    .filter((result) => result.status !== 'failed')
    .map((result) => ({ from: result.sourcePath, to: result.finalPath }));
}

/**
 * A `partial` left the source in place, so moving the target back would collide with it. Only a
 * clean move is losslessly invertible, and only those belong on the undo stack.
 */
export function undoableResults(response: FileMoveResponse): FileMoveRemap[] {
  const results: readonly FileMoveItemResult[] = response.results;
  return results
    .filter((result) => result.status === 'succeeded')
    .map((result) => ({ from: result.sourcePath, to: result.finalPath }));
}

export function summarizeMove(response: FileMoveResponse, mode: MoveMode): MoveSummary {
  if (response.error) {
    return { message: response.error, severity: 'error' };
  }

  const results: readonly FileMoveItemResult[] = response.results;
  const failed = results.filter((result) => result.status === 'failed');
  const partial = results.filter((result) => result.status === 'partial');
  const settled = results.length - failed.length;

  if (settled === 0) {
    return {
      detail: describe(failed),
      message: failed[0]?.error ?? `Nothing was ${verb(mode).toLowerCase()}`,
      severity: 'error',
    };
  }
  if (failed.length > 0) {
    return {
      detail: describe(failed),
      message: `${verb(mode)} ${settled} of ${response.results.length} · ${failed.length} failed`,
      severity: 'warning',
    };
  }
  if (partial.length > 0) {
    return {
      detail: describe(partial),
      message: `${verb(mode)} ${pluralizeItems(settled)} · ${partial.length} left a copy behind`,
      severity: 'warning',
    };
  }

  return { message: `${verb(mode)} ${pluralizeItems(settled)}`, severity: 'success' };
}

/**
 * The destination and every source parent changed contents; every expanded directory now under a
 * moved path lost its cache and will not reload on its own, because it is already marked expanded.
 */
export function collectReloadDirs(
  destDir: string,
  sourcePaths: readonly string[],
  moves: readonly FileMoveRemap[],
  expandedDirs: ReadonlySet<string>,
): string[] {
  const dirs = new Set<string>([destDir]);

  for (const sourcePath of sourcePaths) {
    dirs.add(parentDir(sourcePath));
  }
  for (const { to } of moves) {
    for (const dir of expandedDirs) {
      if (isSelfOrDescendant(to, dir)) dirs.add(dir);
    }
  }

  return [...dirs];
}
