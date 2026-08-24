import { IPC } from '../../shared/ipc-channels.js';
import type { RendererLogRequest } from '../../shared/ipc-types.js';
import { log } from '../services/Logger.js';
import { secureHandle } from './ipc-security.js';

const RENDERER_TAG_PREFIX = 'renderer:';

export function registerRendererLogHandlers(): void {
  secureHandle(IPC.RENDERER_LOG, (_event, request: RendererLogRequest) => {
    const tag = `${RENDERER_TAG_PREFIX}${request.scope}`;
    log[request.level](tag, request.message, request.data);
  });
}
