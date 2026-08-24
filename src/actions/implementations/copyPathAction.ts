/**
 * COPY_PATH Action - Copy worktree path to clipboard
 */

import { spawnSync } from 'child_process';
import type { AumxPane } from '../../types.js';
import type { ActionResult, ActionContext } from '../types.js';

/**
 * Copy worktree path to clipboard
 */
export async function copyPath(
  pane: AumxPane,
  _context: ActionContext
): Promise<ActionResult> {
  if (!pane.worktreePath) {
    return {
      type: 'error',
      message: 'This pane has no worktree path',
      dismissable: true,
    };
  }

  try {
    // Try to copy to clipboard (works on macOS)
    const result = spawnSync('pbcopy', [], {
      input: pane.worktreePath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    if (result.error || result.status !== 0) {
      throw result.error ?? new Error(result.stderr || 'pbcopy failed');
    }

    return {
      type: 'success',
      message: `Path copied: ${pane.worktreePath}`,
      dismissable: true,
    };
  } catch {
    // If clipboard copy fails, just show the path
    return {
      type: 'info',
      message: `Path: ${pane.worktreePath}`,
      dismissable: true,
    };
  }
}
