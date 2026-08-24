import { contextBridge, ipcRenderer } from 'electron';
import { IPC_SYNC } from '../shared/ipc-channels.js';
import type { AumxBootSettings, AumxElectronAPI } from '../shared/ipc-types.js';
import { isIpcEventChannel, isIpcInvokeChannel } from '../shared/ipc-validation.js';

const bootSettings: AumxBootSettings = ipcRenderer.sendSync(IPC_SYNC.APP_BOOT_SETTINGS);

const api: AumxElectronAPI = {
  bootSettings,
  invoke: <T = unknown>(channel: string, ...args: unknown[]): Promise<T> => {
    if (!isIpcInvokeChannel(channel)) {
      return Promise.reject(new Error(`Unsupported IPC invoke channel: ${channel}`));
    }

    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel: string, callback: (...args: unknown[]) => void): (() => void) => {
    if (!isIpcEventChannel(channel)) {
      throw new Error(`Unsupported IPC event channel: ${channel}`);
    }

    const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void => {
      callback(...args);
    };
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
};

contextBridge.exposeInMainWorld('aumx', api);

if (process.env.NODE_ENV === 'test' && process.env.AUMX_E2E === '1') {
  contextBridge.exposeInMainWorld('__AUMX_E2E', true);
}
