import { describe, expect, it, vi } from 'vitest';
import { recoverTerminalRenderersAfterChildProcessExit } from '../../src/main/services/terminal-renderer-recovery';
import { IPC_EVENT } from '../../src/shared/ipc-channels';

function createWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    },
  };
}

describe('recoverTerminalRenderersAfterChildProcessExit', () => {
  it('notifies the renderer after the GPU process exits', () => {
    const window = createWindow();

    const notified = recoverTerminalRenderersAfterChildProcessExit(window, 'GPU');

    expect(notified).toBe(true);
    expect(window.webContents.send).toHaveBeenCalledOnce();
    expect(window.webContents.send).toHaveBeenCalledWith(IPC_EVENT.TERMINAL_RENDERER_RESET);
  });

  it('ignores non-GPU child process exits', () => {
    const window = createWindow();

    const notified = recoverTerminalRenderersAfterChildProcessExit(window, 'Utility');

    expect(notified).toBe(false);
    expect(window.webContents.send).not.toHaveBeenCalled();
  });

  it('does not notify a destroyed renderer', () => {
    const window = createWindow();
    window.webContents.isDestroyed.mockReturnValue(true);

    const notified = recoverTerminalRenderersAfterChildProcessExit(window, 'GPU');

    expect(notified).toBe(false);
    expect(window.webContents.send).not.toHaveBeenCalled();
  });
});
