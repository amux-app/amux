import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSettingsHandlers } from '../../src/main/ipc/settings.handlers';
import { IPC } from '../../src/shared/ipc-channels';

const secureHandleMock = vi.hoisted(() => vi.fn());
const updateSetting = vi.hoisted(() => vi.fn());

vi.mock('../../src/main/ipc/ipc-security.js', () => ({
  secureHandle: (channel: string, handler: unknown) => secureHandleMock(channel, handler),
}));

vi.mock('../../src/main/services/Logger.js', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('muxbase/core', () => ({
  SETTING_DEFINITIONS: [],
  SettingsManager: { getInstance: () => ({ updateSetting, getSettings: vi.fn(() => ({})) }) },
  isSettingKey: (key: string) => key === 'useWorktree',
  validateSettingValue: (key: string, value: unknown) => key === 'useWorktree' && typeof value === 'boolean',
}));

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const registration = secureHandleMock.mock.calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!registration) throw new Error(`missing handler registration for ${channel}`);
  return registration[1] as (...args: unknown[]) => unknown;
}

describe('settings IPC handlers', () => {
  beforeEach(() => {
    secureHandleMock.mockClear();
    updateSetting.mockReset();
  });

  it('rejects unknown keys before reaching the settings manager', () => {
    registerSettingsHandlers({ getProjectRoot: () => '/project', getPanes: () => [] } as never);

    const result = getHandler(IPC.SETTINGS_UPDATE)(undefined, {
      key: 'unknownSetting',
      scope: 'project',
      value: true,
    });

    expect(result).toEqual({ error: 'Invalid setting unknownSetting' });
    expect(updateSetting).not.toHaveBeenCalled();
  });

  it('passes validated values to the manager at the requested scope', () => {
    registerSettingsHandlers({ getProjectRoot: () => '/project', getPanes: () => [] } as never);

    const result = getHandler(IPC.SETTINGS_UPDATE)(undefined, {
      key: 'useWorktree',
      scope: 'project',
      value: true,
    });

    expect(result).toEqual({ success: true });
    expect(updateSetting).toHaveBeenCalledWith('useWorktree', true, 'project');
  });
});
