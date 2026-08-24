// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

const ui = vi.hoisted(() => ({
  setActiveView: vi.fn(),
  setViewMode: vi.fn(),
  returnToFleet: vi.fn(),
  toggleHelpOverlay: vi.fn(),
  toggleCommandPalette: vi.fn(),
  openToTab: vi.fn(),
  selectPane: vi.fn(),
  setCreating: vi.fn(),
  requestFindInFile: vi.fn(),
  openWorkspacePicker: vi.fn(),
  jumpToPane: vi.fn(),
  jumpToNextWaitingPane: vi.fn(),
  mergePane: vi.fn(),
  closePane: vi.fn(),
  toggleCollapsed: vi.fn(),
  compactViewport: false,
  kanbanBoardEnabled: false,
  viewMode: 'fleet' as string,
  paneSnapshot: {
    paneIds: [] as string[],
    selectedPaneId: null as string | null,
    selectedTmuxPaneId: null as string | null,
  },
}));

function makeSelectableStore<T extends object>(state: T) {
  return vi.fn((selector: (s: T) => unknown) => selector(state));
}

vi.mock('../../src/renderer/stores', () => ({
  useUiStore: makeSelectableStore({
    get viewMode() { return ui.viewMode; },
    setActiveView: ui.setActiveView,
    setViewMode: ui.setViewMode,
    returnToFleet: ui.returnToFleet,
    toggleHelpOverlay: ui.toggleHelpOverlay,
  }),
  useCommandPaletteStore: makeSelectableStore({
    toggle: ui.toggleCommandPalette,
    openToTab: ui.openToTab,
  }),
  useFileBrowserStore: makeSelectableStore({
    viewingFile: null,
    requestFindInFile: ui.requestFindInFile,
  }),
  usePaneStore: makeSelectableStore({
    selectPane: ui.selectPane,
    setCreating: ui.setCreating,
  }),
  useWorkspacePickerStore: makeSelectableStore({ open: ui.openWorkspacePicker }),
  useElectronSettingsStore: makeSelectableStore({ settings: {} }),
  usePaneKeyboardSnapshot: vi.fn(() => ui.paneSnapshot),
}));

vi.mock('../../src/renderer/lib/feature-flags', () => ({
  isKanbanBoardEnabled: vi.fn(() => ui.kanbanBoardEnabled),
}));

vi.mock('../../src/renderer/hooks/useCompactSidebarViewport', () => ({
  useCompactSidebarViewport: () => ui.compactViewport,
}));

vi.mock('../../src/renderer/hooks/useSidebarPreferences', () => ({
  useSidebarPreferences: () => ({ toggleCollapsed: ui.toggleCollapsed }),
}));

vi.mock('../../src/renderer/hooks/usePaneActions', () => ({
  usePaneActions: () => ({
    jumpToPane: ui.jumpToPane,
    mergePane: ui.mergePane,
    closePane: ui.closePane,
  }),
}));

vi.mock('../../src/renderer/hooks/usePaneAttention', () => ({
  jumpToNextWaitingPane: ui.jumpToNextWaitingPane,
}));

import { useKeyboardShortcuts } from '../../src/renderer/hooks/useKeyboardShortcuts';

interface PressKeyOptions {
  meta?: boolean;
  shift?: boolean;
  target?: EventTarget;
}

function dispatchKey(type: 'keydown' | 'keyup', key: string, opts: PressKeyOptions = {}): void {
  const event = new KeyboardEvent(type, {
    key,
    metaKey: opts.meta ?? false,
    shiftKey: opts.shift ?? false,
    bubbles: true,
  });
  (opts.target ?? window).dispatchEvent(event);
}

function pressKey(key: string, opts: PressKeyOptions = {}): void {
  dispatchKey('keydown', key, opts);
}

function tapShift(): void {
  dispatchKey('keydown', 'Shift', { shift: true });
  dispatchKey('keyup', 'Shift');
}

// Mirrors the raw event order a browser emits for ⌘⇧J, including the non-Shift
// keyup that lands before Shift is released.
function pressJumpChord(): void {
  dispatchKey('keydown', 'Meta', { meta: true });
  dispatchKey('keydown', 'Shift', { meta: true, shift: true });
  dispatchKey('keydown', 'J', { meta: true, shift: true });
  dispatchKey('keyup', 'J', { meta: true, shift: true });
  dispatchKey('keyup', 'Shift', { meta: true });
  dispatchKey('keyup', 'Meta');
}

