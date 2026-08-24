import { useEffect } from 'react';
import { on } from '../api/ipc';
import { rendererLog } from '../lib/rendererLog';

export function useIpcListener(channel: string, callback: (...args: unknown[]) => void): void {
  useEffect(() => {
    const unsubscribe = on(channel, (...args) => {
      try {
        callback(...args);
      } catch (error) {
        rendererLog.error('ipc', 'Listener failed', { channel, error });
      }
    });
    return unsubscribe;
  }, [channel, callback]);
}
