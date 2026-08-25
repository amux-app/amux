/**
 * Merge Conflict Handler
 * Handles detected merge conflicts
 */

import type { ActionResult, ActionContext } from '../../types.js';
import type { MuxBasePane } from '../../../types.js';
import { executeMergeWithConflictHandling } from '../mergeExecution.js';
import { createConflictResolutionPaneForMerge } from '../conflictResolution.js';

export interface MergeConflictIssue {
  type: 'merge_conflict';
  message: string;
  files: string[];
}

export async function handleMergeConflict(
  issue: MergeConflictIssue,
  mainBranch: string,
  mainRepoPath: string,
  pane: MuxBasePane,
  context: ActionContext
): Promise<ActionResult> {
  const hasRealFiles = issue.files.length > 0;

  const message = hasRealFiles
    ? `Conflicts detected in:\n${issue.files.slice(0, 5).map(f => ` •  ${f}`).join('\n')}${issue.files.length > 5 ? '\n  ...' : ''}`
    : `Potential conflicts detected between ${mainBranch} and ${pane.slug}.\n\nThe branches have diverged and may have conflicting changes.\nYou can try AI-assisted merge or resolve manually.`;

  return {
    type: 'choice',
    title: 'Merge Conflicts Detected',
    message,
    options: [
      {
        id: 'ai_merge',
        label: 'Try AI-assisted merge',
        description: 'Let AI intelligently combine both versions',
        default: true,
      },
      {
        id: 'manual_merge',
        label: 'Manual resolution',
        description: 'Jump to pane to resolve conflicts',
      },
      {
        id: 'cancel',
        label: 'Cancel merge',
        description: 'Do nothing',
      },
    ],
    onSelect: async (optionId: string) => {
      if (optionId === 'cancel') {
        return { type: 'info', message: 'Merge cancelled', dismissable: true };
      }

      if (optionId === 'manual_merge') {
        return executeMergeWithConflictHandling(pane, context, mainBranch, mainRepoPath, 'manual');
      }

      if (optionId === 'ai_merge') {
        return createConflictResolutionPaneForMerge(pane, context, mainBranch, mainRepoPath);
      }

      return { type: 'info', message: 'Unknown option', dismissable: true };
    },
    dismissable: true,
  };
}
