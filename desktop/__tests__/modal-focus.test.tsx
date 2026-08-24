// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from '../src/renderer/components/command-palette/CommandPalette';
import { ConfirmDialog } from '../src/renderer/components/shared/ConfirmDialog';
import { HelpOverlay } from '../src/renderer/components/shared/HelpOverlay';
import { ToastContainer } from '../src/renderer/components/shared/ToastContainer';
import { useKeyboardShortcuts } from '../src/renderer/hooks/useKeyboardShortcuts';
import {
  MODAL_SURFACE_Z_CLASS,
  OVERLAY_CHROME_Z_CLASS,
  TOAST_Z_CLASS,
} from '../src/renderer/lib/constants';
import {
  useCommandPaletteStore,
  useElectronSettingsStore,
  usePaneStore,
  useProjectStore,
  useUiStore,
} from '../src/renderer/stores';

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({
      animate: _animate,
      children,
      exit: _exit,
      initial: _initial,
      transition: _transition,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & Record<'animate' | 'exit' | 'initial' | 'transition', unknown>) => (
      <div {...props}>{children}</div>
    ),
  },
}));

vi.mock('../src/renderer/api/agent-session.api', () => ({
  searchSessions: vi.fn(() => new Promise(() => undefined)),
}));

vi.mock('../src/renderer/api/system.api', () => ({
  searchProjectFiles: vi.fn(() => new Promise(() => undefined)),
  searchProjectText: vi.fn(() => new Promise(() => undefined)),
}));

vi.mock('../src/renderer/api/electron-settings.api', () => ({
  getElectronSettings: vi.fn(),
  resetElectronSettings: vi.fn(),
  updateElectronSetting: vi.fn(),
}));

vi.mock('../src/renderer/hooks/usePaneActions', () => ({
  usePaneActions: () => ({
    closePane: vi.fn(),
    createPane: vi.fn(),
    duplicatePane: vi.fn(),
    jumpToPane: vi.fn(),
    mergePane: vi.fn(),
  }),
}));

const backgroundClick = vi.fn();

function Harness({ withTrigger = true }: { withTrigger?: boolean }) {
  return (
    <div data-testid="app-shell">
      <button data-testid="background" onClick={backgroundClick} type="button">background</button>
      {withTrigger && <button data-testid="trigger" type="button">open</button>}
      <CommandPalette />
      <HelpOverlay />
    </div>
  );
}

function ZenHarness() {
  useKeyboardShortcuts();
  return (
    <div data-testid="app-shell">
      <button data-testid="trigger" type="button">open</button>
      <HelpOverlay />
    </div>
  );
}

function LegacyModalZenHarness() {
  useKeyboardShortcuts();
  return <div aria-label="Legacy dialog" aria-modal="true" role="dialog" />;
}

function layerOf(zClass: string): number {
  return Number(zClass.replace(/\D/g, ''));
}

function focusTrigger(): HTMLElement {
  const trigger = screen.getByTestId('trigger');
  trigger.focus();
  return trigger;
}

function openPalette(): void {
  act(() => useCommandPaletteStore.getState().open());
}

function openHelp(): void {
  act(() => useUiStore.getState().toggleHelpOverlay());
}

function paletteDialog(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Command palette' });
}

function helpDialog(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Keyboard Shortcuts' });
}

function tabButtons(): HTMLElement[] {
  return ['All', 'Files', 'Text', 'Panes', 'Messages', 'Commands'].map((label) => screen.getByRole('button', { name: label }));
}

async function searchInput(): Promise<HTMLInputElement> {
  const input = screen.getByPlaceholderText('Search everywhere...') as HTMLInputElement;
  await waitFor(() => expect(document.activeElement).toBe(input));
  return input;
}

