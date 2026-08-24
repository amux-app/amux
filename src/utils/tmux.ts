import { LogService } from '../services/LogService.js';
import { TmuxService } from '../services/TmuxService.js';
import { DEFAULT_LAYOUT_CONFIG } from './layoutManager.js';
import { execFileSync } from 'child_process';

const WINDOW_SIZE_FORMAT = '#{window_width} #{window_height}';

export const SIDEBAR_WIDTH = DEFAULT_LAYOUT_CONFIG.SIDEBAR_WIDTH;
export const MIN_COMFORTABLE_WIDTH = DEFAULT_LAYOUT_CONFIG.MIN_COMFORTABLE_WIDTH;
const MAX_COMFORTABLE_WIDTH = DEFAULT_LAYOUT_CONFIG.MAX_COMFORTABLE_WIDTH;
export const MIN_COMFORTABLE_HEIGHT = DEFAULT_LAYOUT_CONFIG.MIN_COMFORTABLE_HEIGHT;

/**
 * Calculate tmux layout checksum
 * Based on tmux source: layout.c - layout_checksum()
 */
function calculateLayoutChecksum(layout: string): string {
  let checksum = 0;

  for (let i = 0; i < layout.length; i++) {
    checksum = (checksum >> 1) + ((checksum & 1) << 15);
    checksum += layout.charCodeAt(i);
    checksum &= 0xFFFF; // Mask to 16 bits (critical!)
  }

  // Tmux expects a 4-digit hex checksum (pad with leading zeros)
  return checksum.toString(16).padStart(4, '0');
}

/**
 * Gets current window dimensions
 * @deprecated Use TmuxService.getInstance().getWindowDimensionsSync() instead
 */
export const getWindowDimensions = () => {
  return TmuxService.getInstance().getWindowDimensionsSync();
};

/**
 * Gets current terminal (client) dimensions
 * This is the actual terminal size, not the tmux window size
 * @deprecated Use TmuxService.getInstance().getTerminalDimensionsSync() instead
 */
export const getTerminalDimensions = () => {
  return TmuxService.getInstance().getTerminalDimensionsSync();
};

/**
 * Creates a new tmux pane by splitting horizontally
 * @param options - Split pane options
 * @param options.targetPane - Pane to split from (optional)
 * @param options.cwd - Working directory for new pane (optional)
 * @param options.command - Command to run in new pane (optional)
 * @returns The new pane ID
 * @deprecated Use TmuxService.getInstance().splitPaneSync() instead
 */
export const splitPane = (options: {
  targetPane?: string;
  cwd?: string;
  command?: string;
} = {}): string => {
  return TmuxService.getInstance().splitPaneSync(options);
};

/**
 * Ensures the tmux window containing targetPaneId has enough space for a horizontal split.
 * Uses explicit -t targeting so it works from outside tmux (e.g. Electron).
 */
export const ensureMinimumWindowSize = (targetPaneId: string): void => {
  const minWidth = SIDEBAR_WIDTH + MIN_COMFORTABLE_WIDTH + 1;
  try {
    const output = execFileSync(
      'tmux',
      ['display-message', '-t', targetPaneId, '-p', WINDOW_SIZE_FORMAT],
      { encoding: 'utf-8' },
    ).trim();
    const [width, height] = output.split(' ').map(n => parseInt(n, 10));
    if (isNaN(width) || isNaN(height)) return;

    if (width < minWidth || height < MIN_COMFORTABLE_HEIGHT) {
      execFileSync(
        'tmux',
        [
          'resize-window',
          '-t', targetPaneId,
          '-x', String(Math.max(width, minWidth)),
          '-y', String(Math.max(height, MIN_COMFORTABLE_HEIGHT)),
        ],
        { encoding: 'utf-8' },
      );
    }
  } catch {
    // Best-effort: proceed and let split fail naturally if resize isn't possible
  }
};

/**
 * Creates initial sidebar layout by splitting from control pane
 * @param controlPaneId The pane ID running aumx TUI (left sidebar)
 * @param cwd Optional working directory for the new content pane
 * @returns The newly created content area pane ID
 */
export const setupSidebarLayout = (controlPaneId: string, cwd?: string): string => {
  try {
    const tmuxService = TmuxService.getInstance();

    // Defensive check: verify the control pane still exists before splitting
    try {
      // Try to get the pane title - this will throw if the pane doesn't exist
      tmuxService.getPaneTitleSync(controlPaneId);
    } catch {
      throw new Error(`Control pane ${controlPaneId} does not exist. Cannot create sidebar layout.`);
    }

    ensureMinimumWindowSize(controlPaneId);

    // Split horizontally (left-right) from control pane
    const newPaneId = tmuxService.splitPaneSync({
      targetPane: controlPaneId,
      cwd,
    });

    // Resize control pane to fixed width (sync version for initial setup)
    try {
      tmuxService.resizePaneSync(controlPaneId, { width: SIDEBAR_WIDTH });
    } catch {
      // Ignore resize errors during initial setup
    }

    return newPaneId;
  } catch (error) {
    throw new Error(`Failed to setup sidebar layout: ${error}`);
  }
};