describe('useKeyboardShortcuts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ui.compactViewport = false;
    ui.kanbanBoardEnabled = false;
    ui.viewMode = 'fleet';
    ui.paneSnapshot = { paneIds: [], selectedPaneId: null, selectedTmuxPaneId: null };
  });

  afterEach(() => {
    // Unmount rendered hooks so their window keydown/keyup listeners are
    // removed — otherwise stale listeners from prior tests still fire.
    cleanup();
  });

  it('Cmd+K toggles the command palette', () => {
    // Arrange
    renderHook(() => useKeyboardShortcuts());

    // Act
    pressKey('k', { meta: true });

    // Assert
    expect(ui.toggleCommandPalette).toHaveBeenCalledTimes(1);
  });

  it('does not register shortcuts before application boot is ready', () => {
    renderHook(() => useKeyboardShortcuts(false));

    pressKey('k', { meta: true });
    pressKey('n', { meta: true });

    expect(ui.toggleCommandPalette).not.toHaveBeenCalled();
    expect(ui.setCreating).not.toHaveBeenCalled();
  });

  it('Cmd+B toggles the sidebar', () => {
    // Arrange
    renderHook(() => useKeyboardShortcuts());

    // Act
    pressKey('b', { meta: true });

    // Assert
    expect(ui.toggleCollapsed).toHaveBeenCalledTimes(1);
    expect(ui.setViewMode).not.toHaveBeenCalled();
  });

  it('Cmd+B leaves the collapse preference alone while the viewport is compact', () => {
    // Arrange — the titlebar toggle is disabled in this state, so the shortcut must be too
    ui.compactViewport = true;
    renderHook(() => useKeyboardShortcuts());

    // Act
    pressKey('b', { meta: true });

    // Assert
    expect(ui.toggleCollapsed).not.toHaveBeenCalled();
  });

  it('Cmd+Shift+B opens the kanban board when the flag is on', () => {
    // Arrange
    ui.kanbanBoardEnabled = true;
    renderHook(() => useKeyboardShortcuts());

    // Act — Shift changes the emitted key to its uppercase form
    pressKey('B', { meta: true, shift: true });

    // Assert
    expect(ui.setViewMode).toHaveBeenCalledWith('kanban');
    expect(ui.toggleCollapsed).not.toHaveBeenCalled();
  });

  it('Cmd+Shift+B leaves the kanban board even when the flag is off', () => {
    // Arrange
    ui.viewMode = 'kanban';
    renderHook(() => useKeyboardShortcuts());

    // Act
    pressKey('B', { meta: true, shift: true });

    // Assert
    expect(ui.returnToFleet).toHaveBeenCalledTimes(1);
  });

  it('Cmd+Shift+B never enters the kanban board while the flag is off', () => {
    // Arrange
    renderHook(() => useKeyboardShortcuts());

    // Act
    pressKey('B', { meta: true, shift: true });

    // Assert
    expect(ui.setViewMode).not.toHaveBeenCalled();
    expect(ui.returnToFleet).not.toHaveBeenCalled();
  });

  it('Escape returns from the duel view to the fleet', () => {
    ui.viewMode = 'duel';
    renderHook(() => useKeyboardShortcuts());

    pressKey('Escape');

    expect(ui.returnToFleet).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape available to an active terminal input in the duel view', () => {
    ui.viewMode = 'duel';
    renderHook(() => useKeyboardShortcuts());
    const terminalInput = document.createElement('textarea');
    document.body.appendChild(terminalInput);

    pressKey('Escape', { target: terminalInput });
    terminalInput.remove();

    expect(ui.returnToFleet).not.toHaveBeenCalled();
  });

  it('leaves Escape to an open modal in the duel view', () => {
    ui.viewMode = 'duel';
    renderHook(() => useKeyboardShortcuts());
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);

    pressKey('Escape');
    dialog.remove();

    expect(ui.returnToFleet).not.toHaveBeenCalled();
  });

  it('Cmd+P opens file search', () => {
    // Arrange
    renderHook(() => useKeyboardShortcuts());

    // Act
    pressKey('p', { meta: true });

    // Assert
    expect(ui.openToTab).toHaveBeenCalledWith('files');
  });

  it('Cmd+N enters pane-creation mode', () => {
    // Arrange
    renderHook(() => useKeyboardShortcuts());

    // Act
    pressKey('n', { meta: true });

    // Assert
    expect(ui.setCreating).toHaveBeenCalledWith(true);
  });

  it('Cmd+J jumps to the selected pane when one is selected', () => {
    // Arrange
    ui.paneSnapshot = { paneIds: ['p1'], selectedPaneId: 'p1', selectedTmuxPaneId: '%5' };
    renderHook(() => useKeyboardShortcuts());

    // Act
    pressKey('j', { meta: true });

    // Assert
    expect(ui.jumpToPane).toHaveBeenCalledWith('%5');
  });

  it('Cmd+J never triggers the attention jump', () => {
    // Arrange
    ui.paneSnapshot = { paneIds: ['p1'], selectedPaneId: 'p1', selectedTmuxPaneId: '%5' };
    renderHook(() => useKeyboardShortcuts());

    // Act
    pressKey('j', { meta: true });

    // Assert
    expect(ui.jumpToPane).toHaveBeenCalledWith('%5');
    expect(ui.jumpToNextWaitingPane).not.toHaveBeenCalled();
  });

  it('Cmd+Shift+J jumps to the next waiting pane', () => {
    // Arrange
    ui.paneSnapshot = { paneIds: ['p1'], selectedPaneId: 'p1', selectedTmuxPaneId: '%5' };
    renderHook(() => useKeyboardShortcuts());

    // Act — Shift changes the emitted key to its uppercase form
    pressKey('J', { meta: true, shift: true });

    // Assert
    expect(ui.jumpToNextWaitingPane).toHaveBeenCalledTimes(1);
    expect(ui.jumpToPane).not.toHaveBeenCalled();
  });

  it('two rapid Cmd+Shift+J chords jump twice and never open project search', () => {
    // Arrange
    ui.paneSnapshot = { paneIds: ['p1'], selectedPaneId: 'p1', selectedTmuxPaneId: '%5' };
    renderHook(() => useKeyboardShortcuts());

    // Act — both chords land well inside the 400 ms double-shift window
    pressJumpChord();
    pressJumpChord();

    // Assert
    expect(ui.jumpToNextWaitingPane).toHaveBeenCalledTimes(2);
    expect(ui.openToTab).not.toHaveBeenCalled();
  });

  it('two bare Shift taps inside the window open project search', () => {
    // Arrange
    renderHook(() => useKeyboardShortcuts());

    // Act
    tapShift();
    tapShift();

    // Assert
    expect(ui.openToTab).toHaveBeenCalledWith('text');
  });

  it('a chord interrupted by window blur still allows the next double-Shift', () => {
    // Arrange — chord keydown with no Shift keyup, then the window loses focus
    ui.paneSnapshot = { paneIds: ['p1'], selectedPaneId: 'p1', selectedTmuxPaneId: '%5' };
    renderHook(() => useKeyboardShortcuts());
    dispatchKey('keydown', 'Meta', { meta: true });
    dispatchKey('keydown', 'Shift', { meta: true, shift: true });
    dispatchKey('keydown', 'J', { meta: true, shift: true });
    window.dispatchEvent(new Event('blur'));

    // Act
    tapShift();
    tapShift();

    // Assert
    expect(ui.openToTab).toHaveBeenCalledWith('text');
  });

  it('a bare Shift tap followed by a Cmd+Shift+J chord does not open project search', () => {
    // Arrange
    ui.paneSnapshot = { paneIds: ['p1'], selectedPaneId: 'p1', selectedTmuxPaneId: '%5' };
    renderHook(() => useKeyboardShortcuts());

    // Act
    tapShift();
    pressJumpChord();

    // Assert
    expect(ui.jumpToNextWaitingPane).toHaveBeenCalledTimes(1);
    expect(ui.openToTab).not.toHaveBeenCalled();
  });

  it('Cmd+Shift+J is ignored while typing in an editable target', () => {
    // Arrange
    renderHook(() => useKeyboardShortcuts());
    const input = document.createElement('input');
    document.body.appendChild(input);

    // Act
    pressKey('J', { meta: true, shift: true, target: input });
    input.remove();

    // Assert
    expect(ui.jumpToNextWaitingPane).not.toHaveBeenCalled();
  });

  it('Cmd+J is a no-op when no pane is selected', () => {
    // Arrange
    ui.paneSnapshot = { paneIds: [], selectedPaneId: null, selectedTmuxPaneId: null };
    renderHook(() => useKeyboardShortcuts());

    // Act
    pressKey('j', { meta: true });

    // Assert
    expect(ui.jumpToPane).not.toHaveBeenCalled();
  });

  it('Cmd+W closes the selected pane', () => {
    // Arrange
    ui.paneSnapshot = { paneIds: ['p1'], selectedPaneId: 'p1', selectedTmuxPaneId: '%5' };
    renderHook(() => useKeyboardShortcuts());

    // Act
    pressKey('w', { meta: true });

    // Assert
    expect(ui.closePane).toHaveBeenCalledWith('p1');
  });

  it('Cmd+<number> selects the pane at that 1-based index', () => {
    // Arrange
    ui.paneSnapshot = {
      paneIds: ['p1', 'p2', 'p3'],
      selectedPaneId: null,
      selectedTmuxPaneId: null,
    };
    renderHook(() => useKeyboardShortcuts());

    // Act
    pressKey('2', { meta: true });

    // Assert
    expect(ui.selectPane).toHaveBeenCalledWith('p2');
  });

  it('? opens the help overlay when not typing in an input', () => {
    // Arrange
    renderHook(() => useKeyboardShortcuts());

    // Act
    pressKey('?');

    // Assert
    expect(ui.toggleHelpOverlay).toHaveBeenCalledTimes(1);
  });

  it('removes its window listeners on unmount', () => {
    // Arrange
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useKeyboardShortcuts());

    // Act
    unmount();

    // Assert — capture-phase registration and removal must use the same option.
    expect(addSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true);
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true);
    expect(removeSpy).toHaveBeenCalledWith('keyup', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('blur', expect.any(Function));
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
