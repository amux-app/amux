import type { MuxBaseElectronAPI } from '../shared/ipc-types';

declare global {
  interface Window {
    muxbase: MuxBaseElectronAPI;
  }
}
