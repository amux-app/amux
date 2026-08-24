import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_EVENT } from '../../src/shared/ipc-channels';
import type { AppBootState } from '../../src/shared/ipc-types';
import { AppBootService } from '../../src/main/services/AppBootService';

const send = vi.fn();
const windowMock = {
  isDestroyed: () => false,
  webContents: {
    isDestroyed: () => false,
    send,
  },
};

describe('AppBootService', () => {
  beforeEach(() => {
    send.mockClear();
  });

  it('starts with a revisioned starting snapshot', () => {
    const service = new AppBootService(() => windowMock);

    expect(service.getState()).toEqual({ phase: 'starting', revision: 0 });
  });

  it('publishes the exact new snapshot after changing phase', () => {
    const service = new AppBootService(() => windowMock);

    const state = service.setReady();

    expect(state).toEqual({ phase: 'ready', revision: 1 });
    expect(service.getState()).toEqual(state);
    expect(send).toHaveBeenCalledWith(IPC_EVENT.APP_BOOT_STATE_CHANGED, state);
  });

  it('does not publish duplicate terminal transitions', () => {
    const service = new AppBootService(() => windowMock);

    service.setReady();
    service.setReady();

    expect(send).toHaveBeenCalledOnce();
    expect(service.getState().revision).toBe(1);
  });

  it('keeps the first terminal state when later work reports another outcome', () => {
    const service = new AppBootService(() => windowMock);

    service.setReady();
    const state = service.setFailed('late failure');

    expect(state).toEqual({ phase: 'ready', revision: 1 });
    expect(send).toHaveBeenCalledOnce();
  });

  it('preserves actionable dependency errors in a blocked state', () => {
    const service = new AppBootService(() => windowMock);

    const state = service.setBlocked(['tmux is not installed', 'git is not installed']);

    expect(state).toEqual<AppBootState>({
      errors: ['tmux is not installed', 'git is not installed'],
      phase: 'blocked',
      revision: 1,
    });
  });

  it('does not send after the application window is destroyed', () => {
    const service = new AppBootService(() => ({
      ...windowMock,
      isDestroyed: () => true,
    }));

    expect(() => service.setFailed('Initialization failed')).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
