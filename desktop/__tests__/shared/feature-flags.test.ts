import { describe, expect, it } from 'vitest';
import type { ElectronSettings } from '../../src/shared/ipc-types';
import {
  getDashboardViewMode,
  getShortcutGroups,
  isKanbanBoardEnabled,
} from '../../src/renderer/lib/feature-flags';

function createSettings(overrides: Partial<ElectronSettings> = {}): ElectronSettings {
  return {
    alwaysOnTop: false,
    compactMode: false,
    copyOnSelect: false,
    cursorBlink: true,
    cursorStyle: 'block',
    debugLogging: false,
    enableKanbanBoard: false,
    opencodeMousePassthrough: false,
    pollingInterval: 200,
    scrollbackLines: 10000,
    showPerformanceMetrics: false,
    terminalBell: false,
    terminalFontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
    terminalFontSize: 13,
    terminalOsc52Clipboard: 'off',
    terminalPreferredLaunchCols: 0,
    terminalPreferredLaunchRows: 0,
    terminalTransport: 'classic',
    theme: 'dark',
    uiZoom: 1,
    windowOpacity: 1,
    ...overrides,
  };
}

describe('feature flags', () => {
  it('keeps the board disabled unless explicitly enabled', () => {
    expect(isKanbanBoardEnabled(null)).toBe(false);
    expect(isKanbanBoardEnabled(createSettings())).toBe(false);
    expect(isKanbanBoardEnabled(createSettings({ enableKanbanBoard: true }))).toBe(true);
  });

  it('falls back to fleet when the board view is requested while disabled', () => {
    expect(getDashboardViewMode('kanban', createSettings())).toBe('fleet');
    expect(getDashboardViewMode('kanban', createSettings({ enableKanbanBoard: true }))).toBe('kanban');
    expect(getDashboardViewMode('focus', createSettings())).toBe('focus');
  });

  it('hides the board shortcut unless the alpha board is enabled', () => {
    const disabledShortcuts = getShortcutGroups(createSettings()).flatMap((group) => group.shortcuts);
    const enabledShortcuts = getShortcutGroups(createSettings({ enableKanbanBoard: true })).flatMap((group) => group.shortcuts);

    expect(disabledShortcuts.some((shortcut) => shortcut.action.includes('Board'))).toBe(false);
    expect(enabledShortcuts.some((shortcut) => shortcut.action === 'Toggle board alpha')).toBe(true);
  });
});
