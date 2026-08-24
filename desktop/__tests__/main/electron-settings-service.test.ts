import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElectronSettings } from '../../src/shared/ipc-types';
import { ElectronSettingsService } from '../../src/main/services/ElectronSettingsService';
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE,
  JETBRAINS_TERMINAL_FONT_FAMILY,
  LEGACY_JETBRAINS_TERMINAL_FONT_FAMILY,
  LEGACY_MONACO_TERMINAL_FONT_FAMILY,
  LEGACY_SF_MONO_TERMINAL_FONT_FAMILY,
  SYSTEM_MONO_TERMINAL_FONT_FAMILY,
} from '../../src/shared/terminal-profile';

const storeData = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock('electron-store', () => ({
  default: class MockStore {
    get store(): Record<string, unknown> {
      return storeData.current;
    }

    get(key: string): unknown {
      return storeData.current[key];
    }

    set(key: string, value: unknown): void {
      storeData.current[key] = value;
    }

    clear(): void {
      storeData.current = {};
    }
  },
}));

function resetService(): void {
  (ElectronSettingsService as unknown as { instance: ElectronSettingsService | undefined }).instance = undefined;
}

describe('ElectronSettingsService', () => {
  beforeEach(() => {
    storeData.current = {
      terminalFontFamily: LEGACY_JETBRAINS_TERMINAL_FONT_FAMILY,
    };
    resetService();
  });

  it('uses the readable terminal font stack by default', () => {
    // Act
    const defaults = ElectronSettingsService.getDefaults();

    // Assert
    expect(defaults.terminalFontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(defaults.terminalFontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  it('uses the native pty terminal transport by default', () => {
    // Act
    const defaults = ElectronSettingsService.getDefaults();

    // Assert
    expect(defaults.terminalTransport).toBe('pty');
  });

  it('keeps lifecycle adapter installation disabled until the user explicitly opts in', () => {
    expect(ElectronSettingsService.getDefaults().enableAgentLifecycleAdapters).toBe(false);
  });

  it('starts without a persisted preferred terminal launch geometry', () => {
    // Act
    const defaults = ElectronSettingsService.getDefaults();

    // Assert
    expect(defaults.terminalPreferredLaunchCols).toBe(0);
    expect(defaults.terminalPreferredLaunchRows).toBe(0);
  });

  it('keeps terminal-generated clipboard writes off by default', () => {
    // Act
    const defaults = ElectronSettingsService.getDefaults();

    // Assert
    expect(defaults.terminalOsc52Clipboard).toBe('off');
    expect(defaults.opencodeMousePassthrough).toBe(false);
  });

  it('migrates the removed ask mode to off while keeping explicit allow available', () => {
    // Arrange
    storeData.current = {
      terminalOsc52Clipboard: 'ask',
    };
    resetService();

    // Act
    const service = ElectronSettingsService.getInstance();
    const migratedSettings = service.getAll();
    const manualSettings = service.update('terminalOsc52Clipboard', 'allow');
    resetService();
    const restoredSettings = ElectronSettingsService.getInstance().getAll();

    // Assert
    expect(migratedSettings.terminalOsc52Clipboard).toBe('off');
    expect(manualSettings.terminalOsc52Clipboard).toBe('allow');
    expect(restoredSettings.terminalOsc52Clipboard).toBe('allow');
  });

  it('upgrades the previous default terminal transport once while keeping manual override available', () => {
    // Arrange
    storeData.current = {
      terminalTransport: 'classic',
    };
    resetService();

    // Act
    const service = ElectronSettingsService.getInstance();
    const migratedSettings = service.getAll();
    const manualSettings = service.update('terminalTransport', 'classic');
    resetService();
    const restoredSettings = ElectronSettingsService.getInstance().getAll();

    // Assert
    expect(migratedSettings.terminalTransport).toBe('pty');
    expect(manualSettings.terminalTransport).toBe('classic');
    expect(restoredSettings.terminalTransport).toBe('classic');
  });

  it('keeps an explicit control-mode transport during the default transport migration', () => {
    // Arrange
    storeData.current = {
      terminalTransport: 'control',
    };
    resetService();

    // Act
    const settings = ElectronSettingsService.getInstance().getAll();

    // Assert
    expect(settings.terminalTransport).toBe('control');
  });

  it('normalizes the previous default terminal font without changing other settings', () => {
    // Act
    const settings: ElectronSettings = ElectronSettingsService.getInstance().getAll();

    // Assert
    expect(settings.terminalFontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(settings.terminalFontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  it('normalizes the previous recommended terminal font without changing other settings', () => {
    // Arrange
    storeData.current = {
      terminalFontDefaultResetVersion: 1,
      terminalFontFamily: JETBRAINS_TERMINAL_FONT_FAMILY,
    };
    resetService();

    // Act
    const settings: ElectronSettings = ElectronSettingsService.getInstance().getAll();

    // Assert
    expect(settings.terminalFontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(settings.terminalFontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  it('normalizes the previous system mono terminal default without changing other settings', () => {
    // Arrange
    storeData.current = {
      terminalFontDefaultResetVersion: 2,
      terminalFontFamily: SYSTEM_MONO_TERMINAL_FONT_FAMILY,
    };
    resetService();

    // Act
    const settings: ElectronSettings = ElectronSettingsService.getInstance().getAll();

    // Assert
    expect(settings.terminalFontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(settings.terminalFontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  it('normalizes the previous macOS terminal default without changing other settings', () => {
    // Arrange
    storeData.current = {
      terminalFontFamily: LEGACY_SF_MONO_TERMINAL_FONT_FAMILY,
    };
    resetService();

    // Act
    const settings: ElectronSettings = ElectronSettingsService.getInstance().getAll();

    // Assert
    expect(settings.terminalFontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(settings.terminalFontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  it('normalizes the previous Monaco terminal default without changing other settings', () => {
    // Arrange
    storeData.current = {
      terminalFontFamily: LEGACY_MONACO_TERMINAL_FONT_FAMILY,
    };
    resetService();

    // Act
    const settings: ElectronSettings = ElectronSettingsService.getInstance().getAll();

    // Assert
    expect(settings.terminalFontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(settings.terminalFontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  it('keeps a legacy terminal font after the one-time default migration has run', () => {
    // Arrange
    storeData.current = {
      terminalFontDefaultResetVersion: 3,
      terminalFontFamily: LEGACY_MONACO_TERMINAL_FONT_FAMILY,
    };
    resetService();

    // Act
    const settings: ElectronSettings = ElectronSettingsService.getInstance().getAll();

    // Assert
    expect(settings.terminalFontFamily).toBe(LEGACY_MONACO_TERMINAL_FONT_FAMILY);
    expect(settings.terminalFontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  it('resets previously persisted board opt-in once while keeping manual opt-in available', () => {
    // Arrange
    storeData.current = {
      enableKanbanBoard: true,
    };
    resetService();

    // Act
    const service = ElectronSettingsService.getInstance();
    const migratedSettings = service.getAll();
    const enabledSettings = service.update('enableKanbanBoard', true);
    resetService();
    const restoredSettings = ElectronSettingsService.getInstance().getAll();

    // Assert
    expect(migratedSettings.enableKanbanBoard).toBe(false);
    expect(enabledSettings.enableKanbanBoard).toBe(true);
    expect(restoredSettings.enableKanbanBoard).toBe(true);
  });

  describe('resetSidebarSortDefaultIfNeeded', () => {
    it('fresh install gets manual sort', () => {
      // Arrange
      storeData.current = {};
      resetService();

      // Act
      const settings = ElectronSettingsService.getInstance().getAll();

      // Assert
      expect(settings.sidebarSort).toBe('manual');
    });

    it('existing priority store is migrated to manual', () => {
      // Arrange
      storeData.current = { sidebarSort: 'priority' };
      resetService();

      // Act
      const settings = ElectronSettingsService.getInstance().getAll();

      // Assert
      expect(settings.sidebarSort).toBe('manual');
    });

    it('existing updated store is not migrated', () => {
      // Arrange
      storeData.current = { sidebarSort: 'updated' };
      resetService();

      // Act
      const settings = ElectronSettingsService.getInstance().getAll();

      // Assert
      expect(settings.sidebarSort).toBe('updated');
    });

    it('post-migration priority reselection is preserved', () => {
      // Arrange — reset key already set to version 1, user re-selected priority
      storeData.current = { sidebarSort: 'priority', sidebarSortDefaultResetVersion: 1 };
      resetService();

      // Act
      const settings = ElectronSettingsService.getInstance().getAll();

      // Assert
      expect(settings.sidebarSort).toBe('priority');
    });
  });
});
