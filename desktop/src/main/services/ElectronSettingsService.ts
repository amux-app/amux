import Store from 'electron-store';
import type { ElectronSettings } from '../../shared/ipc-types.js';
import { SIDEBAR_DEFAULT_WIDTH } from '../../shared/sidebar-metrics.js';
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE,
  JETBRAINS_TERMINAL_FONT_FAMILY,
  LEGACY_JETBRAINS_TERMINAL_FONT_FAMILY,
  LEGACY_MONACO_TERMINAL_FONT_FAMILY,
  LEGACY_SF_MONO_TERMINAL_FONT_FAMILY,
  SYSTEM_MONO_TERMINAL_FONT_FAMILY,
} from '../../shared/terminal-profile.js';

const LEGACY_TERMINAL_FONT_FAMILIES = new Set([
  JETBRAINS_TERMINAL_FONT_FAMILY,
  LEGACY_JETBRAINS_TERMINAL_FONT_FAMILY,
  LEGACY_MONACO_TERMINAL_FONT_FAMILY,
  LEGACY_SF_MONO_TERMINAL_FONT_FAMILY,
  SYSTEM_MONO_TERMINAL_FONT_FAMILY,
]);

const KANBAN_DEFAULT_RESET_KEY = 'kanbanDefaultResetVersion';
const KANBAN_DEFAULT_RESET_VERSION = 1;
const TERMINAL_FONT_DEFAULT_RESET_KEY = 'terminalFontDefaultResetVersion';
const TERMINAL_FONT_DEFAULT_RESET_VERSION = 3;
const TERMINAL_TRANSPORT_DEFAULT_RESET_KEY = 'terminalTransportDefaultResetVersion';
const TERMINAL_TRANSPORT_DEFAULT_RESET_VERSION = 1;
const TERMINAL_OSC52_DEFAULT_RESET_KEY = 'terminalOsc52DefaultResetVersion';
const TERMINAL_OSC52_DEFAULT_RESET_VERSION = 1;
const SIDEBAR_SORT_DEFAULT_RESET_KEY = 'sidebarSortDefaultResetVersion';
const SIDEBAR_SORT_DEFAULT_RESET_VERSION = 1;

const MIGRATION_VERSION_KEYS = [
  KANBAN_DEFAULT_RESET_KEY,
  TERMINAL_FONT_DEFAULT_RESET_KEY,
  TERMINAL_OSC52_DEFAULT_RESET_KEY,
  TERMINAL_TRANSPORT_DEFAULT_RESET_KEY,
  SIDEBAR_SORT_DEFAULT_RESET_KEY,
] as const;

const DEFAULTS: ElectronSettings = {
  theme: 'dark',
  terminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
  terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
  uiZoom: 1.0,
  compactMode: false,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollbackLines: 25000,
  copyOnSelect: false,
  opencodeMousePassthrough: false,
  terminalBell: false,
  terminalOsc52Clipboard: 'off',
  terminalPreferredLaunchCols: 0,
  terminalPreferredLaunchRows: 0,
  terminalTheme: 'follow',
  terminalTransport: 'pty',
  sidebarCollapsed: false,
  sidebarOrganize: 'project',
  sidebarSort: 'manual',
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  alwaysOnTop: false,
  windowOpacity: 1.0,
  debugLogging: false,
  enableKanbanBoard: false,
  enablePaneSummary: false,
  enableTelemetryCostTracking: true,
  costCurrency: 'EUR-hai',
  enableConversationTopics: false,
  enableAgentLifecycleAdapters: false,
  enableReviewAgent: true,
  enableLanguageIntelligence: true,
  pollingInterval: 200,
  showPerformanceMetrics: false,
  showArenaScores: false,
  showAgentHealthTracker: false,
  disableExternalNetwork: false,
};

type StoredElectronSettings = Omit<Partial<ElectronSettings>, 'terminalOsc52Clipboard'> & {
  terminalOsc52Clipboard?: ElectronSettings['terminalOsc52Clipboard'] | 'ask';
  [KANBAN_DEFAULT_RESET_KEY]?: number;
  [TERMINAL_FONT_DEFAULT_RESET_KEY]?: number;
  [TERMINAL_OSC52_DEFAULT_RESET_KEY]?: number;
  [TERMINAL_TRANSPORT_DEFAULT_RESET_KEY]?: number;
  [SIDEBAR_SORT_DEFAULT_RESET_KEY]?: number;
};

export class ElectronSettingsService {
  private static instance: ElectronSettingsService;
  private store: Store<StoredElectronSettings>;

