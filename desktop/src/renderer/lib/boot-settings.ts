import type { AumxBootSettings } from '../../shared/ipc-types';
import { clampSidebarWidth, SIDEBAR_WIDTH } from './constants';

// Read once at module load: the preload bridge resolves it before any renderer
// script runs, and it is absent in unit tests / non-Electron hosts.
const bootSettings: AumxBootSettings | undefined = typeof window === 'undefined'
  ? undefined
  : window.aumx?.bootSettings;

export const BOOT_THEME: AumxBootSettings['theme'] = bootSettings?.theme ?? 'dark';
export const BOOT_TERMINAL_THEME: AumxBootSettings['terminalTheme'] | undefined = bootSettings?.terminalTheme;
export const BOOT_TERMINAL_SELECTION_INTEGRATION_ENABLED = bootSettings?.terminalSelectionIntegrationEnabled ?? true;
export const BOOT_SIDEBAR_COLLAPSED: AumxBootSettings['sidebarCollapsed'] = bootSettings?.sidebarCollapsed ?? false;
export const BOOT_SIDEBAR_ORGANIZE: AumxBootSettings['sidebarOrganize'] = bootSettings?.sidebarOrganize ?? 'project';
export const BOOT_SIDEBAR_SORT: AumxBootSettings['sidebarSort'] = bootSettings?.sidebarSort ?? 'manual';
export const BOOT_SIDEBAR_WIDTH: AumxBootSettings['sidebarWidth'] = clampSidebarWidth(
  bootSettings?.sidebarWidth ?? SIDEBAR_WIDTH,
);
