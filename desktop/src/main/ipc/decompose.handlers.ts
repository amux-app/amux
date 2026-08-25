import { IPC } from '../../shared/ipc-channels.js';
import type { DecomposeGenerateRequest } from '../../shared/kanban-types.js';
import { decompose } from '../services/DecomposeService.js';
import { log } from '../services/Logger.js';
import type { MuxBaseBridge } from '../services/MuxBaseBridge.js';
import { secureHandle } from './ipc-security.js';
import { authorizeProjectRoot } from '../services/projectRootAuthorization.js';

export function registerDecomposeHandlers(_bridge: MuxBaseBridge): void {
  const bridge = _bridge;
  secureHandle(IPC.DECOMPOSE_GENERATE, async (_event, request: DecomposeGenerateRequest) => {
    log.info('ipc:decompose', 'DECOMPOSE_GENERATE', {
      paneId: request.paneId,
      promptLength: request.prompt.length,
      includeDiff: request.includeDiff,
    });

    const projectRoot = await authorizeProjectRoot(request.projectRoot, bridge.getProjectRoot(), bridge.getPanes());
    const result = await decompose({ ...request, projectRoot: projectRoot ?? bridge.getProjectRoot() });

    if (result.success) {
      log.info('ipc:decompose', 'DECOMPOSE_GENERATE success', { taskCount: result.tasks.length });
    } else {
      log.warn('ipc:decompose', 'DECOMPOSE_GENERATE failed', { error: result.error });
    }

    return result;
  });
}
