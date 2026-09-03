import { IPC_EVENT } from '../../shared/ipc-channels.js';

interface TerminalRendererWindow {
  isDestroyed: () => boolean;
  webContents: {
    isDestroyed: () => boolean;
    send: (channel: string) => void;
  };
}

export function recoverTerminalRenderersAfterChildProcessExit(
  browserWindow: TerminalRendererWindow | null,
  processType: string,
): boolean {
  if (processType !== 'GPU'
    || !browserWindow
    || browserWindow.isDestroyed()
    || browserWindow.webContents.isDestroyed()) {
    return false;
  }

  browserWindow.webContents.send(IPC_EVENT.TERMINAL_RENDERER_RESET);
  return true;
}
