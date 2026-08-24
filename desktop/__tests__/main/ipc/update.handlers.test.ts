import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../../src/shared/ipc-channels';
import type { AppUpdateSnapshot } from '../../../src/shared/app-update-types';
import { validateIpcInvokeArgs } from '../../../src/main/ipc/ipc-request-validation';
import { registerUpdateHandlers } from '../../../src/main/ipc/update.handlers';
import type { UpdateService } from '../../../src/main/services/UpdateService';

const secureHandleMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/main/ipc/ipc-security.js', () => ({
  secureHandle: (channel: string, handler: unknown) => secureHandleMock(channel, handler),
}));

const readySnapshot: AppUpdateSnapshot = {
  availableVersion: '0.2.0',
  currentVersion: '0.1.0',
  phase: 'ready',
  revision: 4,
};

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const registration = secureHandleMock.mock.calls.find(([registered]) => registered === channel);
  if (!registration) throw new Error(`Missing handler registration for ${channel}`);
  return registration[1] as (...args: unknown[]) => unknown;
}

describe('update IPC handlers', () => {
  beforeEach(() => {
    secureHandleMock.mockClear();
  });

  it('returns only the service snapshot and delegates manual checks and installs', async () => {
    const service = {
      checkForUpdates: vi.fn(() => Promise.resolve(readySnapshot)),
      getSnapshot: vi.fn(() => readySnapshot),
      installUpdate: vi.fn(() => Promise.resolve(true)),
    } as unknown as UpdateService;
    registerUpdateHandlers(service);

    expect(getHandler(IPC.UPDATE_STATE_GET)()).toEqual(readySnapshot);
    expect(await getHandler(IPC.UPDATE_CHECK)()).toEqual(readySnapshot);
    expect(await getHandler(IPC.UPDATE_INSTALL)()).toEqual({ accepted: true });
    expect(service.checkForUpdates).toHaveBeenCalledWith(true);
    expect(service.installUpdate).toHaveBeenCalledOnce();
  });

  it('requires every update command to have exactly zero arguments', () => {
    expect(validateIpcInvokeArgs(IPC.UPDATE_STATE_GET, [])).toEqual([]);
    expect(validateIpcInvokeArgs(IPC.UPDATE_CHECK, [])).toEqual([]);
    expect(validateIpcInvokeArgs(IPC.UPDATE_INSTALL, [])).toEqual([]);
    expect(() => validateIpcInvokeArgs(IPC.UPDATE_CHECK, [{ feedUrl: 'https://evil.invalid' }]))
      .toThrow('Invalid IPC payload');
  });
});
