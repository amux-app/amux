/**
 * Shared utility for post-pane cleanup operations
 * Handles welcome pane recreation and layout recalculation when last pane is removed
 */

import { execSync } from 'child_process';
import { LogService } from '../services/LogService.js';
import { TmuxService } from '../services/TmuxService.js';
import { createWelcomePaneCoordinated } from './welcomePaneManager.js';
import { recalculateAndApplyLayout } from './layoutManager.js';

/**
 * Recreate welcome pane and recalculate layout after the last pane is removed
 * This should be called whenever panes.length transitions from >0 to 0
 *
 * @param projectRoot - The project root directory
 */
export async function handleLastPaneRemoved(projectRoot: string): Promise<void> {
  const tmuxService = TmuxService.getInstance();

  try {
    let controlPaneId: string;
    try {
      controlPaneId = execSync('tmux display-message -p "#{pane_id}"', {
        encoding: 'utf-8',
        stdio: 'pipe'
      }).trim();
    } catch {
      return;
    }

    if (!controlPaneId) {
      return;
    }

    await createWelcomePaneCoordinated(projectRoot, controlPaneId);

    const dimensions = await tmuxService.getTerminalDimensions();

    recalculateAndApplyLayout(
      controlPaneId,
      [], // No content panes
      dimensions.width,
      dimensions.height
    );
  } catch (error) {
    LogService.getInstance().error(
      'Failed to handle last pane removal',
      'postPaneCleanup',
      undefined,
      error instanceof Error ? error : undefined
    );
  }
}
