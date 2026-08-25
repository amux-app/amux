import { IPC } from '../../shared/ipc-channels.js';
import type { MuxBaseBridge } from '../services/MuxBaseBridge.js';
import { secureHandle } from './ipc-security.js';

/** Activity has a dedicated snapshot transport so config refreshes cannot overwrite it. */
export function registerPaneActivityHandlers(bridge: MuxBaseBridge): void {
  secureHandle(IPC.PANE_ACTIVITY_SNAPSHOT_GET, () => bridge.getPaneActivitySnapshot());
}
