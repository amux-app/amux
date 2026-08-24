import { IPC, IPC_EVENT } from '../../shared/ipc-channels';
import type { AppUpdateSnapshot } from '../../shared/app-update-types';
import { invoke, on } from './ipc';

export interface UpdateInstallResponse {
  accepted: boolean;
}

export function getUpdateState(): Promise<AppUpdateSnapshot> {
  return invoke<AppUpdateSnapshot>(IPC.UPDATE_STATE_GET);
}

export function checkForUpdates(): Promise<AppUpdateSnapshot> {
  return invoke<AppUpdateSnapshot>(IPC.UPDATE_CHECK);
}

export function installUpdate(): Promise<UpdateInstallResponse> {
  return invoke<UpdateInstallResponse>(IPC.UPDATE_INSTALL);
}

export function subscribeToUpdateState(listener: (payload: unknown) => void): () => void {
  return on(IPC_EVENT.UPDATE_STATE_CHANGED, listener);
}
