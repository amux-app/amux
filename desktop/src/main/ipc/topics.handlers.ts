import { IPC } from '../../shared/ipc-channels.js';
import type { MuxBaseBridge } from '../services/MuxBaseBridge.js';
import { log } from '../services/Logger.js';
import { formatError } from '../utils/formatError.js';
import { secureHandle } from './ipc-security.js';

export function registerTopicsHandlers(bridge: MuxBaseBridge): void {
  secureHandle(IPC.TOPICS_LIST, async () => {
    try {
      return { topics: bridge.getAllTopics() };
    } catch (error) {
      log.error('ipc:topics', 'LIST failed', error);
      return { error: formatError(error) };
    }
  });
}
