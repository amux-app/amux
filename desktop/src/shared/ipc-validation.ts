import { IPC, IPC_EVENT } from './ipc-channels.js';

const IPC_INVOKE_CHANNELS = new Set<string>(Object.values(IPC));
const IPC_EVENT_CHANNELS = new Set<string>(Object.values(IPC_EVENT));

export function isIpcEventChannel(channel: string): boolean {
  return IPC_EVENT_CHANNELS.has(channel);
}

export function isIpcInvokeChannel(channel: string): boolean {
  return IPC_INVOKE_CHANNELS.has(channel);
}
