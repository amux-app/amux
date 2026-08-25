import { describe, expect, it } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';
import type { ElectronSettings } from '../../src/shared/ipc-types';
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '../../src/shared/sidebar-metrics';
import { electronSettingKeys, validateIpcInvokeArgs } from '../../src/main/ipc/ipc-request-validation';

const SAMPLE_VALUES: Record<keyof ElectronSettings, unknown> = {
  alwaysOnTop: false,
  compactMode: false,
  copyOnSelect: false,
  costCurrency: 'EUR-hai',
  cursorBlink: true,
  cursorStyle: 'block',
  debugLogging: false,
  disableExternalNetwork: false,
  enableConversationTopics: false,
  enableAgentLifecycleAdapters: false,
  enableKanbanBoard: false,
  enableLanguageIntelligence: true,
  enablePaneSummary: false,
  enableReviewAgent: true,
  enableTelemetryCostTracking: true,
  opencodeMousePassthrough: false,
  pollingInterval: 200,
  scrollbackLines: 10000,
  showAgentHealthTracker: true,
  showArenaScores: true,
  showPerformanceMetrics: false,
  sidebarCollapsed: false,
  sidebarOrganize: 'project',
  sidebarSort: 'priority',
  sidebarWidth: 260,
  terminalBell: false,
  terminalFontFamily: 'JetBrains Mono',
  terminalFontSize: 14,
  terminalOsc52Clipboard: 'off',
  terminalPreferredLaunchCols: 132,
  terminalPreferredLaunchRows: 42,
  terminalTheme: 'follow',
  terminalTransport: 'pty',
  theme: 'dark',
  uiZoom: 1.0,
  windowOpacity: 1.0,
};

describe('electron settings IPC validation', () => {
  it('schema keys are exactly the keys declared on ElectronSettings', () => {
    // Arrange
    const schemaKeys = new Set(electronSettingKeys);
    const declaredKeys = new Set(Object.keys(SAMPLE_VALUES));

    // Act
    const missingFromSchema = [...declaredKeys].filter((k) => !schemaKeys.has(k as keyof ElectronSettings));
    const missingFromDeclared = [...schemaKeys].filter((k) => !declaredKeys.has(k));

    // Assert
    expect(missingFromSchema, 'ElectronSettings has keys the IPC schema does not — runtime will reject valid updates').toEqual([]);
    expect(missingFromDeclared, 'IPC schema has keys not on ElectronSettings — drift between zod schema and the typed interface').toEqual([]);
  });

  it('accepts every key declared on ElectronSettings with its sample value', () => {
    // Arrange & Act & Assert
    for (const key of Object.keys(SAMPLE_VALUES) as Array<keyof ElectronSettings>) {
      expect(() => {
        validateIpcInvokeArgs(IPC.ELECTRON_SETTINGS_UPDATE, [{ key, value: SAMPLE_VALUES[key] }]);
      }, `validation rejected the "${key}" setting — schema is out of sync with ElectronSettings`)
        .not.toThrow();
    }
  });

  it('rejects an unknown setting key', () => {
    // Arrange & Act & Assert
    expect(() => {
      validateIpcInvokeArgs(IPC.ELECTRON_SETTINGS_UPDATE, [{ key: 'notARealKey', value: true }]);
    }).toThrow();
  });

  it('rejects a non-boolean value for a boolean setting', () => {
    // Arrange & Act & Assert
    expect(() => {
      validateIpcInvokeArgs(IPC.ELECTRON_SETTINGS_UPDATE, [{ key: 'showArenaScores', value: 'yes' }]);
    }).toThrow();
  });

  it.each([
    ['the narrowest sidebar column', SIDEBAR_MIN_WIDTH],
    ['the widest sidebar column', SIDEBAR_MAX_WIDTH],
  ])('accepts %s', (_name, value) => {
    // Arrange & Act & Assert
    expect(() => {
      validateIpcInvokeArgs(IPC.ELECTRON_SETTINGS_UPDATE, [{ key: 'sidebarWidth', value }]);
    }).not.toThrow();
  });

  it.each([
    ['below the narrowest sidebar column', SIDEBAR_MIN_WIDTH - 1],
    ['above the widest sidebar column', SIDEBAR_MAX_WIDTH + 1],
  ])('rejects a persisted width %s', (_name, value) => {
    // Arrange & Act & Assert
    expect(() => {
      validateIpcInvokeArgs(IPC.ELECTRON_SETTINGS_UPDATE, [{ key: 'sidebarWidth', value }]);
    }).toThrow();
  });

  it('keeps persisted preferred terminal geometry within launch bounds', () => {
    expect(() => {
      validateIpcInvokeArgs(IPC.ELECTRON_SETTINGS_UPDATE, [{
        key: 'terminalPreferredLaunchRows',
        value: 501,
      }]);
    }).toThrow();
  });
});

