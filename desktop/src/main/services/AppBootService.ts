import { IPC_EVENT } from '../../shared/ipc-channels.js';
import type { AppBootState } from '../../shared/ipc-types.js';

interface BootWebContents {
  isDestroyed(): boolean;
  send(channel: string, state: AppBootState): void;
}

interface BootWindow {
  isDestroyed(): boolean;
  webContents: BootWebContents;
}

export class AppBootService {
  private state: AppBootState = { phase: 'starting', revision: 0 };

  constructor(private readonly getWindow: () => BootWindow | null) {}

  getState(): AppBootState {
    return this.state;
  }

  setReady(): AppBootState {
    return this.transition({ phase: 'ready' });
  }

  setBlocked(errors: string[]): AppBootState {
    return this.transition({ errors: [...errors], phase: 'blocked' });
  }

  setFailed(message: string): AppBootState {
    return this.transition({ message, phase: 'failed' });
  }

  private transition(
    next:
      | { phase: 'ready' }
      | { phase: 'blocked'; errors: string[] }
      | { phase: 'failed'; message: string },
  ): AppBootState {
    if (this.state.phase !== 'starting') return this.state;

    const state = { ...next, revision: this.state.revision + 1 } as AppBootState;
    this.state = state;

    const targetWindow = this.getWindow();
    if (
      targetWindow
      && !targetWindow.isDestroyed()
      && !targetWindow.webContents.isDestroyed()
    ) {
      targetWindow.webContents.send(IPC_EVENT.APP_BOOT_STATE_CHANGED, state);
    }
    return state;
  }
}
