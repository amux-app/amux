import { create } from 'zustand';
import type { SidebarOrganize, SidebarSort } from '../../shared/ipc-types';
import { BOOT_SIDEBAR_COLLAPSED, BOOT_SIDEBAR_ORGANIZE, BOOT_SIDEBAR_SORT, BOOT_SIDEBAR_WIDTH, BOOT_THEME } from '../lib/boot-settings';
import { clampSidebarWidth } from '../lib/constants';

export type Theme = 'dark' | 'light' | 'colorful' | 'dark-colorful' | 'system';
export type ActiveView = 'dashboard' | 'settings' | 'topics';
export type ViewMode = 'fleet' | 'focus' | 'kanban' | 'summary' | 'conflict-resolution' | 'duel';
export type SettingsCategory = 'appearance' | 'terminal' | 'agent' | 'worktree' | 'marketplace' | 'window' | 'shortcuts' | 'advanced' | 'about';

interface UiState {
  theme: Theme;
  sidebarCollapsed: boolean;
  sidebarOrganize: SidebarOrganize;
  sidebarSort: SidebarSort;
  sidebarWidth: number;
  activeView: ActiveView;
  settingsCategory: SettingsCategory;
  progressAction: string | null;
  viewMode: ViewMode;
  previousViewMode: ViewMode | null;
  focusPaneId: string | null;
  duelGroupId: string | null;
  scrollToMessageId: string | null;
  helpOverlayOpen: boolean;
  windowFullScreen: boolean;
  zenMode: boolean;
}

interface UiActions {
  setTheme: (theme: Theme) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarOrganize: (organize: SidebarOrganize) => void;
  setSidebarSort: (sort: SidebarSort) => void;
  setSidebarWidth: (width: number) => void;
  setActiveView: (view: ActiveView) => void;
  openSettings: (category?: SettingsCategory) => void;
  setSettingsCategory: (category: SettingsCategory) => void;
  setProgressAction: (action: string | null) => void;
  setViewMode: (mode: ViewMode) => void;
  focusPane: (paneId: string, messageId?: string) => void;
  openDuel: (groupId: string) => void;
  returnToFleet: () => void;
  openConflictView: () => void;
  closeConflictView: () => void;
  toggleHelpOverlay: () => void;
  clearScrollTarget: () => void;
  setWindowFullScreen: (v: boolean) => void;
  setZenMode: (v: boolean) => void;
  toggleZenMode: () => void;
}

export const useUiStore = create<UiState & UiActions>((set) => ({
  theme: BOOT_THEME,
  sidebarCollapsed: BOOT_SIDEBAR_COLLAPSED,
  sidebarOrganize: BOOT_SIDEBAR_ORGANIZE,
  sidebarSort: BOOT_SIDEBAR_SORT,
  sidebarWidth: BOOT_SIDEBAR_WIDTH,
  activeView: 'dashboard',
  settingsCategory: 'appearance',
  progressAction: null,
  viewMode: 'fleet',
  previousViewMode: null,
  focusPaneId: null,
  duelGroupId: null,
  scrollToMessageId: null,
  helpOverlayOpen: false,
  windowFullScreen: false,
  zenMode: false,

  setTheme: (theme) => set({ theme }),

  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),

  setSidebarOrganize: (sidebarOrganize) => set({ sidebarOrganize }),

  setSidebarSort: (sidebarSort) => set({ sidebarSort }),

  setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),

  setActiveView: (activeView) => set({ activeView }),

  openSettings: (category = 'appearance') => set({ activeView: 'settings', settingsCategory: category }),

  setSettingsCategory: (settingsCategory) => set({ settingsCategory }),

  setProgressAction: (progressAction) => set({ progressAction }),

  setViewMode: (mode) => set({ viewMode: mode }),

  focusPane: (paneId, messageId) =>
    set({ viewMode: 'focus', focusPaneId: paneId, scrollToMessageId: messageId ?? null }),

  openDuel: (groupId) => set({ viewMode: 'duel', duelGroupId: groupId }),

  returnToFleet: () => set({ viewMode: 'fleet', focusPaneId: null, duelGroupId: null, scrollToMessageId: null }),

  openConflictView: () =>
    set((s) => {
      if (s.viewMode === 'conflict-resolution') return s;
      return {
        previousViewMode: s.viewMode,
        viewMode: 'conflict-resolution',
      };
    }),

  closeConflictView: () =>
    set((s) => ({
      viewMode: s.previousViewMode ?? 'fleet',
      previousViewMode: null,
    })),

  toggleHelpOverlay: () => set((s) => ({ helpOverlayOpen: !s.helpOverlayOpen })),

  setWindowFullScreen: (windowFullScreen) => set({ windowFullScreen }),

  setZenMode: (zenMode) => set({ zenMode }),

  toggleZenMode: () => set((s) => ({ zenMode: !s.zenMode })),

  clearScrollTarget: () => set({ scrollToMessageId: null }),
}));
