import type { MuxBaseBootSettings } from '../../shared/ipc-types';
import { clampSidebarWidth, SIDEBAR_WIDTH } from './constants';

// Read once at module load: the preload bridge resolves it before any renderer
// script runs, and it is absent in unit tests / non-Electron hosts.
const bootSettings: MuxBaseBootSettings | undefined = typeof window === 'undefined'
  ? undefined
  : window.muxbase?.bootSettings;

export const BOOT_THEME: MuxBaseBootSettings['theme'] = bootSettings?.theme ?? 'dark';
export const BOOT_TERMINAL_THEME: MuxBaseBootSettings['terminalTheme'] | undefined = bootSettings?.terminalTheme;
export const BOOT_TERMINAL_SELECTION_INTEGRATION_ENABLED = bootSettings?.terminalSelectionIntegrationEnabled ?? true;
export const BOOT_SIDEBAR_COLLAPSED: MuxBaseBootSettings['sidebarCollapsed'] = bootSettings?.sidebarCollapsed ?? false;
export const BOOT_SIDEBAR_ORGANIZE: MuxBaseBootSettings['sidebarOrganize'] = bootSettings?.sidebarOrganize ?? 'project';
export const BOOT_SIDEBAR_SORT: MuxBaseBootSettings['sidebarSort'] = bootSettings?.sidebarSort ?? 'manual';
export const BOOT_SIDEBAR_WIDTH: MuxBaseBootSettings['sidebarWidth'] = clampSidebarWidth(
  bootSettings?.sidebarWidth ?? SIDEBAR_WIDTH,
);
