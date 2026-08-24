import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  createElectronUpdateClient,
  createElectronUpdateService,
} from '../../src/main/services/ElectronUpdateService';

class FakeAppUpdater extends EventEmitter {
  allowDowngrade = true;
  allowPrerelease = true;
  autoDownload = false;
  autoInstallOnAppQuit = false;
  fullChangelog = true;
  checkForUpdates = vi.fn(() => Promise.resolve(null));
  checkForUpdatesAndNotify = vi.fn(() => Promise.resolve(null));
  quitAndInstall = vi.fn();
}

describe('ElectronUpdateService', () => {
  it('adapts explicit updater checks and supports deterministic listener cleanup', async () => {
    const rawUpdater = new FakeAppUpdater();
    const client = createElectronUpdateClient(rawUpdater);
    const onAvailable = vi.fn();
    const unsubscribe = client.on('update-available', onAvailable);

    await client.checkForUpdates();
    rawUpdater.emit('update-available', { version: '0.2.0' });
    unsubscribe();
    rawUpdater.emit('update-available', { version: '0.3.0' });

    expect(rawUpdater.checkForUpdates).toHaveBeenCalledOnce();
    expect(rawUpdater.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    expect(onAvailable).toHaveBeenCalledOnce();
    expect(onAvailable).toHaveBeenCalledWith({ version: '0.2.0' });
  });

  it('creates a disabled service for a packaged app outside Applications', () => {
    const rawUpdater = new FakeAppUpdater();
    const service = createElectronUpdateService({
      currentVersion: '0.1.0',
      isDev: false,
      isInApplicationsFolder: false,
      isPackaged: true,
      platform: 'darwin',
      updater: rawUpdater,
    });

    expect(service.start()).toBe(false);
    expect(service.getSnapshot()).toMatchObject({
      disabledReason: 'not-in-applications',
      phase: 'disabled',
    });
    expect(rawUpdater.checkForUpdates).not.toHaveBeenCalled();
  });
});
