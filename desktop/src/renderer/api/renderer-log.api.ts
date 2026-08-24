import { IPC } from '../../shared/ipc-channels';
import type { RendererLogRequest } from '../../shared/ipc-types';
import { invoke } from './ipc';

export function writeRendererLog(request: RendererLogRequest): Promise<void> {
  return invoke<void>(IPC.RENDERER_LOG, request);
}
