import type { AumxPane } from '../../types.js';
import type { ActionContext, ActionResult } from '../types.js';
import { LogService } from '../../services/LogService.js';
import { TmuxService } from '../../services/TmuxService.js';
import { validatePaneName } from '../../utils/paneName.js';
import { getPaneTmuxTitle } from '../../utils/paneTitle.js';

export async function renamePane(
  pane: AumxPane,
  context: ActionContext,
  newName?: string,
): Promise<ActionResult> {
  const validation = validatePaneName(newName);
  if (!validation.ok) return { type: 'error', message: validation.message };
  const { value } = validation;

  const updated: AumxPane = { ...pane, slug: value, title: value, titleLocked: true };
  // When branchName is undefined, getPaneBranchName() falls back to slug — preserve the
  // original slug as branchName so merge/worktree ops still find the correct git branch.
  if (pane.worktreePath && pane.branchName === undefined) {
    updated.branchName = pane.slug;
  }
  context.onPaneUpdate?.(updated);

  if (pane.paneId) {
    const tmuxTitle = getPaneTmuxTitle(updated, pane.projectRoot, context.projectName);
    try {
      await TmuxService.getInstance().setPaneTitle(pane.paneId, tmuxTitle);
    } catch (err) {
      LogService.getInstance().warn(
        `Failed to update tmux pane title for ${pane.paneId}: ${err instanceof Error ? err.message : String(err)}`,
        'renameAction',
      );
    }
  }

  return { type: 'success', message: `Renamed to "${value}"` };
}
