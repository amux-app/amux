import { useEffect, useRef } from 'react';
import { hasOpenModalSurface } from '../components/shared/ModalSurface';
import {
  useCommandPaletteStore,
  useElectronSettingsStore,
  useFileBrowserStore,
  usePaneKeyboardSnapshot,
  usePaneStore,
  useUiStore,
  useWorkspacePickerStore,
} from '../stores';
import { isKanbanBoardEnabled } from '../lib/feature-flags';
import { resolveSearchShortcutIntent, shouldTriggerProjectSearchOnDoubleShift } from '../lib/search-shortcut-intents';
import type { ViewMode } from '../stores/ui.store';
import { useCompactSidebarViewport } from './useCompactSidebarViewport';
import { usePaneActions } from './usePaneActions';
import { jumpToNextWaitingPane } from './usePaneAttention';
import { useSidebarPreferences } from './useSidebarPreferences';

interface KanbanViewState {
  kanbanBoardEnabled: boolean;
  returnToFleet: () => void;
  setViewMode: (mode: ViewMode) => void;
  viewMode: ViewMode;
}

// Leaving kanban always works; entering it stays behind the feature flag.
function toggleKanbanView(s: KanbanViewState): void {
  if (s.viewMode === 'kanban') {
    s.returnToFleet();
    return;
  }
  if (s.kanbanBoardEnabled) s.setViewMode('kanban');
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  const tag = el?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable === true;
}