describe('modal focus lifecycle', () => {
  beforeEach(() => {
    useCommandPaletteStore.setState({ activeTab: 'all', isOpen: false, search: '' });
    useElectronSettingsStore.setState({ isLoading: false, settings: null });
    usePaneStore.setState({ panes: [], selectedPaneId: null });
    useProjectStore.setState({ sessionProjectRoot: '' });
    useUiStore.setState({ helpOverlayOpen: false, theme: 'dark', zenMode: false });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  describe('confirm dialog', () => {
    it('returns focus to the initial action when a pending dialog becomes interactive', () => {
      const props = {
        initialFocus: 'cancel' as const,
        message: 'The operation could not be completed.',
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
        open: true,
        title: 'Confirm operation',
      };
      const view = render(<ConfirmDialog {...props} pending={false} />);
      const cancel = screen.getByRole('button', { name: 'Cancel' });

      expect(document.activeElement).toBe(cancel);

      view.rerender(<ConfirmDialog {...props} pending />);
      expect(document.activeElement).toBe(
        screen.getByRole('dialog', { name: 'Confirm operation' }),
      );

      view.rerender(<ConfirmDialog {...props} pending={false} />);
      expect(document.activeElement).toBe(cancel);
    });
  });

  describe('command palette', () => {
    it('renders a labelled modal dialog', () => {
      // Arrange
      render(<Harness />);

      // Act
      openPalette();

      // Assert
      expect(paletteDialog().getAttribute('aria-modal')).toBe('true');
      expect(tabButtons()).toHaveLength(6);
    });

    it('moves initial focus to the search input', async () => {
      // Arrange
      render(<Harness />);

      // Act
      openPalette();

      // Assert
      const input = screen.getByPlaceholderText('Search everywhere...');
      await waitFor(() => expect(document.activeElement).toBe(input));
    });

    it('wraps Tab and Shift+Tab at both ends, including after a search narrows results', async () => {
      // Arrange
      render(<Harness />);
      openPalette();
      const input = await searchInput();
      const tabs = tabButtons();
      const lastTab = tabs[tabs.length - 1];

      // Act + Assert — forward wrap from the last tabbable back to the input.
      lastTab.focus();
      expect(fireEvent.keyDown(lastTab, { key: 'Tab' })).toBe(false);
      expect(document.activeElement).toBe(input);

      // Act + Assert — backward wrap from the input to the last tabbable.
      expect(fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })).toBe(false);
      expect(document.activeElement).toBe(lastTab);

      // Act + Assert — mid-ring Tab is left to the browser.
      tabs[0].focus();
      expect(fireEvent.keyDown(tabs[0], { key: 'Tab' })).toBe(true);

      // Act — narrowing the result list changes dialog content.
      act(() => useCommandPaletteStore.getState().setSearch('zzzz'));

      // Assert — the ring is recomputed at keydown time, so wrapping still holds.
      const narrowedTabs = tabButtons();
      const narrowedLast = narrowedTabs[narrowedTabs.length - 1];
      narrowedLast.focus();
      expect(fireEvent.keyDown(narrowedLast, { key: 'Tab' })).toBe(false);
      expect(document.activeElement).toBe(screen.getByPlaceholderText('Search everywhere...'));
    });

    it('closes on Escape and returns focus to the triggering element', async () => {
      // Arrange
      render(<Harness />);
      const trigger = focusTrigger();
      openPalette();
      const input = await searchInput();

      // Act
      fireEvent.keyDown(input, { key: 'Escape' });

      // Assert
      expect(useCommandPaletteStore.getState().isOpen).toBe(false);
      expect(document.activeElement).toBe(trigger);
    });

    it('falls back to the app shell when the trigger is gone at close time', async () => {
      // Arrange
      const view = render(<Harness />);
      focusTrigger();
      openPalette();
      await searchInput();

      // Act
      view.rerender(<Harness withTrigger={false} />);
      act(() => useCommandPaletteStore.getState().close());

      // Assert
      expect(screen.queryByTestId('trigger')).toBeNull();
      expect(document.activeElement).toBe(screen.getByTestId('app-shell'));
    });

    it('isolates background content behind the backdrop', async () => {
      // Arrange
      render(<Harness />);
      openPalette();
      const input = await searchInput();
      const dialog = paletteDialog();
      const backdrop = dialog.parentElement as HTMLElement;

      // Assert — the backdrop covers the viewport and is not part of the background subtree.
      expect(backdrop.className).toContain('fixed inset-0');
      expect(screen.getByTestId('background').contains(backdrop)).toBe(false);

      // Act + Assert — keyboard focus cannot leave the dialog.
      fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
      expect(dialog.contains(document.activeElement)).toBe(true);

      // Act + Assert — a click inside the panel is contained.
      fireEvent.click(dialog);
      expect(backgroundClick).not.toHaveBeenCalled();
      expect(useCommandPaletteStore.getState().isOpen).toBe(true);

      // Act + Assert — an outside click keeps the existing close-on-backdrop behavior.
      fireEvent.click(backdrop);
      expect(backgroundClick).not.toHaveBeenCalled();
      expect(useCommandPaletteStore.getState().isOpen).toBe(false);
    });
  });

  describe('help overlay', () => {
    it('renders a modal dialog labelled by its visible title and focuses the heading sentinel', async () => {
      // Arrange
      render(<Harness />);

      // Act
      openHelp();

      // Assert
      const dialog = helpDialog();
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      await waitFor(() => expect(document.activeElement).toBe(screen.getByText('Keyboard Shortcuts')));
    });

    it('keeps Tab focus inside the dialog', async () => {
      // Arrange
      render(<Harness />);
      openHelp();
      const dialog = helpDialog();
      await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

      // Act
      const wrapped = fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab' });

      // Assert
      expect(wrapped).toBe(false);
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    it('closes on Escape and on backdrop click, returning focus to the trigger', async () => {
      // Arrange
      render(<Harness />);
      const trigger = focusTrigger();
      openHelp();
      await waitFor(() => expect(helpDialog().contains(document.activeElement)).toBe(true));

      // Act
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });

      // Assert
      expect(useUiStore.getState().helpOverlayOpen).toBe(false);
      expect(document.activeElement).toBe(trigger);

      // Act — reopen and dismiss with an outside click.
      openHelp();
      await waitFor(() => expect(helpDialog().contains(document.activeElement)).toBe(true));
      fireEvent.click(helpDialog().parentElement as HTMLElement);

      // Assert
      expect(useUiStore.getState().helpOverlayOpen).toBe(false);
      expect(backgroundClick).not.toHaveBeenCalled();
    });
  });

  describe('overlay ladder', () => {
    it('stacks chrome below modal surfaces below toasts', () => {
      // Arrange
      const view = render(<><Harness /><ToastContainer /></>);
      openHelp();

      // Act
      const backdrop = helpDialog().parentElement as HTMLElement;
      const toasts = view.container.querySelector('[aria-live="polite"]') as HTMLElement;

      // Assert — the rendered surfaces carry the ladder classes, in ascending order.
      expect(backdrop.className).toContain(MODAL_SURFACE_Z_CLASS);
      expect(toasts.className).toContain(TOAST_Z_CLASS);
      expect(layerOf(OVERLAY_CHROME_Z_CLASS)).toBeLessThan(layerOf(MODAL_SURFACE_Z_CLASS));
      expect(layerOf(MODAL_SURFACE_Z_CLASS)).toBeLessThan(layerOf(TOAST_Z_CLASS));
    });
  });

  describe('zen mode', () => {
    it('gives one Escape to the open surface and exits Zen only on the next press', async () => {
      // Arrange
      useUiStore.setState({ zenMode: true });
      render(<ZenHarness />);
      const trigger = focusTrigger();
      openHelp();
      await waitFor(() => expect(helpDialog().contains(document.activeElement)).toBe(true));

      // Act — a single Escape while both Zen and the help surface are active.
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });

      // Assert — the surface owns the press; Zen survives and focus returns to the trigger.
      expect(useUiStore.getState().helpOverlayOpen).toBe(false);
      expect(useUiStore.getState().zenMode).toBe(true);
      expect(document.activeElement).toBe(trigger);

      // Act — with nothing open, Escape belongs to Zen again.
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });

      // Assert
      expect(useUiStore.getState().zenMode).toBe(false);
    });

    it('leaves Escape to an open aria-modal dialog that predates ModalSurface', () => {
      // Arrange — several shipped dialogs still own their focus/Escape lifecycle.
      useUiStore.setState({ zenMode: true });
      render(<LegacyModalZenHarness />);

      // Act
      fireEvent.keyDown(screen.getByRole('dialog', { name: 'Legacy dialog' }), { key: 'Escape' });

      // Assert
      expect(useUiStore.getState().zenMode).toBe(true);
    });
  });

  describe('stacked surfaces', () => {
    it('lets only the newest surface handle Tab and Escape', async () => {
      // Arrange
      render(<Harness />);
      const trigger = focusTrigger();
      openHelp();
      await waitFor(() => expect(helpDialog().contains(document.activeElement)).toBe(true));
      openPalette();
      const input = await searchInput();

      // Act — Tab from inside the older dialog.
      const helpTitle = screen.getByText('Keyboard Shortcuts');
      helpTitle.focus();
      fireEvent.keyDown(helpTitle, { key: 'Tab' });

      // Assert — the newest trap owns the key; the older one stayed inert.
      expect(paletteDialog().contains(document.activeElement)).toBe(true);
      expect(helpDialog().contains(document.activeElement)).toBe(false);

      // Act — a mid-ring Tab inside the newest surface needs no wrapping.
      const [firstTab] = tabButtons();
      firstTab.focus();
      const handled = fireEvent.keyDown(firstTab, { key: 'Tab' });

      // Assert — the older trap did not consume the key or steal focus.
      expect(handled).toBe(true);
      expect(document.activeElement).toBe(firstTab);

      // Act — Escape closes only the newest surface.
      input.focus();
      fireEvent.keyDown(input, { key: 'Escape' });

      // Assert
      expect(useCommandPaletteStore.getState().isOpen).toBe(false);
      expect(useUiStore.getState().helpOverlayOpen).toBe(true);

      // Act — the remaining surface takes over Escape.
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });

      // Assert
      expect(useUiStore.getState().helpOverlayOpen).toBe(false);
      expect(document.activeElement).toBe(trigger);
    });
  });
});
