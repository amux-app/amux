import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resumeInFullscreen, sendKeys } from '../../src/renderer/api/pane.api';
import { IPC } from '../../src/shared/ipc-channels';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/renderer/api/ipc.js', () => ({
  invoke: invokeMock,
}));

describe('pane API command submission', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('resolves after the backend confirms the command was submitted', async () => {
    invokeMock.mockResolvedValue({ success: true });

    await expect(sendKeys({ command: 'printf ready', paneId: 'pane-3' })).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith(IPC.PANE_SEND_KEYS, {
      command: 'printf ready',
      paneId: 'pane-3',
    });
  });

  it('throws the backend error so renderer callers can surface failed input', async () => {
    invokeMock.mockResolvedValue({ error: 'Terminal input is locked', success: false });

    await expect(sendKeys({ command: 'printf blocked', paneId: 'pane-3' }))
      .rejects.toThrow('Terminal input is locked');
  });

  it('requests a fullscreen resume using only the canonical pane id', async () => {
    invokeMock.mockResolvedValue({ type: 'info', message: 'Exit Claude first' });

    await resumeInFullscreen({ paneId: 'pane-3' });

    expect(invokeMock).toHaveBeenCalledWith(IPC.PANE_RESUME_FULLSCREEN, { paneId: 'pane-3' });
  });
});
