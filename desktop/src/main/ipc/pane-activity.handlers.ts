import { IPC } from '../../shared/ipc-channels.js';
import type { AumxBridge } from '../services/AumxBridge.js';
import { secureHandle } from './ipc-security.js';

/** Activity has a dedicated snapshot transport so config refreshes cannot overwrite it. */
export function registerPaneActivityHandlers(bridge: AumxBridge): void {
  secureHandle(IPC.PANE_ACTIVITY_SNAPSHOT_GET, () => bridge.getPaneActivitySnapshot());
}
