// @vitest-environment happy-dom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '../src/renderer/stores/ui.store';

const systemApi = vi.hoisted(() => ({ getAppInfo: vi.fn() }));
const fileApi = vi.hoisted(() => ({ setFileWatchRoot: vi.fn() }));
vi.mock('../src/renderer/api/file.api', () => fileApi);
vi.mock('../src/renderer/api/system.api', () => systemApi);

vi.mock('../src/renderer/components/layout/Sidebar', () => ({
  Sidebar: () => <aside data-testid="app-shell-sidebar" />,
}));
vi.mock('../src/renderer/components/layout/ContentArea', () => ({
  ContentArea: () => <main data-testid="app-shell-content" />,
}));
vi.mock('../src/renderer/components/file-browser/FileBrowserPanel', () => ({
  FileBrowserPanel: () => <section data-testid="file-browser-panel" />,
}));
vi.mock('../src/renderer/components/shared/RendererErrorBoundary', () => ({
  RendererErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('react-resizable-panels', () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Separator: () => <div />,
  usePanelRef: () => ({ current: null }),
}));

import { AppShell } from '../src/renderer/components/layout/AppShell';

const Z_LAYER = /z-\[?(\d+)\]?/;

function layerOf(el: HTMLElement): number {
  const match = Z_LAYER.exec(el.className);
  return match ? Number(match[1]) : 0;
}

function siblingIndex(el: HTMLElement): number {
  return Array.from(el.parentElement?.children ?? []).indexOf(el);
}

describe('AppShell Zen mode', () => {
  const initial = useUiStore.getState();

  beforeEach(() => {
    fileApi.setFileWatchRoot.mockResolvedValue({ success: true });
    systemApi.getAppInfo.mockResolvedValue({ buildVersion: '0', isPackaged: true, version: '0' });
    useUiStore.setState({ ...initial, zenMode: false });
  });

  afterEach(() => {
    cleanup();
    useUiStore.setState({ ...initial, zenMode: false });
  });

  it('renders the sidebar when zenMode is false', () => {
    render(<AppShell />);
    expect(screen.getByTestId('app-shell-sidebar')).toBeTruthy();
  });

  it('unmounts the normal sidebar while retaining the hidden Zen peek rail', () => {
    useUiStore.setState({ ...initial, zenMode: true });
    render(<AppShell />);

    const sidebars = screen.getAllByTestId('app-shell-sidebar');
    expect(sidebars).toHaveLength(1);
    expect(sidebars[0].parentElement?.className).toContain('pointer-events-none');
    expect(sidebars[0].parentElement?.className).toContain('opacity-0');
    expect(screen.getByTestId('app-shell-content')).toBeTruthy();
  });

  it('paints an open modal above the Zen chip even though the chip renders later', () => {
    // Arrange
    useUiStore.setState({ ...initial, helpOverlayOpen: true, zenMode: true });
    render(<AppShell />);

    // Act
    const backdrop = screen.getByRole('dialog', { name: 'Keyboard Shortcuts' }).parentElement as HTMLElement;
    const chip = screen.getByTestId('zen-exit-chip').closest('div') as HTMLElement;

    // Assert — the chip is a later sibling, so only a strictly higher layer isolates it.
    expect(backdrop.parentElement).toBe(chip.parentElement);
    expect(siblingIndex(chip)).toBeGreaterThan(siblingIndex(backdrop));
    expect(backdrop.className).toContain('fixed inset-0');
    expect(backdrop.className).not.toContain('pointer-events-none');
    expect(layerOf(backdrop)).toBeGreaterThan(layerOf(chip));
  });
});
