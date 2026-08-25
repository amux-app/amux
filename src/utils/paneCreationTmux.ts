import * as fs from 'fs';
import type { LogService } from '../services/LogService.js';
import type { TmuxService } from '../services/TmuxService.js';
import type { MuxBaseConfig } from '../types.js';
import { SIDEBAR_WIDTH } from './layoutManager.js';
import { updateMuxBaseControlFields } from './muxbaseConfigMutation.js';
import { ensureMinimumWindowSize, setupSidebarLayout, splitPane } from './tmux.js';

type PaneCreationLog = Pick<LogService, 'error' | 'info' | 'warn'>;
type PaneCreationTmux = Pick<
  TmuxService,
  'getPaneSessionName' | 'newWindowPane' | 'paneExists'
>;

interface ResolveControlPaneOptions {
  configPath: string;
  log: PaneCreationLog;
  originalPaneId: string;
  providedControlPaneId?: string;
  tmuxService: PaneCreationTmux;
}

export async function resolveControlPane({
  configPath,
  log,
  originalPaneId,
  providedControlPaneId,
  tmuxService,
}: ResolveControlPaneOptions): Promise<string> {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as MuxBaseConfig;
    let controlPaneId = config.controlPaneId;

    if (controlPaneId && !providedControlPaneId) {
      const exists = await tmuxService.paneExists(controlPaneId);
      if (!exists) {
        log.warn(
          `Control pane ${controlPaneId} no longer exists, updating to ${originalPaneId}`,
          'paneCreation',
        );
        controlPaneId = originalPaneId;
        updateMuxBaseControlFields(configPath, {
          controlPaneId,
          controlPaneSize: SIDEBAR_WIDTH,
        });
      }
    }

    if (!controlPaneId) {
      controlPaneId = originalPaneId;
      updateMuxBaseControlFields(configPath, {
        controlPaneId,
        controlPaneSize: SIDEBAR_WIDTH,
      });
    }

    return controlPaneId;
  } catch {
    return originalPaneId;
  }
}

interface AllocateTmuxPaneOptions {
  configPath: string;
  controlPaneId: string;
  existingPaneIds: string[];
  isFirstContentPane: boolean;
  layoutMode: 'sidebar' | 'window';
  log: PaneCreationLog;
  originalPaneId: string;
  paneCwd: string;
  requestedSessionName?: string;
  tmuxService: PaneCreationTmux;
}

interface TmuxPaneAllocation {
  controlPaneId: string;
  paneId: string;
  usedWindowFallback: boolean;
}

function isNoSpaceForPaneError(message: string): boolean {
  return message.toLowerCase().includes('no space for new pane');
}

export async function allocateTmuxPane({
  configPath,
  controlPaneId: initialControlPaneId,
  existingPaneIds,
  isFirstContentPane,
  layoutMode,
  log,
  originalPaneId,
  paneCwd,
  requestedSessionName,
  tmuxService,
}: AllocateTmuxPaneOptions): Promise<TmuxPaneAllocation> {
  let controlPaneId = initialControlPaneId;

  const createWindowPane = async (): Promise<string> => {
    let sessionName = requestedSessionName;
    if (!sessionName) {
      sessionName = await tmuxService.getPaneSessionName(controlPaneId) || undefined;
    }
    return tmuxService.newWindowPane({ sessionName, cwd: paneCwd });
  };

  const createSidebarPane = (): string => {
    if (isFirstContentPane) {
      return setupSidebarLayout(controlPaneId, paneCwd);
    }

    const targetPane = existingPaneIds[existingPaneIds.length - 1];
    ensureMinimumWindowSize(targetPane);
    return splitPane({ targetPane, cwd: paneCwd });
  };

  if (layoutMode === 'window') {
    return {
      controlPaneId,
      paneId: await createWindowPane(),
      usedWindowFallback: true,
    };
  }

  try {
    return {
      controlPaneId,
      paneId: createSidebarPane(),
      usedWindowFallback: false,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (isNoSpaceForPaneError(errorMessage)) {
      log.warn('No space for sidebar split; falling back to new window', 'paneCreation');
      return {
        controlPaneId,
        paneId: await createWindowPane(),
        usedWindowFallback: true,
      };
    }

    if (!errorMessage.includes("can't find pane")) {
      throw error;
    }

    log.warn('Pane creation failed with stale control pane ID, self-healing', 'paneCreation');
    log.info(
      `Updating controlPaneId from ${controlPaneId} to ${originalPaneId}`,
      'paneCreation',
    );

    try {
      updateMuxBaseControlFields(configPath, { controlPaneId: originalPaneId });
      controlPaneId = originalPaneId;
    } catch (configError) {
      log.error(
        `Failed to update config after control pane recovery: ${configError}`,
        'paneCreation',
      );
      throw error;
    }

    try {
      return {
        controlPaneId,
        paneId: createSidebarPane(),
        usedWindowFallback: false,
      };
    } catch (retryError) {
      const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
      if (!isNoSpaceForPaneError(retryMessage)) {
        throw retryError;
      }

      log.warn(
        'No space for sidebar split after recovery; falling back to new window',
        'paneCreation',
      );
      return {
        controlPaneId,
        paneId: await createWindowPane(),
        usedWindowFallback: true,
      };
    }
  }
}
