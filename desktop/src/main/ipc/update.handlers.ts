import { IPC } from '../../shared/ipc-channels.js';
import type { UpdateService } from '../services/UpdateService.js';
import { secureHandle } from './ipc-security.js';

export function registerUpdateHandlers(service: UpdateService): void {
  secureHandle(IPC.UPDATE_STATE_GET, () => service.getSnapshot());
  secureHandle(IPC.UPDATE_CHECK, () => service.checkForUpdates(true));
  secureHandle(IPC.UPDATE_INSTALL, async () => ({ accepted: await service.installUpdate() }));
}
