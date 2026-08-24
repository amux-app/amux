/**
 * VIEW Action - Jump to/view a pane
 */

import { execFileSync } from 'child_process';
import type { AumxPane } from '../../types.js';
import type { ActionResult, ActionContext } from '../types.js';

/**
 * View/Jump to a pane
 */
export async function viewPane(
  pane: AumxPane,
  _context: ActionContext
): Promise<ActionResult> {
  try {
    execFileSync('tmux', ['select-pane', '-t', pane.paneId], { stdio: 'pipe' });

    return {
      type: 'navigation',
      message: `Jumped to pane: ${pane.slug}`,
      targetPaneId: pane.id,
      dismissable: true,
    };
  } catch {
    return {
      type: 'error',
      message: 'Failed to jump to pane - it may have been closed',
      dismissable: true,
    };
  }
}
