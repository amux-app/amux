import { IPC } from '../../shared/ipc-channels.js';
import type { RecapGenerateRequest } from '../../shared/recap-types.js';
import type { MuxBaseBridge } from '../services/MuxBaseBridge.js';
import { generateRecap } from '../services/recapGenerator.js';
import { log } from '../services/Logger.js';
import { secureHandle } from './ipc-security.js';

export function registerRecapHandlers(_bridge: MuxBaseBridge): void {
  secureHandle(IPC.RECAP_GENERATE, async (_event, request: RecapGenerateRequest) => {
    log.info('ipc:recap', 'RECAP_GENERATE', {
      paneId: request.paneId,
      chunkIndex: request.chunkIndex,
      messageCount: request.messages.length,
    });

    const result = await generateRecap(request.messages);

    if (result.error) {
      log.warn('ipc:recap', 'RECAP_GENERATE failed', { error: result.error });
    }

    return result;
  });
}
