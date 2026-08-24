// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { HelpOverlay } from '../src/renderer/components/shared/HelpOverlay';
import { SHORTCUT_GROUPS } from '../src/renderer/lib/constants';
import { useUiStore } from '../src/renderer/stores/ui.store';

const EXIT_ZEN_ACTION = 'Exit Zen mode';
const TOGGLE_ZEN_ACTION = 'Toggle Zen mode';

function viewsShortcuts() {
  const views = SHORTCUT_GROUPS.find((g) => g.label === 'Views');
  expect(views).toBeDefined();
  return views!.shortcuts;
}

describe('SHORTCUT_GROUPS Zen entry', () => {
  it('lists Zen under the Views group', () => {
    const zen = viewsShortcuts().find((s) => s.action === TOGGLE_ZEN_ACTION);
    expect(zen).toBeDefined();
    expect(zen!.keys).toBe('⌘ ⌥ Z');
  });

  it('documents the Escape exit directly after the Zen toggle', () => {
    const shortcuts = viewsShortcuts();
    const toggleIndex = shortcuts.findIndex((s) => s.action === TOGGLE_ZEN_ACTION);
    const exit = shortcuts[toggleIndex + 1];

    expect(exit).toEqual({ keys: 'Esc', action: EXIT_ZEN_ACTION });
  });
});

describe('HelpOverlay Zen documentation', () => {
  const uiInitial = useUiStore.getState();

  afterEach(() => {
    cleanup();
    useUiStore.setState(uiInitial);
  });

  it('renders both Zen entries when open', () => {
    // Arrange
    useUiStore.setState({ ...uiInitial, helpOverlayOpen: true });

    // Act
    render(createElement(HelpOverlay));

    // Assert
    const exitRow = screen.getByText(EXIT_ZEN_ACTION).parentElement;
    expect(screen.getByText(TOGGLE_ZEN_ACTION)).toBeTruthy();
    expect(exitRow?.querySelector('kbd')?.textContent).toBe('Esc');
  });
});