  private constructor() {
    this.store = new Store<StoredElectronSettings>({
      name: 'electron-settings',
      defaults: DEFAULTS,
      clearInvalidConfig: true,
    });
    this.resetTerminalFontDefaultIfNeeded();
    this.resetTerminalOsc52DefaultIfNeeded();
    this.resetTerminalTransportDefaultIfNeeded();
    this.resetKanbanDefaultIfNeeded();
    this.resetSidebarSortDefaultIfNeeded();
  }

  static getInstance(): ElectronSettingsService {
    if (!ElectronSettingsService.instance) {
      ElectronSettingsService.instance = new ElectronSettingsService();
    }
    return ElectronSettingsService.instance;
  }

  getAll(): ElectronSettings {
    const storedSettings = { ...this.store.store };
    for (const key of MIGRATION_VERSION_KEYS) delete storedSettings[key];
    const terminalOsc52Clipboard = storedSettings.terminalOsc52Clipboard === 'ask'
      ? DEFAULTS.terminalOsc52Clipboard
      : storedSettings.terminalOsc52Clipboard ?? DEFAULTS.terminalOsc52Clipboard;
    return { ...DEFAULTS, ...storedSettings, terminalOsc52Clipboard };
  }

  get<K extends keyof ElectronSettings>(key: K): ElectronSettings[K] {
    return this.getAll()[key];
  }

  update<K extends keyof ElectronSettings>(key: K, value: ElectronSettings[K]): ElectronSettings {
    this.store.set(key, value);
    return this.getAll();
  }

  reset(): ElectronSettings {
    this.store.clear();
    this.resetTerminalFontDefaultIfNeeded();
    this.resetTerminalOsc52DefaultIfNeeded();
    this.resetTerminalTransportDefaultIfNeeded();
    this.resetKanbanDefaultIfNeeded();
    this.resetSidebarSortDefaultIfNeeded();
    return this.getAll();
  }

  static getDefaults(): ElectronSettings {
    return { ...DEFAULTS };
  }

  private resetKanbanDefaultIfNeeded(): void {
    if (this.store.store[KANBAN_DEFAULT_RESET_KEY] === KANBAN_DEFAULT_RESET_VERSION) return;

    this.store.set('enableKanbanBoard', false);
    this.store.set(KANBAN_DEFAULT_RESET_KEY, KANBAN_DEFAULT_RESET_VERSION);
  }

  private resetTerminalFontDefaultIfNeeded(): void {
    if (this.store.store[TERMINAL_FONT_DEFAULT_RESET_KEY] === TERMINAL_FONT_DEFAULT_RESET_VERSION) return;

    const terminalFontFamily = this.store.store.terminalFontFamily;
    if (typeof terminalFontFamily === 'string' && LEGACY_TERMINAL_FONT_FAMILIES.has(terminalFontFamily)) {
      this.store.set('terminalFontFamily', DEFAULT_TERMINAL_FONT_FAMILY);
    }
    this.store.set(TERMINAL_FONT_DEFAULT_RESET_KEY, TERMINAL_FONT_DEFAULT_RESET_VERSION);
  }

  private resetTerminalTransportDefaultIfNeeded(): void {
    if (this.store.store[TERMINAL_TRANSPORT_DEFAULT_RESET_KEY] === TERMINAL_TRANSPORT_DEFAULT_RESET_VERSION) return;

    if (this.store.store.terminalTransport === 'classic') {
      this.store.set('terminalTransport', DEFAULTS.terminalTransport);
    }
    this.store.set(TERMINAL_TRANSPORT_DEFAULT_RESET_KEY, TERMINAL_TRANSPORT_DEFAULT_RESET_VERSION);
  }

  private resetTerminalOsc52DefaultIfNeeded(): void {
    if (this.store.store[TERMINAL_OSC52_DEFAULT_RESET_KEY] === TERMINAL_OSC52_DEFAULT_RESET_VERSION) return;

    if (this.store.store.terminalOsc52Clipboard === 'ask') {
      this.store.set('terminalOsc52Clipboard', DEFAULTS.terminalOsc52Clipboard);
    }
    this.store.set(TERMINAL_OSC52_DEFAULT_RESET_KEY, TERMINAL_OSC52_DEFAULT_RESET_VERSION);
  }

  private resetSidebarSortDefaultIfNeeded(): void {
    if (this.store.store[SIDEBAR_SORT_DEFAULT_RESET_KEY] === SIDEBAR_SORT_DEFAULT_RESET_VERSION) return;
    if (this.store.store.sidebarSort === 'priority') {
      this.store.set('sidebarSort', DEFAULTS.sidebarSort);
    }
    this.store.set(SIDEBAR_SORT_DEFAULT_RESET_KEY, SIDEBAR_SORT_DEFAULT_RESET_VERSION);
  }
}
