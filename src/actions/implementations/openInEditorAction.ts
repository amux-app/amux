/**
 * OPEN_IN_EDITOR Action - Open worktree in external editor
 */

import { spawnSync } from 'child_process';
import type { MuxBasePane } from '../../types.js';
import type { ActionResult, ActionContext } from '../types.js';

function parseCommand(command: string): { bin: string; args: string[] } {
  const tokens = (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
    .map((token) => token.replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);

  if (tokens.length === 0) {
    return { bin: 'code', args: [] };
  }

  const [bin, ...args] = tokens;
  return { bin, args };
}

/**
 * Open worktree in external editor
 */
export async function openInEditor(
  pane: MuxBasePane,
  context: ActionContext,
  params?: { editor?: string }
): Promise<ActionResult> {
  if (!pane.worktreePath) {
    return {
      type: 'error',
      message: 'This pane has no worktree to open',
      dismissable: true,
    };
  }

  const editorCommand = params?.editor || process.env.EDITOR || 'code';
  const { bin: editorBin, args: editorArgs } = parseCommand(editorCommand);

  try {
    const result = spawnSync(editorBin, [...editorArgs, pane.worktreePath], {
      stdio: 'pipe',
      shell: false,
    });

    if (result.error || result.status !== 0) {
      throw result.error ?? new Error(result.stderr?.toString('utf-8') || 'Editor command failed');
    }

    return {
      type: 'success',
      message: `Opened in ${editorCommand}`,
      dismissable: true,
    };
  } catch (error) {
    return {
      type: 'error',
      message: `Failed to open in editor: ${error}`,
      dismissable: true,
    };
  }
}