/**
 * Generates a custom tmux layout string for [Sidebar | Grid] arrangement
 * Format: checksum,WxH,X,Y{child1,child2,...}
 * Each child: WxH,X,Y[pane_id] for leaf or WxH,X,Y{...} for container
 */
export const generateSidebarGridLayout = (
  controlPaneId: string,
  contentPanes: string[],
  sidebarWidth: number,
  windowWidth: number,
  windowHeight: number,
  columns: number,
  maxComfortableWidth: number = MAX_COMFORTABLE_WIDTH
): string => {
  // Calculate grid dimensions for content panes
  const numContentPanes = contentPanes.length;

  // Use provided column count
  const cols = columns;
  const rows = Math.ceil(numContentPanes / cols);

  // Content area dimensions
  // Account for borders: horizontal split adds 1 char, vertical splits add 1 char per row
  const contentWidth = windowWidth - sidebarWidth - 1; // -1 for border between sidebar and content
  const contentStartX = sidebarWidth + 1; // +1 to account for border

  // Check if last pane is a spacer
  const tmuxService = TmuxService.getInstance();
  const lastPaneIsSpacer = contentPanes.length > 0 && (() => {
    try {
      const lastPaneId = contentPanes[contentPanes.length - 1];
      const title = tmuxService.getPaneTitleSync(lastPaneId);
      return title === 'aumx-spacer';
    } catch {
      return false;
    }
  })();

  // For height, account for borders between rows
  // If we have 2 rows with 1 border, total consumed = row1 + 1 + row2 = windowHeight
  const bordersHeight = rows - 1; // Number of borders between rows
  const availableHeight = windowHeight - bordersHeight;
  const paneHeight = Math.floor(availableHeight / rows);

  // Extract numeric ID from controlPaneId (e.g., %1 -> 1)
  const sidebarId = controlPaneId.replace('%', '');

  // Build grid rows using absolute coordinates (tmux requires absolute even inside containers).
  const gridRows: string[] = [];
  let paneIndex = 0;
  let currentY = 0; // Track Y position (starts at 0, relative to content area)

  for (let row = 0; row < rows; row++) {
    const rowPanes: string[] = [];
    let absoluteX = contentStartX; // Track X position as ABSOLUTE from window origin

    // Calculate height for this row
    // Last row gets remainder to account for rounding
    let rowHeight: number;
    if (row === rows - 1) {
      // Last row: use all remaining height
      rowHeight = windowHeight - currentY;
    } else {
      rowHeight = paneHeight;
    }

    // Determine panes in this row
    const panesInThisRow: string[] = [];
    for (let col = 0; col < cols && paneIndex + col < numContentPanes; col++) {
      panesInThisRow.push(contentPanes[paneIndex + col]);
    }

    // Check if this row has a spacer (last pane is spacer)
    const rowHasSpacer = lastPaneIsSpacer && row === rows - 1 && panesInThisRow.length > 0 &&
      panesInThisRow[panesInThisRow.length - 1] === contentPanes[numContentPanes - 1];

    const numContentPanesInRow = rowHasSpacer ? panesInThisRow.length - 1 : panesInThisRow.length;

    // Calculate widths for this row
    let contentPaneWidths: number[];
    let spacerWidth: number | null = null;

    if (rowHasSpacer) {
      // Row with spacer: content panes get MAX_COMFORTABLE_WIDTH (from config), spacer gets remainder
      const contentPaneWidth = maxComfortableWidth;
      const bordersInRow = panesInThisRow.length - 1; // borders between ALL panes in row
      const totalContentWidth = numContentPanesInRow * contentPaneWidth;
      const remainingWidth = contentWidth - totalContentWidth - bordersInRow;

      if (remainingWidth < 0) {
        LogService.getInstance().warn(
          `Negative spacer width! contentWidth=${contentWidth}, totalContent=${totalContentWidth}, borders=${bordersInRow}`,
          'Layout'
        );
      }

      contentPaneWidths = Array(numContentPanesInRow).fill(contentPaneWidth);
      spacerWidth = remainingWidth;
    } else {
      // Row without spacer: divide width evenly
      const bordersInRow = panesInThisRow.length - 1;
      const availableWidth = contentWidth - bordersInRow;
      const evenWidth = Math.floor(availableWidth / panesInThisRow.length);
      const remainder = availableWidth - (evenWidth * panesInThisRow.length);

      // CRITICAL: Distribute width evenly, with remainder going to FIRST pane (matches tmux behavior)
      contentPaneWidths = Array(panesInThisRow.length).fill(evenWidth);
      contentPaneWidths[0] += remainder; // First pane gets remainder, not last!
    }

    // Build row panes with calculated widths using ABSOLUTE coordinates
    for (let col = 0; col < panesInThisRow.length; col++) {
      const paneId = panesInThisRow[col].replace('%', '');
      const isSpacerPane = rowHasSpacer && col === panesInThisRow.length - 1;

      const colWidth = isSpacerPane ? spacerWidth! : contentPaneWidths[col];

      // Use ABSOLUTE coordinates (from window origin) - tmux requirement
      rowPanes.push(`${colWidth}x${rowHeight},${absoluteX},${currentY},${paneId}`);

      // Move X position right by pane width + border
      absoluteX += colWidth;
      if (col < panesInThisRow.length - 1) {
        absoluteX += 1; // Add border
      }
    }

    paneIndex += panesInThisRow.length;

    // Wrap multi-pane rows in horizontal container (uses ABSOLUTE coordinates)
    if (rowPanes.length > 1) {
      // Horizontal split = use curly braces {}
      // Row container also uses ABSOLUTE coordinates
      const rowString = `${contentWidth}x${rowHeight},${contentStartX},${currentY}{${rowPanes.join(',')}}`;
      gridRows.push(rowString);
    } else if (rowPanes.length === 1) {
      // Single pane - no container needed, use ABSOLUTE coordinates
      const paneStr = rowPanes[0];
      const parts = paneStr.split(',');
      parts[1] = contentStartX.toString(); // X absolute
      parts[2] = currentY.toString(); // Y absolute
      const singlePaneString = parts.join(',');
      gridRows.push(singlePaneString);
    }

    // Move Y position down by pane height + 1 for border (except on last row)
    if (row < rows - 1) {
      currentY += paneHeight + 1;
    }
  }

  // Build root container
  const sidebar = `${sidebarWidth}x${windowHeight},0,0,${sidebarId}`;
  let layoutWithoutChecksum: string;

  if (gridRows.length > 1) {
    // Multiple rows: wrap in vertical split container
    const contentArea = `${contentWidth}x${windowHeight},${contentStartX},0[${gridRows.join(',')}]`;
    layoutWithoutChecksum = `${windowWidth}x${windowHeight},0,0{${sidebar},${contentArea}}`;
  } else if (gridRows.length === 1) {
    // Single row: keep the container structure to maintain binary splits
    // tmux only supports 2 children per split, so we need {sidebar, content_container}
    const row = gridRows[0];

    const contentArea = row.replace(/^(\d+x\d+),0,/, `$1,${contentStartX},`);
    layoutWithoutChecksum = `${windowWidth}x${windowHeight},0,0{${sidebar},${contentArea}}`;
  } else {
    // No content panes
    return '';
  }

  const checksum = calculateLayoutChecksum(layoutWithoutChecksum);
  return `${checksum},${layoutWithoutChecksum}`;
};

