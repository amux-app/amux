import { IPC, IPC_EVENT } from '../../shared/ipc-channels';
import type {
  LspAcquireRequest,
  LspAcquireResponse,
  LspEvent,
  LspReleaseRequest,
  LspSendRequest,
} from '../../shared/ipc-types';
import { invoke, on } from './ipc';

export function acquireLsp(request: LspAcquireRequest): Promise<LspAcquireResponse> {
  return invoke<LspAcquireResponse>(IPC.LSP_ACQUIRE, request);
}

export function releaseLsp(request: LspReleaseRequest): Promise<{ success: true }> {
  return invoke<{ success: true }>(IPC.LSP_RELEASE, request);
}

export function sendLsp(request: LspSendRequest): Promise<{ accepted: boolean }> {
  return invoke<{ accepted: boolean }>(IPC.LSP_SEND, request);
}

export function subscribeLspEvents(listener: (event: LspEvent) => void): () => void {
  return on(IPC_EVENT.LSP_EVENT, (event) => {
    if (typeof event !== 'object' || event === null || !('rootId' in event) || !('type' in event)) return;
    const candidate = event as Partial<LspEvent>;
    if (typeof candidate.rootId !== 'string') return;
    if (candidate.type === 'message' && typeof (candidate as { message?: unknown }).message === 'string') {
      listener(candidate as Extract<LspEvent, { type: 'message' }>);
    } else if (candidate.type === 'status' && typeof (candidate as { status?: unknown }).status === 'string') {
      listener(candidate as Extract<LspEvent, { type: 'status' }>);
    }
  });
}
