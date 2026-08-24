import { getWindowDimensions } from './tmux.js';
import { TmuxService } from '../services/TmuxService.js';
import { LogService } from '../services/LogService.js';
import { TMUX_PANE_CREATION_DELAY } from '../constants/timing.js';
import { LayoutCalculator, type LayoutConfiguration } from '../layout/LayoutCalculator.js';
import { SpacerManager } from '../layout/SpacerManager.js';
import { TmuxLayoutApplier } from '../layout/TmuxLayoutApplier.js';

const LOG_SCOPE = 'Layout';

export interface LayoutConfig {
  SIDEBAR_WIDTH: number;
  MIN_COMFORTABLE_WIDTH: number;
  MAX_COMFORTABLE_WIDTH: number;
  MIN_COMFORTABLE_HEIGHT: number;
}

export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = {
  SIDEBAR_WIDTH: 40,
  MIN_COMFORTABLE_WIDTH: 50,
  MAX_COMFORTABLE_WIDTH: 80,
  MIN_COMFORTABLE_HEIGHT: 15,
};

export const SIDEBAR_WIDTH = DEFAULT_LAYOUT_CONFIG.SIDEBAR_WIDTH;
export type { LayoutConfiguration };

type ControlPaneLocator = Pick<TmuxService, 'paneExists' | 'getPanePositionsSync'>;

export async function resolveControlPaneId(
  tmuxService: ControlPaneLocator,
  controlPaneId: string,
): Promise<string> {
  if (await tmuxService.paneExists(controlPaneId)) return controlPaneId;

  try {
    const positions = tmuxService.getPanePositionsSync();
    let smallestPaneAtLeft: { id: string; width: number } | null = null;

    for (const pos of positions) {
      if (pos.left === 0 && (!smallestPaneAtLeft || pos.width < smallestPaneAtLeft.width)) {
        smallestPaneAtLeft = { id: pos.paneId, width: pos.width };
      }
    }

    return smallestPaneAtLeft?.id ?? controlPaneId;
  } catch {
    return controlPaneId;
  }
}

let lastLayoutDimensions: { width: number; height: number; paneCount: number } | null = null;

