// @vitest-environment happy-dom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIN_TARGET_BUTTON_CLASS } from '../src/renderer/lib/constants';
import { useNotificationStore } from '../src/renderer/stores/notification.store';
import { usePaneStore } from '../src/renderer/stores/pane.store';

const paneApi = vi.hoisted(() => ({ createPane: vi.fn() }));

vi.mock('../src/renderer/api/pane.api', () => paneApi);

import { NewPaneSplitButton } from '../src/renderer/components/dashboard/NewPaneSplitButton';

describe('ResourceBar create split button', () => {
  const paneInitial = usePaneStore.getState();

  beforeEach(() => {
    paneApi.createPane.mockResolvedValue({ success: true });
    useNotificationStore.getState().clearToasts();
    usePaneStore.setState({ ...paneInitial, isCreating: false, createMode: 'single' });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    usePaneStore.setState(paneInitial);
    useNotificationStore.getState().clearToasts();
  });

  it('opens the creation dialog from the primary segment without opening the menu', () => {
    // Arrange
    render(<NewPaneSplitButton />);

    // Act
    fireEvent.click(screen.getByTestId('resource-new-pane'));

    // Assert
    expect(usePaneStore.getState().isCreating).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('sizes both segments to the shared 24px pointer target (WCAG 2.2 SC 2.5.8)', () => {
    // Arrange
    render(<NewPaneSplitButton />);

    // Act
    const segments = ['resource-new-pane', 'resource-new-menu'].map((id) => screen.getByTestId(id));

    // Assert
    for (const segment of segments) {
      expect(segment.className).toContain(MIN_TARGET_BUTTON_CLASS);
    }
    expect(segments[0].parentElement).toBe(segments[1].parentElement);
  });

  it('exposes only the bound create types and focuses the first item', () => {
    // Arrange
    render(<NewPaneSplitButton />);
    const caret = screen.getByTestId('resource-new-menu');

    // Act
    fireEvent.click(caret);

    // Assert
    expect(caret.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Agent pane⌘N', 'Shell', 'Duel']);
    expect(document.activeElement).toBe(screen.getByTestId('resource-new-agent-pane'));
  });

  it('opens the creation dialog pre-set to duel mode', () => {
    // Arrange
    render(<NewPaneSplitButton />);
    fireEvent.click(screen.getByTestId('resource-new-menu'));

    // Act
    fireEvent.click(screen.getByTestId('resource-new-duel'));

    // Assert
    expect(usePaneStore.getState().isCreating).toBe(true);
    expect(usePaneStore.getState().createMode).toBe('duel');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('resets the launch mode to single for a plain create', () => {
    // Arrange
    render(<NewPaneSplitButton />);
    fireEvent.click(screen.getByTestId('resource-new-menu'));
    fireEvent.click(screen.getByTestId('resource-new-duel'));

    // Act
    fireEvent.click(screen.getByTestId('resource-new-pane'));

    // Assert
    expect(usePaneStore.getState().createMode).toBe('single');
  });

  it('creates a shell pane from the menu', () => {
    // Arrange
    render(<NewPaneSplitButton />);
    fireEvent.click(screen.getByTestId('resource-new-menu'));

    // Act
    fireEvent.click(screen.getByTestId('resource-new-shell'));

    // Assert
    expect(paneApi.createPane).toHaveBeenCalledWith({ prompt: '', type: 'shell' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('shows a shell creation failure instead of failing silently', async () => {
    // Arrange
    paneApi.createPane.mockResolvedValue({ success: false, error: 'Choose a project first.' });
    render(<NewPaneSplitButton />);
    fireEvent.click(screen.getByTestId('resource-new-menu'));

    // Act
    fireEvent.click(screen.getByTestId('resource-new-shell'));

    // Assert
    await waitFor(() => {
      expect(useNotificationStore.getState().toasts).toEqual([
        expect.objectContaining({ message: 'Choose a project first.', severity: 'error' }),
      ]);
    });
  });

  it('escape closes the menu and returns focus to the trigger', () => {
    // Arrange
    render(<NewPaneSplitButton />);
    const caret = screen.getByTestId('resource-new-menu');
    fireEvent.click(caret);

    // Act
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    // Assert
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(caret);
  });

  it('arrow keys move focus between menu items', () => {
    // Arrange
    render(<NewPaneSplitButton />);
    fireEvent.click(screen.getByTestId('resource-new-menu'));
    const menu = screen.getByRole('menu');

    // Act
    fireEvent.keyDown(menu, { key: 'ArrowDown' });

    // Assert
    expect(document.activeElement).toBe(screen.getByTestId('resource-new-shell'));

    // Act
    fireEvent.keyDown(menu, { key: 'ArrowUp' });

    // Assert
    expect(document.activeElement).toBe(screen.getByTestId('resource-new-agent-pane'));
  });
});
