import type { AumxElectronAPI } from '../shared/ipc-types';

declare global {
  interface Window {
    aumx: AumxElectronAPI;
  }
}
