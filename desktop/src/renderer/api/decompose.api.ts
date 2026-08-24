import { invoke } from './ipc';
import { IPC } from '../../shared/ipc-channels';
import type { DecomposeGenerateRequest, DecomposeGenerateResponse } from '../../shared/kanban-types';

export function generateDecomposition(request: DecomposeGenerateRequest): Promise<DecomposeGenerateResponse> {
  return invoke<DecomposeGenerateResponse>(IPC.DECOMPOSE_GENERATE, request);
}
