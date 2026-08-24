import { hasValidPaneTerminalProfile } from 'aumx/core';
import { IPC } from '../../shared/ipc-channels.js';
import type {
  TerminalAttachRequest,
  TerminalDetachRequest,
  TerminalResizeRequest,
  TerminalSelectionExpandRequest,
  TerminalScrollRequest,
  TerminalScrollResponse,
  TerminalWriteRequest,
  TerminalUnlockStdinRequest,
} from '../../shared/ipc-types.js';
import type { AumxBridge } from '../services/AumxBridge.js';
import { log } from '../services/Logger.js';
import { getTerminalManager } from '../services/TerminalStreamService.js';
import { isTerminalPaneMissingError } from '../services/terminal-pane-dimensions.js';
import { validateFilePath } from '../utils/file-root-authorization.js';
import { formatError } from '../utils/formatError.js';
import { getTranscriptDir } from '../utils/tmux-transcript.js';
import { secureHandle } from './ipc-security.js';

function containedTranscriptPath(transcriptRoot: string, requestedPath: string): string | undefined {
  try {
    return validateFilePath(transcriptRoot, requestedPath);
  } catch {
    return undefined;
  }
}

function authorizeTranscriptPath(paneId: string, requestedPath: string): string | undefined {
  const transcriptRoot = getTranscriptDir();
  const authorizedPath = transcriptRoot ? containedTranscriptPath(transcriptRoot, requestedPath) : undefined;
  if (!authorizedPath) {
    log.warn('ipc:terminal', 'Rejected transcript path outside the transcript root', {
      paneId,
      requestedTranscriptPath: requestedPath,
      transcriptRoot,
    });
  }
  return authorizedPath;
}

/**
 * Pane state owns the transcript path, but it is still persisted input and must
 * remain inside the directory transcripts are written to. The renderer copy is
 * only consulted while pane state has not caught up yet (config reload, attach
 * before reconcile), under the same directory boundary.
 */
function resolveTranscriptPath(
  paneId: string,
  ownedPath: string | undefined,
  rendererPath: string | undefined,
): string | undefined {
  if (ownedPath) return authorizeTranscriptPath(paneId, ownedPath);
  if (!rendererPath) return undefined;

  return authorizeTranscriptPath(paneId, rendererPath);
}

export function registerTerminalHandlers(bridge: AumxBridge): void {
  secureHandle(IPC.TERMINAL_ATTACH, async (_event, request: TerminalAttachRequest) => {
    const pane = bridge.getPanes().find((candidate) => candidate.id === request.paneId);
    if (!pane) {
      log.warn('ipc:terminal', 'Rejected terminal attach for an unauthorized pane', {
        paneId: request.paneId,
      });
      return { error: 'Unauthorized terminal pane', success: false };
    }
    if (!hasValidPaneTerminalProfile(pane)) {
      log.error('ipc:terminal', 'Rejected terminal attach for an invalid persisted renderer profile', {
        claudeRenderer: pane.claudeRenderer,
        paneId: pane.id,
        terminalFixedCols: pane.terminalFixedCols,
      });
      return { error: 'Invalid persisted Claude terminal profile', success: false };
    }

    const activeSessionName = bridge.getSessionName() || request.sessionName;
    const transcriptPath = resolveTranscriptPath(
      request.paneId,
      pane.terminalTranscriptPath,
      request.transcriptPath,
    );
    log.info('ipc:terminal', 'TERMINAL_ATTACH', {
      cols: request.cols,
      paneId: request.paneId,
      requestedSessionName: request.sessionName,
      rows: request.rows,
      sessionName: activeSessionName,
      tmuxPaneId: pane.paneId,
    });
    try {
      const manager = getTerminalManager(bridge);
      manager.setWindow(bridge.getWindow());
      const { cols, mode, rows, streamId } = await manager.attach(
        request.paneId,
        activeSessionName,
        pane.paneId,
        transcriptPath,
        request.cols && request.rows ? { cols: request.cols, rows: request.rows } : undefined,
        request.skipScrollbackReplay === true,
        request.streamId,
        pane.terminalFixedCols,
        pane.agent === 'claude' && pane.claudeRenderer === 'fullscreen' ? true : undefined,
      );
      return { success: true, cols, mode, rows, streamId };
    } catch (error) {
      log.error('ipc:terminal', 'TERMINAL_ATTACH failed', error);
      if (isTerminalPaneMissingError(error)) {
        await bridge.syncPanes();
      }
      return { success: false, error: formatError(error) };
    }
  });

  secureHandle(IPC.TERMINAL_DETACH, (_event, request: TerminalDetachRequest) => {
    log.info('ipc:terminal', 'TERMINAL_DETACH', { paneId: request.paneId });
    try {
      const manager = getTerminalManager(bridge);
      manager.detach(request.paneId);
      return { success: true };
    } catch (error) {
      log.error('ipc:terminal', 'TERMINAL_DETACH failed', error);
      return { error: formatError(error) };
    }
  });

  secureHandle(IPC.TERMINAL_RESIZE, async (_event, request: TerminalResizeRequest) => {
    log.debug('ipc:terminal', 'TERMINAL_RESIZE', { paneId: request.paneId, cols: request.cols, rows: request.rows });
    try {
      const manager = getTerminalManager(bridge);
      manager.setWindow(bridge.getWindow());
      await manager.resize(request.paneId, request.cols, request.rows);
      return { success: true };
    } catch (error) {
      log.error('ipc:terminal', 'TERMINAL_RESIZE failed', error);
      return { error: formatError(error), success: false };
    }
  });

  secureHandle(IPC.TERMINAL_SELECTION_EXPAND, async (_event, request: TerminalSelectionExpandRequest) => {
    const pane = bridge.getPanes().find((candidate) => candidate.id === request.paneId);
    if (!pane) return { status: 'history-unavailable' };
    try {
      const manager = getTerminalManager(bridge);
      return await manager.expandSelection(
        request.paneId,
        request.anchorText,
        request.currentText,
        request.direction,
      );
    } catch (error) {
      log.warn('ipc:terminal', 'TERMINAL_SELECTION_EXPAND failed', {
        error: formatError(error),
        paneId: request.paneId,
      });
      return { status: 'history-unavailable' };
    }
  });

  secureHandle(IPC.TERMINAL_SCROLL, async (_event, request: TerminalScrollRequest): Promise<TerminalScrollResponse> => {
    log.debug('ipc:terminal', 'TERMINAL_SCROLL', {
      alternateScreenMode: request.alternateScreenMode,
      direction: request.direction,
      lines: request.lines,
      paneId: request.paneId,
    });
    const manager = getTerminalManager(bridge);
    return manager.scroll(
      request.paneId,
      request.direction,
      request.lines,
      request.alternateScreenMode,
    );
  });

  secureHandle(IPC.TERMINAL_WRITE, async (_event, request: TerminalWriteRequest) => {
    try {
      const manager = getTerminalManager(bridge);
      await manager.write(request.paneId, request.data, request.userInitiated ?? true);
      return { success: true };
    } catch (error) {
      log.error('ipc:terminal', 'TERMINAL_WRITE failed', error);
      return { error: formatError(error) };
    }
  });

  secureHandle(IPC.TERMINAL_UNLOCK_STDIN, (_event, request: TerminalUnlockStdinRequest) => {
    const manager = getTerminalManager(bridge);
    manager.unlockStdin(request.paneId);
    return { success: true };
  });
}
