import type { BrowserWindow } from 'electron';
import { IPC_EVENT } from '../../shared/ipc-channels.js';
import type { TerminalDataEvent, TerminalDataSource, TerminalStreamMode, TerminalStreamModeChangedEvent } from '../../shared/ipc-types.js';
import { log } from './Logger.js';

export function sendTerminalData(
  browserWindow: BrowserWindow | null,
  paneId: string,
  data: string,
  source: TerminalDataSource = 'live',
  streamId: number,
): void {
  try {
    if (!browserWindow || browserWindow.isDestroyed()) {
      log.warn('terminal', 'Cannot send — window unavailable', { paneId });
      return;
    }
    const event: TerminalDataEvent = { paneId, data, source, streamId };
    browserWindow.webContents.send(IPC_EVENT.TERMINAL_DATA, event);
  } catch (error) {
    log.debug('terminal', 'sendToRenderer failed', { paneId, error });
  }
}

export function sendTerminalStreamModeChanged(
  browserWindow: BrowserWindow | null,
  paneId: string,
  streamId: number,
  mode: TerminalStreamMode,
): void {
  try {
    if (!browserWindow || browserWindow.isDestroyed()) {
      log.warn('terminal', 'Cannot send — window unavailable', { paneId });
      return;
    }
    const event: TerminalStreamModeChangedEvent = { paneId, streamId, mode };
    browserWindow.webContents.send(IPC_EVENT.TERMINAL_STREAM_MODE_CHANGED, event);
  } catch (error) {
    log.debug('terminal', 'sendTerminalStreamModeChanged failed', { paneId, error });
  }
}
