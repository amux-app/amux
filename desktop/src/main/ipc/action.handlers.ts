import { IPC } from '../../shared/ipc-channels.js';
import type { ActionCallbackRequest } from '../../shared/ipc-types.js';
import type { MuxBaseBridge } from '../services/MuxBaseBridge.js';
import { formatError } from '../utils/formatError.js';
import { secureHandle } from './ipc-security.js';
import { log } from '../services/Logger.js';

export function registerActionHandlers(bridge: MuxBaseBridge): void {
  secureHandle(IPC.ACTION_CALLBACK, async (_event, request: ActionCallbackRequest) => {
    log.info('ipc:action', 'ACTION_CALLBACK invoked', { callbackId: request.callbackId, hasValue: !!request.value });
    try {
      const result = await bridge.executeActionCallback(request.callbackId, request.value);
      log.info('ipc:action', 'ACTION_CALLBACK result', { callbackId: request.callbackId, resultType: result.type });
      return result;
    } catch (error) {
      log.error('ipc:action', 'ACTION_CALLBACK failed', error);
      return { type: 'error' as const, message: formatError(error), error: formatError(error) };
    }
  });
}
