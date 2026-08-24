// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useUiStore } from '../src/renderer/stores/ui.store';
import { usePaneStore } from '../src/renderer/stores/pane.store';
import { useKeyboardShortcuts } from '../src/renderer/hooks/useKeyboardShortcuts';
import { SHORTCUT_GROUPS } from '../src/renderer/lib/constants';

vi.mock('../src/renderer/hooks/usePaneActions', () => ({
  usePaneActions: () => ({ jumpToPane: vi.fn(), mergePane: vi.fn(), closePane: vi.fn() }),
}));

const DOM_KEY_BY_SHORTCUT_LABEL: Record<string, string> = { Esc: 'Escape' };

function press(init: KeyboardEventInit): void {
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', init)); });
}

describe('useKeyboardShortcuts Zen bindings', () => {
  const uiInitial = useUiStore.getState();
  const paneInitial = usePaneStore.getState();

  beforeEach(() => {
    useUiStore.setState({ ...uiInitial, zenMode: false, viewMode: 'fleet' });
    usePaneStore.setState({ ...paneInitial, panes: [], selectedPaneId: null });
  });

  afterEach(() => {
    cleanup();
    useUiStore.setState({ ...uiInitial, zenMode: false });
    usePaneStore.setState(paneInitial);
  });

  it('⌘⌥Z toggles zenMode', () => {
    renderHook(() => useKeyboardShortcuts());
    expect(useUiStore.getState().zenMode).toBe(false);
    press({ key: 'z', metaKey: true, altKey: true });
    expect(useUiStore.getState().zenMode).toBe(true);
    press({ key: 'z', metaKey: true, altKey: true });
    expect(useUiStore.getState().zenMode).toBe(false);
  });

  it('⌃⌥Z (ctrl variant) also toggles zenMode', () => {
    renderHook(() => useKeyboardShortcuts());
    press({ key: 'z', ctrlKey: true, altKey: true });
    expect(useUiStore.getState().zenMode).toBe(true);
  });

  it('⌘⇧Z (the old shortcut, now the macOS Redo accelerator) does NOT toggle Zen', () => {
    renderHook(() => useKeyboardShortcuts());
    press({ key: 'z', metaKey: true, shiftKey: true });
    expect(useUiStore.getState().zenMode).toBe(false);
  });

  it('Escape exits Zen when zenMode is true', () => {
    useUiStore.setState({ ...uiInitial, zenMode: true });
    renderHook(() => useKeyboardShortcuts());
    press({ key: 'Escape' });
    expect(useUiStore.getState().zenMode).toBe(false);
  });

  it('Escape does nothing to Zen when zenMode is false', () => {
    renderHook(() => useKeyboardShortcuts());
    press({ key: 'Escape' });
    expect(useUiStore.getState().zenMode).toBe(false);
  });

  it('honours the key documented in the help overlay for exiting Zen', () => {
    const documented = SHORTCUT_GROUPS
      .flatMap((group) => group.shortcuts)
      .find((shortcut) => shortcut.action === 'Exit Zen mode');
    const domKey = DOM_KEY_BY_SHORTCUT_LABEL[documented?.keys ?? ''];
    expect(domKey).toBeDefined();

    useUiStore.setState({ ...uiInitial, zenMode: true });
    renderHook(() => useKeyboardShortcuts());
    press({ key: domKey });

    expect(useUiStore.getState().zenMode).toBe(false);
  });

  it('does not exit Zen when the Escape target is a text input', () => {
    useUiStore.setState({ ...uiInitial, zenMode: true });
    renderHook(() => useKeyboardShortcuts());
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(useUiStore.getState().zenMode).toBe(true);
    document.body.removeChild(input);
  });
});

describe('useKeyboardShortcuts sidebar and board bindings', () => {
  const uiInitial = useUiStore.getState();

  beforeEach(() => {
    useUiStore.setState({ ...uiInitial, sidebarCollapsed: false, viewMode: 'fleet' });
  });

  afterEach(() => {
    cleanup();
    useUiStore.setState(uiInitial);
  });

  it('⌘B toggles the sidebar in both directions', () => {
    renderHook(() => useKeyboardShortcuts());

    press({ key: 'b', metaKey: true });
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);

    press({ key: 'b', metaKey: true });
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it('⌘⇧B leaves the sidebar alone and returns the board to the fleet', () => {
    useUiStore.setState({ ...uiInitial, sidebarCollapsed: false, viewMode: 'kanban' });
    renderHook(() => useKeyboardShortcuts());

    press({ key: 'B', metaKey: true, shiftKey: true });

    expect(useUiStore.getState().viewMode).toBe('fleet');
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it('documents both bindings in the help overlay', () => {
    const shortcuts = SHORTCUT_GROUPS.flatMap((group) => group.shortcuts);
    expect(shortcuts.find((s) => s.action === 'Toggle sidebar')?.keys).toBe('⌘ B');
    expect(shortcuts.find((s) => s.action === 'Toggle board alpha')?.keys).toBe('⌘ ⇧ B');
  });
});
