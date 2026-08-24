// @vitest-environment happy-dom
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileBrowserStore } from '../src/renderer/stores/file-browser.store';

const systemApi = vi.hoisted(() => ({
  getAppInfo: vi.fn(),
}));

const fileApi = vi.hoisted(() => ({
  setFileWatchRoot: vi.fn(),
}));

vi.mock('../src/renderer/api/file.api', () => fileApi);
vi.mock('../src/renderer/api/system.api', () => systemApi);

vi.mock('../src/renderer/components/layout/Sidebar', () => ({
  Sidebar: () => <aside data-testid="sidebar" />,
}));

vi.mock('../src/renderer/components/layout/ContentArea', () => ({
  ContentArea: () => <main data-testid="content-area" />,
}));

vi.mock('../src/renderer/components/file-browser/FileBrowserPanel', () => ({
  FileBrowserPanel: () => <section data-testid="file-browser-panel" />,
}));

vi.mock('../src/renderer/components/shared/HelpOverlay', () => ({
  HelpOverlay: () => null,
}));

vi.mock('../src/renderer/components/shared/RendererErrorBoundary', () => ({
  RendererErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('react-resizable-panels', () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div data-testid="panel-group">{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div data-testid="panel">{children}</div>,
  Separator: ({ id }: { id?: string }) => <div data-testid={id ?? 'separator'} />,
  usePanelRef: () => ({ current: null }),
}));

import { AppShell } from '../src/renderer/components/layout/AppShell';

describe('AppShell file browser layout', () => {
  beforeEach(() => {
    fileApi.setFileWatchRoot.mockResolvedValue({ success: true });
    systemApi.getAppInfo.mockResolvedValue({
      buildVersion: '0.1.0',
      isPackaged: false,
      version: '0.1.0',
    });

    useFileBrowserStore.setState({
      clipboard: null,
      draftResetKey: 0,
      expandedDirs: {},
      findInFileRequestKey: 0,
      folderColors: {},
      isOpen: false,
      pendingFileSaveHandler: null,
      trees: {},
      viewerCrowded: false,
      viewingFile: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the dev marker in development runtime', async () => {
    // Arrange
    systemApi.getAppInfo.mockResolvedValue({
      buildVersion: '0.1.0',
      isPackaged: false,
      version: '0.1.0',
    });

    // Act
    render(<AppShell />);

    // Assert
    expect(await screen.findByText('dev')).toBeTruthy();
  });

  it('hides the dev marker in packaged runtime', async () => {
    // Arrange
    systemApi.getAppInfo.mockResolvedValue({
      buildVersion: '0.1.0',
      isPackaged: true,
      version: '0.1.0',
    });

    // Act
    render(<AppShell />);

    // Assert
    await waitFor(() => expect(systemApi.getAppInfo).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('dev')).toBeNull();
    expect(screen.queryByText('Installed')).toBeNull();
  });

  it('remounts the file browser panel after a close and reopen cycle', async () => {
    // Arrange
    render(<AppShell />);

    // Act
    await act(async () => {
      useFileBrowserStore.getState().open();
    });

    // Assert
    expect(screen.getByTestId('file-browser-panel')).toBeTruthy();

    // Act
    await act(async () => {
      await useFileBrowserStore.getState().close();
    });

    // Assert
    expect(screen.queryByTestId('file-browser-panel')).toBeNull();

    // Act
    await act(async () => {
      useFileBrowserStore.getState().open();
    });

    // Assert
    expect(screen.getByTestId('file-browser-panel')).toBeTruthy();
  });
});
