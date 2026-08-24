// @vitest-environment happy-dom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIDEBAR_SEPARATOR_ID } from '../src/renderer/components/layout/sidebarLayout';
import { usePaneStore } from '../src/renderer/stores/pane.store';
import { useUiStore } from '../src/renderer/stores/ui.store';

const systemApi = vi.hoisted(() => ({ getAppInfo: vi.fn() }));
const fileApi = vi.hoisted(() => ({ setFileWatchRoot: vi.fn() }));
const sidebarPreferences = vi.hoisted(() => ({ setWidth: vi.fn(), toggleCollapsed: vi.fn() }));
const platform = vi.hoisted(() => ({ isMac: true }));

vi.mock('../src/renderer/lib/platform', () => ({
  get IS_MAC() { return platform.isMac; },
  MOD_KEY: '\u2318',
}));

vi.mock('../src/renderer/api/file.api', () => fileApi);
vi.mock('../src/renderer/api/system.api', () => systemApi);
vi.mock('../src/renderer/hooks/useSidebarPreferences', () => ({
  useSidebarPreferences: () => sidebarPreferences,
}));
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
  Separator: ({ id, onKeyUp }: { id: string; onKeyUp: React.KeyboardEventHandler }) => (
    <div id={id} onKeyUp={onKeyUp} />
  ),
  usePanelRef: () => ({ current: null }),
}));

import { AppShell } from '../src/renderer/components/layout/AppShell';