export function useKeyboardShortcuts(enabled = true): void {
  const setActiveView = useUiStore((s) => s.setActiveView);
  const viewMode = useUiStore((s) => s.viewMode);
  const setViewMode = useUiStore((s) => s.setViewMode);
  const returnToFleet = useUiStore((s) => s.returnToFleet);
  const toggleHelpOverlay = useUiStore((s) => s.toggleHelpOverlay);
  const zenMode = useUiStore((s) => s.zenMode);
  const setZenMode = useUiStore((s) => s.setZenMode);
  const toggleZenMode = useUiStore((s) => s.toggleZenMode);
  const toggleCommandPalette = useCommandPaletteStore((s) => s.toggle);
  const openToTab = useCommandPaletteStore((s) => s.openToTab);
  const paneSnapshot = usePaneKeyboardSnapshot();
  const selectPane = usePaneStore((s) => s.selectPane);
  const setCreating = usePaneStore((s) => s.setCreating);
  const hasOpenFile = useFileBrowserStore((s) => s.viewingFile !== null);
  const requestFindInFile = useFileBrowserStore((s) => s.requestFindInFile);
  const openWorkspacePicker = useWorkspacePickerStore((s) => s.open);
  const electronSettings = useElectronSettingsStore((s) => s.settings);
  const kanbanBoardEnabled = isKanbanBoardEnabled(electronSettings);
  const { jumpToPane, mergePane, closePane } = usePaneActions();
  const { toggleCollapsed: toggleSidebar } = useSidebarPreferences();
  const compactViewport = useCompactSidebarViewport();

  const stateRef = useRef({
    toggleCommandPalette,
    openToTab,
    toggleHelpOverlay,
    setActiveView,
    viewMode,
    setViewMode,
    returnToFleet,
    paneSnapshot,
    selectPane,
    setCreating,
    hasOpenFile,
    requestFindInFile,
    jumpToPane,
    mergePane,
    closePane,
    openWorkspacePicker,
    kanbanBoardEnabled,
    toggleSidebar,
    compactViewport,
    zenMode,
    setZenMode,
    toggleZenMode,
  });

  useEffect(() => {
    stateRef.current = {
      toggleCommandPalette,
      openToTab,
      toggleHelpOverlay,
      setActiveView,
      viewMode,
      setViewMode,
      returnToFleet,
      paneSnapshot,
      selectPane,
      setCreating,
      hasOpenFile,
      requestFindInFile,
      jumpToPane,
      mergePane,
      closePane,
      openWorkspacePicker,
      kanbanBoardEnabled,
      toggleSidebar,
      compactViewport,
      zenMode,
      setZenMode,
      toggleZenMode,
    };
  });

  useEffect(() => {
    if (!enabled) return;

    let lastShiftUp = 0;
    let shiftChorded = false;

    function handleKeyDown(e: KeyboardEvent): void {
      const meta = e.metaKey || e.ctrlKey;
      const s = stateRef.current;

      if (e.key !== 'Shift' && e.shiftKey) shiftChorded = true;

      if (!meta && e.key === '?') {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        s.toggleHelpOverlay();
        return;
      }

      // Escape belongs to the topmost open surface; Zen only claims it last.
      if (!meta && e.key === 'Escape' && s.zenMode && !hasOpenModalSurface()) {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        s.setZenMode(false);
        return;
      }

      if (!meta && e.key === 'Escape' && s.viewMode === 'duel' && !hasOpenModalSurface()) {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        s.returnToFleet();
        return;
      }

      const searchIntent = resolveSearchShortcutIntent(e, s.hasOpenFile);
      if (searchIntent === 'file') {
        e.preventDefault();
        s.requestFindInFile();
        return;
      }

      if (searchIntent === 'files') {
        e.preventDefault();
        s.openToTab('files');
        return;
      }

      if (searchIntent === 'project') {
        e.preventDefault();
        s.openToTab('text');
        return;
      }

      if (!meta) return;

      switch (e.key) {
        case 'k':
          e.preventDefault();
          s.toggleCommandPalette();
          break;
        case 'n':
          e.preventDefault();
          s.setCreating(true);
          break;
        case 'o':
          e.preventDefault();
          s.openWorkspacePicker();
          break;
        case 'b':
          e.preventDefault();
          // The titlebar toggle is disabled under a compact viewport; flipping the
          // preference blind would surface later as the wrong state.
          if (!s.compactViewport) s.toggleSidebar();
          break;
        case 'B':
          if (e.shiftKey) {
            e.preventDefault();
            toggleKanbanView(s);
          }
          break;
        case ',':
          e.preventDefault();
          s.setActiveView('settings');
          break;
        case 'j': {
          e.preventDefault();
          if (s.paneSnapshot.selectedTmuxPaneId) {
            s.jumpToPane(s.paneSnapshot.selectedTmuxPaneId);
          }
          break;
        }
        case 'J': {
          if (e.shiftKey && !isTypingTarget(e.target)) {
            e.preventDefault();
            jumpToNextWaitingPane();
          }
          break;
        }
        case 'm': {
          e.preventDefault();
          if (s.paneSnapshot.selectedPaneId) {
            s.mergePane(s.paneSnapshot.selectedPaneId);
          }
          break;
        }
        case 'w': {
          e.preventDefault();
          if (s.paneSnapshot.selectedPaneId) {
            s.closePane(s.paneSnapshot.selectedPaneId);
          }
          break;
        }
        case 'z': {
          // ⌘⌥Z toggles Zen. ⇧ variant collides with macOS Edit → Redo, which
          // Electron's default menu owns before the renderer sees it.
          if (e.altKey) {
            e.preventDefault();
            s.toggleZenMode();
          }
          break;
        }
        default:
          if (e.key >= '1' && e.key <= '9') {
            e.preventDefault();
            const idx = parseInt(e.key, 10) - 1;
            if (idx < s.paneSnapshot.paneIds.length) {
              s.selectPane(s.paneSnapshot.paneIds[idx]);
            }
          }
      }
    }

    // Chord participation only ever clears when Shift itself is released, so a
    // chorded Shift can never be recorded as a standalone double-shift tap.
    function handleKeyUp(e: KeyboardEvent): void {
      if (e.key !== 'Shift') return;
      const chorded = shiftChorded;
      shiftChorded = false;

      const now = Date.now();
      if (shouldTriggerProjectSearchOnDoubleShift({ key: e.key, lastShiftUp, now, shiftChorded: chorded })) {
        lastShiftUp = 0;
        stateRef.current.openToTab('text');
        return;
      }
      lastShiftUp = chorded ? 0 : now;
    }

    // A window switch mid-chord swallows the Shift keyup, so the chord state is
    // dropped on blur instead of leaking into the next double-shift.
    function handleBlur(): void {
      lastShiftUp = 0;
      shiftChorded = false;
    }

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [enabled]);
}
