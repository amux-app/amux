// @vitest-environment happy-dom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '../src/renderer/stores/ui.store';
import { useElectronSettingsStore } from '../src/renderer/stores/electron-settings.store';
import { usePaneStore } from '../src/renderer/stores/pane.store';

vi.mock('../src/renderer/api/pane.api', () => ({ createPane: vi.fn() }));

import { ResourceBar } from '../src/renderer/components/dashboard/ResourceBar';

describe('ResourceBar Zen toggle', () => {
  const uiInitial = useUiStore.getState();
  const paneInitial = usePaneStore.getState();
  const settingsInitial = useElectronSettingsStore.getState();

  beforeEach(() => {
    useUiStore.setState({ ...uiInitial, zenMode: false, viewMode: 'fleet' });
    usePaneStore.setState({ ...paneInitial, panes: [], selectedPaneId: null });
  });

  afterEach(() => {
    cleanup();
    useUiStore.setState({ ...uiInitial, zenMode: false });
    usePaneStore.setState(paneInitial);
    useElectronSettingsStore.setState(settingsInitial);
  });

  it('renders an accessible Zen toggle with the ⌘⌥Z hover tooltip', () => {
    render(<ResourceBar />);
    const btn = screen.getByRole('button', { name: 'Toggle Zen mode' });

    expect(btn).toBe(screen.getByTestId('resource-zen-toggle'));
    expect(btn.getAttribute('title')).toBeNull();

    fireEvent.mouseEnter(btn.parentElement!);
    expect(screen.getByRole('tooltip').textContent).toBe('Zen mode (⌘⌥Z)');
  });

  it('clicking the button turns Zen on', () => {
    render(<ResourceBar />);
    expect(useUiStore.getState().zenMode).toBe(false);
    fireEvent.click(screen.getByTestId('resource-zen-toggle'));
    expect(useUiStore.getState().zenMode).toBe(true);
  });
});
