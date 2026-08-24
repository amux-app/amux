// @vitest-environment happy-dom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePaneStore } from '../src/renderer/stores/pane.store';
import { useUiStore } from '../src/renderer/stores/ui.store';

const paneApi = vi.hoisted(() => ({ createPane: vi.fn() }));

vi.mock('../src/renderer/api/pane.api', () => paneApi);

import { Sidebar } from '../src/renderer/components/layout/Sidebar';

describe('Sidebar create affordances', () => {
  const paneInitial = usePaneStore.getState();
  const uiInitial = useUiStore.getState();

  beforeEach(() => {
    paneApi.createPane.mockResolvedValue({ success: true });
    usePaneStore.setState({ ...paneInitial, panes: [], isCreating: false });
    useUiStore.setState({ ...uiInitial, sidebarCollapsed: false });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    usePaneStore.setState(paneInitial);
    useUiStore.setState(uiInitial);
  });

  it('opens the creation dialog from the expanded primary button', () => {
    // Arrange
    render(<Sidebar />);

    // Act
    fireEvent.click(screen.getByTestId('sidebar-new-agent'));

    // Assert
    expect(usePaneStore.getState().isCreating).toBe(true);
    expect(screen.queryByLabelText('Create new pane')).toBeNull();
  });

  it('hides the whole sidebar surface when collapsed', () => {
    // Arrange
    useUiStore.setState({ ...uiInitial, sidebarCollapsed: true });

    // Act
    render(<Sidebar />);

    // Assert — the resizable panel collapses the column to 0; the sidebar marks
    // itself collapsed and leaves the a11y tree, and the titlebar owns the controls.
    const sidebar = screen.getByTestId('app-shell-sidebar');
    expect(sidebar.getAttribute('data-sidebar-mode')).toBe('collapsed');
    expect(sidebar.getAttribute('aria-hidden')).toBe('true');
    expect(sidebar.hasAttribute('inert')).toBe(true);
  });

  it('keeps the sidebar expanded for the Zen peek regardless of the collapse preference', () => {
    // Arrange
    useUiStore.setState({ ...uiInitial, sidebarCollapsed: true });

    // Act
    render(<Sidebar forceExpanded />);

    // Assert
    const sidebar = screen.getByTestId('app-shell-sidebar');
    expect(sidebar.getAttribute('data-sidebar-mode')).toBe('expanded');
    expect(screen.getByTestId('sidebar-new-agent')).toBeTruthy();
  });

  it('creates a shell pane from the tools rail', () => {
    // Arrange
    render(<Sidebar />);

    // Act
    fireEvent.click(screen.getByTestId('sidebar-shell'));

    // Assert
    expect(paneApi.createPane).toHaveBeenCalledWith({ prompt: '', type: 'shell' });
  });
});
