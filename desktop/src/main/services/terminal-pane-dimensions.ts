import { log } from './Logger.js';
import { displayPaneFormat } from './terminal-stream-state.js';

const MISSING_PANE_MESSAGES = ["can't find pane", 'no such pane'];

export interface PaneDimensions {
  cols: number;
  rows: number;
  windowCols: number;
  windowId: string | null;
  windowPanes: number;
  windowRows: number;
}

export class TerminalPaneMissingError extends Error {
  readonly cause: unknown;
  readonly tmuxPaneId: string;

  constructor(tmuxPaneId: string, cause: unknown) {
    super(`Terminal pane no longer exists: ${tmuxPaneId}`);
    this.name = 'TerminalPaneMissingError';
    this.tmuxPaneId = tmuxPaneId;
    this.cause = cause;
  }
}

export function isTerminalPaneMissingError(error: unknown): boolean {
  if (error instanceof TerminalPaneMissingError) return true;
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return MISSING_PANE_MESSAGES.some((marker) => normalized.includes(marker));
}

async function readPaneIdentity(tmuxPaneId: string): Promise<string> {
  const raw = await displayPaneFormat(tmuxPaneId, '#{pane_id}');
  return raw.trim();
}

export async function readPaneDimensions(tmuxPaneId: string): Promise<PaneDimensions> {
  try {
    const raw = await displayPaneFormat(
      tmuxPaneId,
      '#{pane_width}x#{pane_height}:#{window_id}:#{window_width}x#{window_height}:#{window_panes}',
    );
    const trimmed = raw.trim();
    const match = trimmed.match(/^(\d+)x(\d+):(@\d+):(\d+)x(\d+):(\d+)$/);
    if (match) {
      return {
        cols: parseInt(match[1], 10),
        rows: parseInt(match[2], 10),
        windowCols: parseInt(match[4], 10),
        windowId: match[3],
        windowPanes: parseInt(match[6], 10),
        windowRows: parseInt(match[5], 10),
      };
    }

    const paneIdentity = await readPaneIdentity(tmuxPaneId);
    if (paneIdentity !== tmuxPaneId) {
      throw new TerminalPaneMissingError(tmuxPaneId, new Error(`Invalid pane dimensions: ${trimmed}`));
    }
  } catch (error) {
    if (isTerminalPaneMissingError(error)) {
      throw new TerminalPaneMissingError(tmuxPaneId, error);
    }
    log.warn('terminal', 'Failed to get pane dimensions', { tmuxPaneId, error });
  }
  return { cols: 80, rows: 24, windowCols: 80, windowId: null, windowPanes: 1, windowRows: 24 };
}
