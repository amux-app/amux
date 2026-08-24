import type { PaneTerminalProfile } from './paneTerminalProfile.js';
import { execAsync } from './execAsync.js';
import { shQuote } from './shellEscape.js';

export interface PaneTerminalGeometry {
  cols: number;
  rows?: number;
}

export function resolvePaneBirthGeometry(
  profile: PaneTerminalProfile,
  proposed: { cols: number; rows: number } | null,
): PaneTerminalGeometry | null {
  if (profile.terminalFixedCols !== undefined) {
    return {
      cols: profile.terminalFixedCols,
      ...(proposed ? { rows: proposed.rows } : {}),
    };
  }

  return proposed;
}

/**
 * Apply geometry to an isolated tmux window before its agent process starts.
 * Errors deliberately propagate: launching at the wrong width would violate
 * the persisted pane contract and recreate the renderer corruption this
 * pre-sizing prevents.
 */
export async function resizePaneBeforeAgentLaunch(
  paneId: string,
  geometry: PaneTerminalGeometry,
): Promise<void> {
  assertDimension('cols', geometry.cols);
  if (geometry.rows !== undefined) assertDimension('rows', geometry.rows);

  const dimensions = [
    `-x ${geometry.cols}`,
    ...(geometry.rows === undefined ? [] : [`-y ${geometry.rows}`]),
  ].join(' ');

  await execAsync(
    `tmux resize-window -t ${shQuote(paneId)} ${dimensions}`,
    { timeout: 5000 },
  );
  await execAsync(
    `tmux resize-pane -t ${shQuote(paneId)} ${dimensions}`,
    { timeout: 5000 },
  );

  const reported = (await execAsync(
    `tmux display-message -t ${shQuote(paneId)} -p '#{pane_width}x#{pane_height}'`,
    { timeout: 5000 },
  )).trim();
  const parsed = /^(\d+)x(\d+)$/.exec(reported);
  const reportedCols = parsed ? Number.parseInt(parsed[1], 10) : Number.NaN;
  const reportedRows = parsed ? Number.parseInt(parsed[2], 10) : Number.NaN;
  const widthMatches = reportedCols === geometry.cols;
  const rowsMatch = geometry.rows === undefined || reportedRows === geometry.rows;
  if (!widthMatches || !rowsMatch) {
    const requested = `${geometry.cols}x${geometry.rows ?? '*'}`;
    throw new Error(
      `tmux pane ${paneId} did not reach requested birth geometry `
      + `${requested} (reported ${reported || 'invalid geometry'})`,
    );
  }
}

function assertDimension(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 2) {
    throw new Error(`Invalid terminal ${name}: ${value}`);
  }
}