export async function recalculateAndApplyLayout(
  controlPaneId: string,
  contentPaneIds: string[],
  terminalWidth: number,
  terminalHeight: number,
  config: LayoutConfig = DEFAULT_LAYOUT_CONFIG
): Promise<void> {
  if (terminalWidth <= 0 || terminalHeight <= 0) {
    LogService.getInstance().warn(
      `Invalid terminal dimensions: ${terminalWidth}x${terminalHeight}, skipping layout`,
      LOG_SCOPE
    );
    return;
  }

  const calculator = new LayoutCalculator(config);
  const spacerManager = new SpacerManager(config);
  const layoutApplier = new TmuxLayoutApplier(config);

  let existingSpacerId: string | null = null;
  try {
    existingSpacerId = spacerManager.findSpacerPane();
  } catch (error) {
    LogService.getInstance().debug(`Failed to find spacer pane: ${error}`, LOG_SCOPE);
  }

  const tmuxService = TmuxService.getInstance();
  let validContentPaneIds: string[];
  try {
    const allTmuxPaneIds = tmuxService.getAllPaneIdsSync();
    validContentPaneIds = contentPaneIds.filter(id => {
      if (id === existingSpacerId) return false;
      if (!allTmuxPaneIds.includes(id)) {
        LogService.getInstance().debug(`Skipping stale pane ID ${id} (no longer exists in tmux)`, LOG_SCOPE);
        return false;
      }
      return true;
    });
  } catch (error) {
    LogService.getInstance().debug(`Failed to validate pane IDs: ${error}`, LOG_SCOPE);
    validContentPaneIds = contentPaneIds.filter(id => id !== existingSpacerId);
  }
  const realContentPanes = validContentPaneIds;

  const dimensionsUnchanged =
    lastLayoutDimensions &&
    lastLayoutDimensions.width === terminalWidth &&
    lastLayoutDimensions.height === terminalHeight &&
    lastLayoutDimensions.paneCount === realContentPanes.length;

  if (dimensionsUnchanged) {
    return;
  }

  LogService.getInstance().info(
    `Layout dimensions changed: ${terminalWidth}x${terminalHeight}, ${realContentPanes.length} panes`,
    LOG_SCOPE
  );

  lastLayoutDimensions = {
    width: terminalWidth,
    height: terminalHeight,
    paneCount: realContentPanes.length,
  };

  const layout = calculator.calculateOptimalLayout(
    realContentPanes.length,
    terminalWidth,
    terminalHeight
  );

  const needsSpacer = spacerManager.needsSpacerPane(realContentPanes.length, layout);
  let spacerId: string | null = null;

  if (existingSpacerId) {
    spacerManager.destroySpacerPane(existingSpacerId);
  }

  if (needsSpacer) {
    try {
      const lastContentPaneId = realContentPanes[realContentPanes.length - 1];
      if (!lastContentPaneId) {
        throw new Error('No content panes available to split from');
      }
      spacerId = spacerManager.createSpacerPane(lastContentPaneId);

      await new Promise(resolve => setTimeout(resolve, TMUX_PANE_CREATION_DELAY));

      let paneVerified = false;
      for (let attempts = 0; attempts < 3; attempts++) {
        try {
          const allPaneIds = tmuxService.getAllPaneIdsSync();

          if (allPaneIds.includes(spacerId)) {
            paneVerified = true;
            break;
          }
        } catch {
          if (attempts < 2) await new Promise(resolve => setTimeout(resolve, TMUX_PANE_CREATION_DELAY));
        }
      }

      if (!paneVerified) {
        LogService.getInstance().warn(
          `Spacer pane ${spacerId} not verified, continuing anyway`,
          LOG_SCOPE
        );
      }
    } catch {
      spacerId = null;
    }
  }

  let finalContentPanes = spacerId ? [...realContentPanes, spacerId] : realContentPanes;

  // Tmux applies layout geometry by pane index order, so spacer must be last.
  const paneIndices = new Map<string, number>();
  try {
    const indexOutput = tmuxService.listPanesSync('#{pane_id}=#{pane_index}');
    const indexLines = indexOutput.split('\n').filter(l => l.trim());

    indexLines.forEach(line => {
      const [paneId, indexStr] = line.split('=');
      if (paneId && indexStr) {
        paneIndices.set(paneId, parseInt(indexStr, 10));
      }
    });

    finalContentPanes = finalContentPanes.sort((a, b) => {
      if (a === spacerId) return 1;
      if (b === spacerId) return -1;
      const indexA = paneIndices.get(a) || 0;
      const indexB = paneIndices.get(b) || 0;
      return indexA - indexB;
    });
  } catch {
    // index sort is best-effort; fall through with original ordering
  }

  const finalLayout = spacerId
    ? calculator.calculateOptimalLayout(finalContentPanes.length, terminalWidth, terminalHeight)
    : layout;

  // Resize sidebar before window to prevent tmux redistributing width changes to the sidebar.
  const actualControlPaneId = await resolveControlPaneId(tmuxService, controlPaneId);

  const currentWindowDims = getWindowDimensions();
  const statusBarHeight = tmuxService.getStatusBarHeightSync();
  const targetWindowHeight = terminalHeight - statusBarHeight;

  const needsWindowResize =
    currentWindowDims.width !== finalLayout.windowWidth ||
    currentWindowDims.height !== targetWindowHeight;

  if (needsWindowResize) {
    layoutApplier.setWindowDimensions(finalLayout.windowWidth, terminalHeight);
    await new Promise(resolve => setTimeout(resolve, TMUX_PANE_CREATION_DELAY));
  }

  // Re-validate panes right before applying to avoid "invalid layout" when a pane is
  // killed between calculation and application.
  try {
    const currentPaneIds = tmuxService.getAllPaneIdsSync();
    const validFinalPanes = finalContentPanes.filter(id => {
      if (!currentPaneIds.includes(id)) {
        LogService.getInstance().debug(`Pane ${id} disappeared before layout application`, LOG_SCOPE);
        return false;
      }
      return true;
    });

    if (validFinalPanes.length < finalContentPanes.length - (spacerId ? 1 : 0)) {
      LogService.getInstance().warn(
        `Panes changed during layout calculation (${finalContentPanes.length} → ${validFinalPanes.length}), skipping layout apply`,
        LOG_SCOPE
      );
      return;
    }

    if (!currentPaneIds.includes(actualControlPaneId)) {
      LogService.getInstance().warn(
        `Control pane ${actualControlPaneId} no longer exists, skipping layout apply`,
        LOG_SCOPE
      );
      return;
    }

    layoutApplier.applyPaneLayout(actualControlPaneId, validFinalPanes, finalLayout, terminalHeight);
  } catch (validationError) {
    LogService.getInstance().debug(`Final validation failed: ${validationError}, attempting layout anyway`, LOG_SCOPE);
    layoutApplier.applyPaneLayout(actualControlPaneId, finalContentPanes, finalLayout, terminalHeight);
  }
}

export function calculateOptimalLayout(
  numContentPanes: number,
  terminalWidth: number,
  terminalHeight: number,
  config: LayoutConfig = DEFAULT_LAYOUT_CONFIG
): LayoutConfiguration {
  const calculator = new LayoutCalculator(config);
  return calculator.calculateOptimalLayout(numContentPanes, terminalWidth, terminalHeight);
}