describe('AppShell titlebar sidebar cluster', () => {
  const uiInitial = useUiStore.getState();
  const paneInitial = usePaneStore.getState();

  const clusterOf = () => screen.getByTestId('titlebar-sidebar-toggle').closest('div') as HTMLElement;
  const segmentOf = () => screen.getByTestId('app-titlebar').firstElementChild as HTMLElement;

  beforeEach(() => {
    fileApi.setFileWatchRoot.mockResolvedValue({ success: true });
    systemApi.getAppInfo.mockResolvedValue({ buildVersion: '0', isPackaged: true, version: '0' });
    platform.isMac = true;
    useUiStore.setState({ ...uiInitial, sidebarCollapsed: false, windowFullScreen: false, zenMode: false });
    usePaneStore.setState({ ...paneInitial, isCreating: false });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useUiStore.setState(uiInitial);
    usePaneStore.setState(paneInitial);
  });

  it('keeps the cluster visible and reachable while the sidebar is expanded', () => {
    // Arrange & Act
    render(<AppShell />);

    // Assert — permanent chrome: no fade, no inert, no hidden state.
    const cluster = clusterOf();
    expect(cluster.className).not.toContain('opacity-0');
    expect(cluster.className).not.toContain('pointer-events-none');
    expect(cluster.hasAttribute('aria-hidden')).toBe(false);
    expect(cluster.hasAttribute('inert')).toBe(false);
  });

  it('renders the same cluster markup collapsed as expanded', () => {
    // Arrange
    const { unmount } = render(<AppShell />);
    const expanded = clusterOf().outerHTML;
    unmount();
    useUiStore.setState({ ...uiInitial, sidebarCollapsed: true, zenMode: false });

    // Act
    render(<AppShell />);

    // Assert — the top-left is pixel-identical in both states.
    expect(clusterOf().outerHTML).toBe(expanded);
  });

  it('exposes the toggle and New agent controls in both sidebar states', () => {
    // Arrange & Act
    render(<AppShell />);

    // Assert
    expect(screen.getByTestId('titlebar-sidebar-toggle').getAttribute('aria-label')).toBe('Toggle sidebar');
    expect(screen.getByTestId('titlebar-new-agent').getAttribute('aria-label')).toBe('New agent');
  });

  it('reopens the sidebar through the persisted collapse preference while expanded', () => {
    // Arrange
    render(<AppShell />);

    // Act
    fireEvent.click(screen.getByTestId('titlebar-sidebar-toggle'));

    // Assert
    expect(sidebarPreferences.toggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it('toggles the sidebar from the separator Enter key, and only from that key', () => {
    // Arrange — the panel is no longer collapsible, so Enter is handled here, not by the library
    const { container } = render(<AppShell />);
    const separator = container.querySelector(`#${SIDEBAR_SEPARATOR_ID}`) as HTMLElement;

    // Act
    fireEvent.keyUp(separator, { key: 'Enter' });

    // Assert
    expect(sidebarPreferences.toggleCollapsed).toHaveBeenCalledTimes(1);

    // Act — a boundary key commits a width instead of toggling
    fireEvent.keyUp(separator, { key: 'ArrowLeft' });

    // Assert
    expect(sidebarPreferences.toggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it('flips the persisted collapse preference back and forth from the separator Enter key', () => {
    // Arrange — mirror the real hook's toggle so the store reflects each press
    sidebarPreferences.toggleCollapsed.mockImplementation(() => {
      useUiStore.getState().setSidebarCollapsed(!useUiStore.getState().sidebarCollapsed);
    });
    const { container } = render(<AppShell />);
    const separator = container.querySelector(`#${SIDEBAR_SEPARATOR_ID}`) as HTMLElement;

    // Act
    fireEvent.keyUp(separator, { key: 'Enter' });

    // Assert
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);

    // Act — pressing Enter again flips it back
    fireEvent.keyUp(separator, { key: 'Enter' });

    // Assert
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);

    // Act — a boundary key never toggles collapse
    fireEvent.keyUp(separator, { key: 'ArrowLeft' });

    // Assert
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    expect(sidebarPreferences.toggleCollapsed).toHaveBeenCalledTimes(2);
  });

  it('runs the sidebar surface up into the strip and retracts it on collapse', () => {
    // Arrange
    const { unmount } = render(<AppShell />);

    // Assert — the strip tracks the live column width, which defaults to 260px
    expect(segmentOf().style.width).toBe('var(--sidebar-live-width)');
    expect(screen.getByTestId('app-shell').style.getPropertyValue('--sidebar-live-width')).toBe('260px');

    // Act
    unmount();
    useUiStore.setState({ ...uiInitial, sidebarCollapsed: true, zenMode: false });
    render(<AppShell />);

    // Assert
    expect(segmentOf().style.width).toBe('0px');
  });

  it('reserves the traffic-light gutter only while the lights are on screen', () => {
    // Arrange
    const { unmount } = render(<AppShell />);

    // Assert
    expect(screen.getByTestId('app-titlebar').className).toContain('pl-[86px]');

    // Act — macOS parks the lights off-screen in fullscreen
    unmount();
    useUiStore.setState({ ...uiInitial, windowFullScreen: true, zenMode: false });
    render(<AppShell />);

    // Assert
    const strip = screen.getByTestId('app-titlebar');
    expect(strip.className).toContain('pl-[8px]');
    expect(strip.className).not.toContain('pl-[86px]');
  });

  it('drops the gutter entirely off macOS, where there are no traffic lights', () => {
    // Arrange
    platform.isMac = false;

    // Act
    render(<AppShell />);

    // Assert
    expect(screen.getByTestId('app-titlebar').className).toContain('pl-[8px]');
  });

  it('holds the strip at its 44px height so the traffic lights keep their clearance in Zen', () => {
    // Arrange
    useUiStore.setState({ ...uiInitial, sidebarCollapsed: false, zenMode: true });

    // Act
    render(<AppShell />);

    // Assert
    const strip = screen.getByTestId('app-titlebar');
    expect(strip.className).toContain('h-11');
    expect(segmentOf().style.width).toBe('0px');
  });

  it('starts pane creation from the titlebar while collapsed', () => {
    // Arrange
    useUiStore.setState({ ...uiInitial, sidebarCollapsed: true, zenMode: false });
    render(<AppShell />);

    // Act
    fireEvent.click(screen.getByTestId('titlebar-new-agent'));

    // Assert
    expect(usePaneStore.getState().isCreating).toBe(true);
  });

  it('leaves the titlebar to the Zen chrome in Zen mode', () => {
    // Arrange
    useUiStore.setState({ ...uiInitial, sidebarCollapsed: true, zenMode: true });

    // Act
    render(<AppShell />);

    // Assert
    expect(screen.queryByTestId('titlebar-sidebar-toggle')).toBeNull();
    expect(screen.getByTestId('zen-new-pane')).toBeTruthy();
  });
});