/**
 * Calculates optimal number of columns for pane layout based on dimensions
 * @param numPanes Number of panes to arrange
 * @param contentWidth Available width for content panes
 * @param contentHeight Available height for content panes
 * @returns Optimal number of columns
 */
export const calculateOptimalColumns = (
  numPanes: number,
  contentWidth: number,
  contentHeight: number
): number => {
  // Try different numbers of columns to find optimal layout
  let bestCols = 1;
  let bestScore = -1;

  for (let cols = 1; cols <= numPanes; cols++) {
    // Calculate width for this column count
    const bordersWidth = cols - 1;
    const paneWidth = Math.floor((contentWidth - bordersWidth) / cols);

    // Calculate height for this column count
    const rows = Math.ceil(numPanes / cols);
    const bordersHeight = rows - 1;
    const paneHeight = Math.floor((contentHeight - bordersHeight) / rows);

    // Skip if width or height is too small
    if (paneWidth < MIN_COMFORTABLE_WIDTH || paneHeight < MIN_COMFORTABLE_HEIGHT) {
      continue;
    }

    // Score this configuration (prefer balanced layouts)
    // Heavily penalize heights below comfortable threshold
    const widthScore = paneWidth <= MAX_COMFORTABLE_WIDTH ? 1 : 0.5;
    const heightScore = paneHeight >= MIN_COMFORTABLE_HEIGHT * 1.5 ? 1 : 0.7;
    const score = widthScore * heightScore;

    if (score > bestScore) {
      bestScore = score;
      bestCols = cols;
    }
  }

  // If no valid layout found, fall back to what gives best height
  if (bestScore === -1) {
    // Find column count that maximizes height while keeping width above minimum
    for (let cols = numPanes; cols >= 1; cols--) {
      const bordersWidth = cols - 1;
      const paneWidth = Math.floor((contentWidth - bordersWidth) / cols);

      if (paneWidth >= MIN_COMFORTABLE_WIDTH * 0.8) { // Allow slightly narrower
        bestCols = cols;
        break;
      }
    }
  }

  return bestCols;
};
