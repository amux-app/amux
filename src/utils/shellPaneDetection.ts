/**
 * Shell Pane Detection Utility
 *
 * Detects manually-created tmux panes and determines their shell type.
 */

import { execSync } from 'child_process';
import type { MuxBasePane } from '../types.js';
import { TmuxService } from '../services/TmuxService.js';
import { execFileAsync } from './execAsync.js';
import { resolveProjectRootFromPath } from './projectRoot.js';

const KNOWN_SHELLS = ['bash', 'zsh', 'fish', 'sh', 'ksh', 'tcsh', 'csh', 'dash', 'nu', 'pwsh', 'login'];
const PANE_CURRENT_COMMAND_FORMAT = '#{pane_current_command}';
const PANE_CURRENT_PATH_FORMAT = '#{pane_current_path}';
const PANE_PID_FORMAT = '#{pane_pid}';
const SHELL_FALLBACK = 'shell';

/**
 * Reads a tmux format for a pane without a shell, so the pane id stays literal data.
 */
function displayPaneFormat(paneId: string, format: string): Promise<string> {
  return execFileAsync('tmux', ['display-message', '-t', paneId, '-p', format], { silent: true });
}

function matchKnownShell(command: string): string | null {
  const lowerCommand = command.toLowerCase();
  return KNOWN_SHELLS.find(shell => lowerCommand === shell || lowerCommand.endsWith(`/${shell}`)) ?? null;
}

async function detectParentShell(paneId: string): Promise<string | null> {
  const pid = await displayPaneFormat(paneId, PANE_PID_FORMAT);
  if (!pid) return null;

  const ppid = await execFileAsync('ps', ['-o', 'ppid=', '-p', pid], { silent: true });
  if (!ppid) return null;

  const parentCommand = await execFileAsync('ps', ['-o', 'comm=', '-p', ppid], { silent: true });
  return parentCommand ? matchKnownShell(parentCommand) : null;
}

/**
 * Detects the shell type running in a tmux pane
 * @param paneId The tmux pane ID (e.g., %1)
 * @returns Shell type (bash, zsh, fish, etc) or 'shell' as fallback
 */
export async function detectShellType(paneId: string): Promise<string> {
  const command = await displayPaneFormat(paneId, PANE_CURRENT_COMMAND_FORMAT);
  const directShell = matchKnownShell(command);
  if (directShell) return directShell;

  // A non-shell command may still be running inside a shell, so check the parent.
  return (await detectParentShell(paneId)) ?? SHELL_FALLBACK;
}

/**
 * Information about an untracked pane
 */
interface UntrackedPaneInfo {
  paneId: string;
  title: string;
  command: string;
}

/**
 * Gets all untracked tmux panes (panes not in muxbase config)
 * @param sessionName The tmux session name
 * @param trackedPaneIds Array of pane IDs already tracked by muxbase
 * @param controlPaneId Optional control pane ID to exclude
 * @param welcomePaneId Optional welcome pane ID to exclude
 * @returns Array of untracked pane information
 */
export async function getUntrackedPanes(
  sessionName: string,
  trackedPaneIds: string[],
  controlPaneId?: string,
  welcomePaneId?: string
): Promise<UntrackedPaneInfo[]> {
  try {
    const output = execSync(
      `tmux list-panes -s -F '#{pane_id}::#{pane_title}::#{pane_current_command}'`,
      { encoding: 'utf-8', stdio: 'pipe' }
    ).trim();

    if (!output) return [];

    const untrackedPanes: UntrackedPaneInfo[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      const [paneId, title, command] = line.split('::');

      if (!paneId || !paneId.startsWith('%')) continue;

      // CRITICAL: Skip internal muxbase panes by title
      if (title === 'muxbase-spacer') {
        continue;
      }
      if (title && title.startsWith('muxbase v')) {
        continue;
      }
      if (title === 'Welcome') {
        continue;
      }

      // CRITICAL: Skip control and welcome panes by ID (most reliable method)
      if (controlPaneId && paneId === controlPaneId) {
        continue;
      }
      if (welcomePaneId && paneId === welcomePaneId) {
        continue;
      }

      // CRITICAL: Skip panes running muxbase itself (node process running muxbase)
      if (command && (command === 'node' || command.includes('muxbase'))) {
        continue;
      }

      // Skip already tracked panes
      if (trackedPaneIds.includes(paneId)) continue;

      untrackedPanes.push({ paneId, title: title || '', command: command || '' });
    }

    return untrackedPanes;
  } catch {
    return [];
  }
}

async function detectPaneProjectInfo(
  paneId: string
): Promise<{ projectRoot?: string; projectName?: string }> {
  try {
    const panePath = await displayPaneFormat(paneId, PANE_CURRENT_PATH_FORMAT);

    if (!panePath) {
      return {};
    }

    const resolved = resolveProjectRootFromPath(panePath, panePath);
    return {
      projectRoot: resolved.projectRoot,
      projectName: resolved.projectName,
    };
  } catch {
    return {};
  }
}

/**
 * Creates a MuxBasePane object for a shell pane
 * @param paneId The tmux pane ID
 * @param nextId The next available muxbase ID number
 * @param _existingTitle Optional existing title retained for API compatibility
 * @returns MuxBasePane object for the shell pane
 */
export async function createShellPane(paneId: string, nextId: number, _existingTitle?: string): Promise<MuxBasePane> {
  const tmuxService = TmuxService.getInstance();
  const shellType = await detectShellType(paneId);
  const paneProjectInfo = await detectPaneProjectInfo(paneId);

  // CRITICAL: Always generate unique shell-N slugs for shell panes.
  // Using existing titles (like hostname "Gigablaster.local") causes tracking bugs
  // because multiple panes can have the same title, and titleToId Map can only
  // store one mapping per title. This leads to duplicate pane entries.
  const slug = `shell-${nextId}`;

  try {
    await tmuxService.setPaneTitle(paneId, slug);
  } catch {
    // title is best-effort; pane is still usable without it
  }

  return {
    id: `muxbase-${nextId}`,
    slug,
    prompt: '', // No prompt for manually created panes
    paneId,
    projectRoot: paneProjectInfo.projectRoot,
    projectName: paneProjectInfo.projectName,
    type: 'shell',
    shellType,
  };
}

/**
 * Gets the next available muxbase ID number
 * @param existingPanes Array of existing panes
 * @returns Next available ID number
 */
export function getNextMuxBaseId(existingPanes: MuxBasePane[]): number {
  if (existingPanes.length === 0) return 1;

  // Extract numeric IDs from all panes
  const ids = existingPanes
    .map(p => {
      const match = p.id.match(/^muxbase-(\d+)$/);
      return match ? parseInt(match[1], 10) : 0;
    })
    .filter(id => id > 0);

  if (ids.length === 0) return 1;

  return Math.max(...ids) + 1;
}
