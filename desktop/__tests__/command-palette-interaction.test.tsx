// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from '../src/renderer/components/command-palette/CommandPalette';
import { useCommandPaletteStore } from '../src/renderer/stores/command-palette.store';

const hookState = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  navigateToFile: vi.fn(),
  navigateToPane: vi.fn(),
  navigateToResult: vi.fn(),
  navigateToTextResult: vi.fn(),
}));

vi.mock('../src/renderer/hooks/useCommandPalette', () => ({
  useCommandPalette: () => ({
    commands: [
      {
        action: vi.fn(),
        id: 'settings',
        label: 'Open Settings',
        section: 'Navigation',
      },
      {
        action: vi.fn(),
        id: 'disabled-like',
        label: 'Other Command',
        section: 'Actions',
      },
    ],
    executeCommand: hookState.executeCommand,
    fileResults: [{ filename: 'App.tsx', path: 'src/App.tsx', rootPath: '/repo' }],
    filesSearching: false,
    filteredPanes: [{ agent: 'codex', id: 'pane-1', slug: 'frontend', status: 'idle' }],
    navigateToFile: hookState.navigateToFile,
    navigateToPane: hookState.navigateToPane,
    navigateToResult: hookState.navigateToResult,
    navigateToTextResult: hookState.navigateToTextResult,
    searchResults: [
      {
        id: 'search-1',
        messageId: 'm1',
        messageType: 'assistant',
        paneId: 'pane-1',
        paneSlug: 'frontend',
        snippet: 'implemented',
      },
    ],
    searching: false,
    searchScope: { label: 'frontend', rootPath: '/repo', scopeId: 'pane-1' },
    textResults: [
      {
        filename: 'App.tsx',
        lineContent: 'implemented',
        lineNumber: 4,
        path: 'src/App.tsx',
        rootPath: '/repo',
      },
    ],
    textSearching: false,
  }),
}));

describe('CommandPalette interactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCommandPaletteStore.setState({
      activeTab: 'commands',
      isOpen: true,
      search: '',
    });
  });

  afterEach(() => {
    cleanup();
    useCommandPaletteStore.setState({ isOpen: false, search: '' });
  });

  it('executes the selected command and closes on Escape without executing another command', () => {
    render(<CommandPalette />);
    fireEvent.click(screen.getByText('Open Settings'));
    expect(hookState.executeCommand).toHaveBeenCalledWith('settings');
    expect(useCommandPaletteStore.getState().isOpen).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
    expect(hookState.executeCommand).toHaveBeenCalledTimes(1);
  });

  it('switches search scopes and invokes file, text, pane, and message result boundaries', () => {
    render(<CommandPalette />);
    fireEvent.change(screen.getByPlaceholderText('Search commands...'), {
      target: { value: 'impl' },
    });
    fireEvent.click(screen.getByText('Files'));
    fireEvent.click(screen.getByText('App.tsx'));
    expect(hookState.navigateToFile).toHaveBeenCalledWith('/repo', 'src/App.tsx');

    fireEvent.click(screen.getByText('Text'));
    fireEvent.click(document.querySelector('[data-value="text-src/App.tsx:4"]')!);
    expect(hookState.navigateToTextResult).toHaveBeenCalledWith('/repo', 'src/App.tsx', 4, 'impl');

    fireEvent.click(screen.getByText('Panes'));
    fireEvent.click(screen.getByText('frontend'));
    expect(hookState.navigateToPane).toHaveBeenCalledWith('pane-1');

    fireEvent.click(screen.getByText('Messages'));
    fireEvent.click(document.querySelector('[data-value="search-1"]')!);
    expect(hookState.navigateToResult).toHaveBeenCalledWith(expect.objectContaining({ id: 'search-1' }));
  });

  it('filters the active tab through the search input and exposes scoped result counts', () => {
    render(<CommandPalette />);
    const input = screen.getByPlaceholderText('Search commands...');
    fireEvent.change(input, { target: { value: 'settings' } });
    expect(useCommandPaletteStore.getState().search).toBe('settings');
    expect(screen.getByDisplayValue('settings')).toBeTruthy();
  });
});
