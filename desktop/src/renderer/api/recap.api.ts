import { invoke } from './ipc';
import { IPC } from '../../shared/ipc-channels';
import type { RecapGenerateRequest, RecapGenerateResponse } from '../../shared/recap-types';

export function generateRecap(request: RecapGenerateRequest): Promise<RecapGenerateResponse> {
  return invoke<RecapGenerateResponse>(IPC.RECAP_GENERATE, request);
}
