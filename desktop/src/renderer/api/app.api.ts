import { IPC } from '../../shared/ipc-channels';
import type { AppBootState, AppFileFlushResultRequest } from '../../shared/ipc-types';
import { invoke } from './ipc';

export function getAppBootState(): Promise<AppBootState> {
  return invoke<AppBootState>(IPC.APP_BOOT_STATE_GET);
}

export function reportFileFlushResult(request: AppFileFlushResultRequest): Promise<boolean> {
  return invoke<boolean>(IPC.APP_FILE_FLUSH_RESULT, request);
}

export function quitApp(): Promise<boolean> {
  return invoke<boolean>(IPC.APP_QUIT);
}

export function relaunchApp(): Promise<boolean> {
  return invoke<boolean>(IPC.APP_RELAUNCH);
}
