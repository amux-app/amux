import { describe, expect, it, vi } from 'vitest';
import {
  configureWindowStatePersistence,
  destroyWindowWithPersistedState,
} from '../../src/main/window-state';

describe('configureWindowStatePersistence', () => {
  it('tracks normal bounds without restoring stale maximized or fullscreen state', () => {
    const win = {
      maximize: vi.fn(),
      setFullScreen: vi.fn(),
      once: vi.fn(),
    };
    const windowState = {
      isFullScreen: true,
      isMaximized: true,
      manage: vi.fn(),
    };

    configureWindowStatePersistence(win, windowState);

    expect(windowState.manage).toHaveBeenCalledWith(win);
    expect(win.once).not.toHaveBeenCalled();
    expect(win.maximize).not.toHaveBeenCalled();
    expect(win.setFullScreen).not.toHaveBeenCalled();
  });
});

describe('destroyWindowWithPersistedState', () => {
  it('saves the latest window bounds before a confirmed quit destroys the window', () => {
    const win = {
      destroy: vi.fn(),
    };
    const windowState = {
      saveState: vi.fn(),
    };

    destroyWindowWithPersistedState(win, windowState);

    expect(windowState.saveState).toHaveBeenCalledWith(win);
    expect(windowState.saveState.mock.invocationCallOrder[0])
      .toBeLessThan(win.destroy.mock.invocationCallOrder[0]);
  });
});
