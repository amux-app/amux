import {
  mkdirSync,
  mkdtempSync,
  readFileSync as readActualFileSync,
  rmSync,
  writeFileSync as writeActualFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function mockAtomicJsonWrite(writeFileSync: ReturnType<typeof vi.fn>): void {
  vi.doMock('../src/utils/atomicWrite.js', () => ({
    atomicWriteJsonSync: (filePath: string, data: unknown) => {
      writeFileSync(filePath, JSON.stringify(data, null, 2));
    },
  }));
}

describe('SettingsManager defaults', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('../src/utils/atomicWrite.js');
  });

  it('uses safe auto defaults when no settings files exist', async () => {
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });
    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(manager.getSettings()).toMatchObject({
      permissionMode: 'auto',
      initGitIfMissing: true,
    });
  });

  it('defaults Claude to fullscreen without persisting the default', async () => {
    const writeFileSync = vi.fn();
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync,
        mkdirSync: vi.fn(),
      };
    });
    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(manager.getSettings().claudeFullscreenRendering).toBe(true);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('preserves an explicit project classic compatibility setting', async () => {
    const writeFileSync = vi.fn();
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn((filePath: string) => filePath.endsWith('/.muxbase/settings.json')),
        readFileSync: vi.fn(() => JSON.stringify({
          claudeFullscreenDefaultResetVersion: 1,
          claudeFullscreenRendering: false,
        })),
        writeFileSync,
        mkdirSync: vi.fn(),
      };
    });
    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(manager.getSettings().claudeFullscreenRendering).toBe(false);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('preserves an explicit global classic compatibility setting', async () => {
    const writeFileSync = vi.fn();
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn((filePath: string) => filePath.endsWith('/.muxbase/settings.json')),
        readFileSync: vi.fn(() => JSON.stringify({
          claudeFullscreenDefaultResetVersion: 1,
          claudeFullscreenRendering: false,
        })),
        writeFileSync,
        mkdirSync: vi.fn(),
      };
    });
    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(manager.getSettings().claudeFullscreenRendering).toBe(false);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('migrates an unmarked global classic value once without exposing migration metadata', async () => {
    const globalPath = '/tmp/.muxbase/settings.json';
    let stored = JSON.stringify({ claudeFullscreenRendering: false, useWorktree: true });
    const writeFileSync = vi.fn((filePath: string, data: string) => {
      if (filePath === globalPath) stored = data;
    });
    vi.doMock('os', async (importOriginal) => {
      const actual = await importOriginal<typeof import('os')>();
      return { ...actual, homedir: () => '/tmp' };
    });
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn((filePath: string) => filePath === globalPath),
        readFileSync: vi.fn(() => stored),
        writeFileSync,
        mkdirSync: vi.fn(),
      };
    });
    mockAtomicJsonWrite(writeFileSync);

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');
    const reloaded = new SettingsManager('/tmp/test-project');

    expect(manager.getSettings().claudeFullscreenRendering).toBe(true);
    expect(reloaded.getSettings().claudeFullscreenRendering).toBe(true);
    expect(manager.getGlobalSettings()).toEqual({ useWorktree: true });
    expect(JSON.parse(stored)).toEqual({
      claudeFullscreenDefaultResetVersion: 1,
      useWorktree: true,
    });
    expect(writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('migrates unmarked global and project classic values independently', async () => {
    const globalPath = '/tmp/.muxbase/settings.json';
    const projectPath = '/tmp/test-project/.muxbase/settings.json';
    const stored = new Map<string, string>([
      [globalPath, JSON.stringify({ claudeFullscreenRendering: false, claudeModel: 'sonnet' })],
      [projectPath, JSON.stringify({ claudeFullscreenRendering: false, useWorktree: true })],
    ]);
    const writeFileSync = vi.fn((filePath: string, data: string) => stored.set(filePath, data));
    vi.doMock('os', async (importOriginal) => {
      const actual = await importOriginal<typeof import('os')>();
      return { ...actual, homedir: () => '/tmp' };
    });
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn((filePath: string) => stored.has(filePath)),
        readFileSync: vi.fn((filePath: string) => stored.get(filePath)!),
        writeFileSync,
        mkdirSync: vi.fn(),
      };
    });
    mockAtomicJsonWrite(writeFileSync);

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(manager.getSettings()).toMatchObject({
      claudeFullscreenRendering: true,
      claudeModel: 'sonnet',
      useWorktree: true,
    });
    expect(JSON.parse(stored.get(globalPath)!)).toEqual({
      claudeFullscreenDefaultResetVersion: 1,
      claudeModel: 'sonnet',
    });
    expect(JSON.parse(stored.get(projectPath)!)).toEqual({
      claudeFullscreenDefaultResetVersion: 1,
      useWorktree: true,
    });
    expect(writeFileSync).toHaveBeenCalledTimes(2);
  });

  it('keeps a marked project classic value overriding global fullscreen without rewriting it', async () => {
    const writeFileSync = vi.fn();
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => true),
        readFileSync: vi.fn((filePath: string) => JSON.stringify(
          filePath.endsWith('/.muxbase/settings.json') && !filePath.includes('/test-project/')
          ? { claudeFullscreenRendering: true }
          : {
              claudeFullscreenDefaultResetVersion: 1,
              claudeFullscreenRendering: false,
            })),
        writeFileSync,
        mkdirSync: vi.fn(),
      };
    });
    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(manager.getSettings().claudeFullscreenRendering).toBe(false);
    expect(manager.getProjectSettings()).toEqual({ claudeFullscreenRendering: false });
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('stamps explicit classic updates and reloads them as explicit choices', async () => {
    const globalPath = '/tmp/.muxbase/settings.json';
    let stored: string | undefined;
    const writeFileSync = vi.fn((_filePath: string, data: string) => { stored = data; });
    vi.doMock('os', async (importOriginal) => {
      const actual = await importOriginal<typeof import('os')>();
      return { ...actual, homedir: () => '/tmp' };
    });
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn((filePath: string) => filePath === globalPath && stored !== undefined),
        readFileSync: vi.fn(() => stored!),
        writeFileSync,
        mkdirSync: vi.fn(),
      };
    });
    mockAtomicJsonWrite(writeFileSync);

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    new SettingsManager('/tmp/test-project').updateSetting('claudeFullscreenRendering', false, 'global');
    const reloaded = new SettingsManager('/tmp/test-project');

    expect(JSON.parse(stored!)).toEqual({
      claudeFullscreenDefaultResetVersion: 1,
      claudeFullscreenRendering: false,
    });
    expect(reloaded.getSettings().claudeFullscreenRendering).toBe(false);
    expect(writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('stamps bulk classic updates and retains provenance when removing the setting', async () => {
    const projectPath = '/tmp/test-project/.muxbase/settings.json';
    let stored: string | undefined;
    const writeFileSync = vi.fn((_filePath: string, data: string) => { stored = data; });
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn((filePath: string) => filePath === projectPath && stored !== undefined),
        readFileSync: vi.fn(() => stored!),
        writeFileSync,
        mkdirSync: vi.fn(),
      };
    });
    mockAtomicJsonWrite(writeFileSync);

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');
    manager.updateSettings({ claudeFullscreenRendering: false, useWorktree: true }, 'project');
    manager.removeSetting('claudeFullscreenRendering', 'project');
    const reloaded = new SettingsManager('/tmp/test-project');

    expect(JSON.parse(stored!)).toEqual({
      claudeFullscreenDefaultResetVersion: 1,
      useWorktree: true,
    });
    expect(reloaded.getSettings().claudeFullscreenRendering).toBe(true);
    expect(reloaded.getProjectSettings()).toEqual({ useWorktree: true });
    expect(writeFileSync).toHaveBeenCalledTimes(2);
  });

  it('preserves the original settings after a failed migration write, then retries exactly once', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'muxbase-settings-migration-'));
    const globalPath = join(homeDir, '.muxbase/settings.json');
    const originalSettings = {
      claudeFullscreenRendering: false,
      claudeModel: 'sonnet',
      useWorktree: true,
    };
    mkdirSync(join(homeDir, '.muxbase'), { recursive: true });
    writeActualFileSync(globalPath, JSON.stringify(originalSettings, null, 2), 'utf8');

    let failNextTemporaryWrite = true;
    const writeFileSync = vi.fn((filePath: string, ...args: unknown[]) => {
      const isMigrationTemporaryFile = filePath.startsWith(join(homeDir, '.muxbase', '.settings.json.'))
        && filePath.endsWith('.tmp');
      if (failNextTemporaryWrite && isMigrationTemporaryFile) {
        failNextTemporaryWrite = false;
        throw new Error('disk unavailable');
      }
      return Reflect.apply(writeActualFileSync, undefined, [filePath, ...args]);
    });

    vi.doMock('os', async (importOriginal) => {
      const actual = await importOriginal<typeof import('os')>();
      return { ...actual, homedir: () => homeDir };
    });
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return { ...actual, writeFileSync };
    });
    const error = vi.fn();
    vi.doMock('../src/services/LogService.js', () => ({
      LogService: { getInstance: () => ({ error }) },
    }));

    try {
      const { SettingsManager } = await import('../src/utils/settingsManager.js');
      const first = new SettingsManager(join(homeDir, 'project'));

      expect(first.getSettings().claudeFullscreenRendering).toBe(true);
      expect(JSON.parse(readActualFileSync(globalPath, 'utf8'))).toEqual(originalSettings);

      const second = new SettingsManager(join(homeDir, 'project'));
      expect(second.getSettings().claudeFullscreenRendering).toBe(true);
      expect(JSON.parse(readActualFileSync(globalPath, 'utf8'))).toEqual({
        claudeFullscreenDefaultResetVersion: 1,
        claudeModel: 'sonnet',
        useWorktree: true,
      });

      const third = new SettingsManager(join(homeDir, 'project'));
      expect(third.getSettings().claudeFullscreenRendering).toBe(true);
      expect(writeFileSync).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledWith(
        'Failed to save global settings',
        'settingsManager',
        undefined,
        expect.any(Error),
      );
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it('defaults malformed persisted Claude renderer values to fullscreen', async () => {
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn((filePath: string) => filePath.endsWith('/.muxbase/settings.json')),
        readFileSync: vi.fn(() => JSON.stringify({ claudeFullscreenRendering: 'false' })),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(manager.getSettings().claudeFullscreenRendering).toBe(true);
  });

  it('falls back to defaults when persisted settings are valid JSON but not an object', async () => {
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn((filePath: string) => filePath.endsWith('/.muxbase/settings.json')),
        readFileSync: vi.fn(() => 'null'),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(manager.getSettings().claudeFullscreenRendering).toBe(true);
    expect(manager.getGlobalSettings()).toEqual({});
  });

  it('retains the last known good settings when a later read is malformed', async () => {
    let malformed = false;
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn((filePath: string) => filePath.endsWith('/.muxbase/settings.json')),
        readFileSync: vi.fn(() => malformed
          ? JSON.stringify({ useWorktree: 'yes' })
          : JSON.stringify({ useWorktree: true })),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    expect(new SettingsManager('/tmp/test-project').getSettings().useWorktree).toBe(true);

    malformed = true;
    expect(new SettingsManager('/tmp/test-project').getSettings().useWorktree).toBe(true);
  });

  it('promotes a successful settings save to the last known good value', async () => {
    const projectPath = '/tmp/test-project/.muxbase/settings.json';
    let stored = JSON.stringify({ useWorktree: false });
    const writeFileSync = vi.fn((_filePath: string, data: string) => { stored = data; });
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn((filePath: string) => filePath === projectPath),
        readFileSync: vi.fn(() => stored),
        writeFileSync,
        mkdirSync: vi.fn(),
      };
    });
    mockAtomicJsonWrite(writeFileSync);

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');
    manager.updateSettings({ useWorktree: true }, 'project');

    stored = JSON.stringify({ useWorktree: 'corrupt' });
    expect(new SettingsManager('/tmp/test-project').getSettings().useWorktree).toBe(true);
  });

  it('rejects non-boolean Claude renderer updates', async () => {
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(() => manager.updateSetting('claudeFullscreenRendering', 'false' as never, 'project'))
      .toThrow('Invalid claudeFullscreenRendering');
    expect(() => manager.updateSettings({ claudeFullscreenRendering: 'false' as never }, 'global'))
      .toThrow('Invalid claudeFullscreenRendering');
  });

  it('defaults OpenCode scrollback-friendly mode to false', async () => {
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(manager.getSettings().opencodeScrollbackMode).toBe(false);
  });

  it('rejects non-boolean OpenCode scrollback-friendly mode updates', async () => {
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(() => manager.updateSetting('opencodeScrollbackMode', 'true' as never, 'project'))
      .toThrow('Invalid opencodeScrollbackMode');
  });

  it('fails closed to standard OpenCode mode for malformed persisted values', async () => {
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn((filePath: string) => filePath.endsWith('/.muxbase/settings.json')),
        readFileSync: vi.fn(() => JSON.stringify({ opencodeScrollbackMode: 'true' })),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(manager.getSettings().opencodeScrollbackMode).toBe(false);
  });

  it('defines OpenCode scrollback-friendly mode as an OpenCode boolean setting', async () => {
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SETTING_DEFINITIONS } = await import('../src/utils/settingsManager.js');
    const definition = SETTING_DEFINITIONS.find(({ key }) => key === 'opencodeScrollbackMode');

    expect(definition).toMatchObject({
      key: 'opencodeScrollbackMode',
      label: 'Scrollback-Friendly Mode',
      section: 'OpenCode',
      type: 'boolean',
    });
    expect(definition?.description).toContain('--mini');
  });

  it('allows overriding permissionMode with a valid value', async () => {
    const writeFileSync = vi.fn();
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync,
        mkdirSync: vi.fn(),
      };
    });
    mockAtomicJsonWrite(writeFileSync);

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    manager.updateSetting('permissionMode', 'auto', 'project');
    expect(manager.getSettings().permissionMode).toBe('auto');
  });

  it('normalizes legacy persisted permission modes to auto', async () => {
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn((filePath: string) => (
          filePath.endsWith('/.muxbase/settings.json') && !filePath.includes('/test-project/')
        )),
        readFileSync: vi.fn(() => JSON.stringify({ permissionMode: 'bypassPermissions' })),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(manager.getSettings().permissionMode).toBe('auto');
  });

  it('does not normalize legacy plan mode to edit-capable auto', async () => {
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn((filePath: string) => (
          filePath.endsWith('/.muxbase/settings.json') && !filePath.includes('/test-project/')
        )),
        readFileSync: vi.fn(() => JSON.stringify({ permissionMode: 'plan' })),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(manager.getSettings().permissionMode).toBe('');
  });

  it('does not normalize invalid persisted permission modes to auto', async () => {
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn((filePath: string) => (
          filePath.endsWith('/.muxbase/settings.json') && !filePath.includes('/test-project/')
        )),
        readFileSync: vi.fn(() => JSON.stringify({ permissionMode: 'fullAuto' })),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(manager.getSettings().permissionMode).toBe('');
  });

  it('rejects invalid permissionMode values', async () => {
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(() => manager.updateSetting('permissionMode', 'fullAuto' as never, 'global')).toThrow(
      'Invalid permissionMode'
    );
  });
});
