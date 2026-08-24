import type { AumxPane } from '../types.js';
import { randomUUID } from 'crypto';
import { execFileAsync } from './execAsync.js';
import { getPaneTitleCandidates } from './paneTitle.js';
import { StateManager } from '../shared/StateManager.js';

/**
 * Tmux pane option carrying the aumx pane id. Unlike a pane title, a pane
 * option cannot be set from inside the pane through an escape sequence, so it
 * is the only forgery-proof anchor available for rebinding.
 */
export const AUMX_PANE_ID_OPTION = '@aumx_pane_id';
/** Scoped to a tmux pane: survives app restart but not a pane recreation. */
export const AUMX_PANE_INCARNATION_OPTION = '@aumx_incarnation';

export async function stampTmuxPaneIdOption(tmuxPaneId: string, paneId: string): Promise<void> {
  await execFileAsync(
    'tmux',
    ['set', '-p', '-t', tmuxPaneId, AUMX_PANE_ID_OPTION, paneId],
    { silent: true },
  );
}

export async function stampTmuxPaneIncarnationOption(
  tmuxPaneId: string,
  incarnationId = randomUUID(),
): Promise<string> {
  await execFileAsync(
    'tmux',
    ['set', '-p', '-t', tmuxPaneId, AUMX_PANE_INCARNATION_OPTION, incarnationId],
    { silent: true },
  );
  return incarnationId;
}

export async function ensureTmuxPaneIncarnationOption(tmuxPaneId: string): Promise<string> {
  try {
    const current = (await execFileAsync(
      'tmux',
      ['show-options', '-p', '-v', '-t', tmuxPaneId, AUMX_PANE_INCARNATION_OPTION],
      { silent: true },
    )).trim();
    if (current) return current;
  } catch {
    // A new pane has no pane-local option yet.
  }
  return stampTmuxPaneIncarnationOption(tmuxPaneId);
}

/**
 * Attempts to rebind a pane whose ID has changed by matching on title (slug).
 *
 * IMPORTANT: Only rebinds if the pane ID is truly missing (pane was killed and recreated).
 * Does NOT rebind if the title simply changed (user renamed it).
 *
 * @param pane - The pane to potentially rebind
 * @param titleToIdMap - Map of pane titles to their current tmux pane IDs
 * @param allPaneIds - Array of all current tmux pane IDs
 * @returns The pane with potentially updated paneId
 */
export function rebindPaneByTitle(
  pane: AumxPane,
  titleToIdMap: Map<string, string>,
  allPaneIds: string[]
): AumxPane {
  // If pane ID exists in tmux, keep using it (even if title changed)
  if (allPaneIds.length > 0 && allPaneIds.includes(pane.paneId)) {
    return pane; // Pane still exists, no rebinding needed
  }

  // Pane ID missing - try to find it by title match
  if (allPaneIds.length > 0 && !allPaneIds.includes(pane.paneId)) {
    const sessionProjectRoot = StateManager.getInstance().getState().projectRoot;
    const titleCandidates = getPaneTitleCandidates(
      pane,
      sessionProjectRoot || undefined
    );
    for (const candidate of titleCandidates) {
      const remappedId = titleToIdMap.get(candidate);
      if (remappedId) {
        return { ...pane, paneId: remappedId };
      }
    }
  }

  return pane;
}