describe('terminal IPC validation', () => {
  it('accepts positive integer terminal dimensions', () => {
    expect(() => {
      validateIpcInvokeArgs(IPC.TERMINAL_RESIZE, [{ paneId: 'p1', cols: 120, rows: 36 }]);
    }).not.toThrow();

    expect(() => {
      validateIpcInvokeArgs(IPC.TERMINAL_ATTACH, [{
        paneId: 'p1',
        cols: 120,
        fixedCols: 100,
        rows: 36,
        sessionName: 'muxbase-test',
      }]);
    }).not.toThrow();
  });

  it('rejects a terminal attach carrying a renderer supplied tmux pane id', () => {
    expect(() => {
      validateIpcInvokeArgs(IPC.TERMINAL_ATTACH, [{
        paneId: 'p1',
        sessionName: 'muxbase-test',
        tmuxPaneId: '%1',
      }]);
    }).toThrow();
  });

  it.each([
    ['one column', { paneId: 'p1', cols: 1, rows: 24 }],
    ['one row', { paneId: 'p1', cols: 80, rows: 1 }],
    ['zero cols', { paneId: 'p1', cols: 0, rows: 24 }],
    ['negative rows', { paneId: 'p1', cols: 80, rows: -1 }],
    ['fractional cols', { paneId: 'p1', cols: 80.5, rows: 24 }],
  ])('rejects %s for terminal resize', (_name, payload) => {
    expect(() => {
      validateIpcInvokeArgs(IPC.TERMINAL_RESIZE, [payload]);
    }).toThrow();
  });

  it('rejects a one-column fixed terminal attach', () => {
    expect(() => {
      validateIpcInvokeArgs(IPC.TERMINAL_ATTACH, [{
        paneId: 'p1',
        cols: 80,
        fixedCols: 1,
        rows: 24,
        sessionName: 'muxbase-test',
      }]);
    }).toThrow();
  });

  it('rejects invalid attach dimensions', () => {
    expect(() => {
      validateIpcInvokeArgs(IPC.TERMINAL_ATTACH, [{
        paneId: 'p1',
        cols: 80,
        rows: 0,
        sessionName: 'muxbase-test',
      }]);
    }).toThrow();
  });

  it.each([
    [IPC.PANE_JUMP, { tmuxPaneId: '%1' }],
    [IPC.PANE_GET_CONTENT, { tmuxPaneId: '%1' }],
    [IPC.PANE_SEND_KEYS, { command: 'status', tmuxPaneId: '%1' }],
  ])('rejects a renderer supplied tmux pane id for %s', (channel, payload) => {
    expect(() => validateIpcInvokeArgs(channel, [payload])).toThrow();
  });

  it.each([
    ['resize cols above the supported maximum', IPC.TERMINAL_RESIZE, { paneId: 'p1', cols: 1001, rows: 24 }],
    ['resize rows above the supported maximum', IPC.TERMINAL_RESIZE, { paneId: 'p1', cols: 80, rows: 501 }],
    ['attach cols above the supported maximum', IPC.TERMINAL_ATTACH, {
      paneId: 'p1', cols: 1001, rows: 24, sessionName: 'muxbase-test',
    }],
    ['attach fixed cols above the supported maximum', IPC.TERMINAL_ATTACH, {
      paneId: 'p1', cols: 80, fixedCols: 1001, rows: 24, sessionName: 'muxbase-test',
    }],
    ['attach rows above the supported maximum', IPC.TERMINAL_ATTACH, {
      paneId: 'p1', cols: 80, rows: 501, sessionName: 'muxbase-test',
    }],
  ])('rejects %s', (_name, channel, payload) => {
    expect(() => {
      validateIpcInvokeArgs(channel, [payload]);
    }).toThrow();
  });
});
