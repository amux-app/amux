// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as projectApi from '../src/renderer/api/project.api';
import * as workspaceApi from '../src/renderer/api/workspace.api';
import { WorkspacePicker } from '../src/renderer/components/workspace-picker/WorkspacePicker';
import { useWorkspacePickerStore } from '../src/renderer/stores';

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
}));

vi.mock('../src/renderer/api/workspace.api', () => ({
  createProjectDialog: vi.fn(),
  createSession: vi.fn(),
  listHistory: vi.fn(),
  openFolderDialog: vi.fn(),
  removeHistory: vi.fn(),
  touchHistory: vi.fn(),
}));

vi.mock('../src/renderer/api/project.api', () => ({
  listProjects: vi.fn(),
  switchProject: vi.fn(),
}));

vi.mock('../src/renderer/api/pane.api', () => ({
  listPanes: vi.fn(),
}));

describe('WorkspacePicker delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspacePickerStore.setState({
      activeProjects: [],
      deletingRoot: null,
      historyEntries: [],
      isLoading: false,
      isOpen: true,
      search: '',
      selectedIndex: 0,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('removes a project from history without opening it', async () => {
    // Arrange
    const root = '/private/var/folders/T/aumx-file-browser-e2e';
    useWorkspacePickerStore.setState({
      activeProjects: [
        {
          configPath: `${root}/.aumx/aumx.config.json`,
          name: 'aumx-file-browser-e2e',
          paneCount: 0,
          root,
          sessionName: 'aumx-aumx-file-browser-e2e',
        },
      ],
      historyEntries: [
        {
          lastOpened: 300,
          name: 'aumx-file-browser-e2e',
          paneCount: 0,
          root,
        },
      ],
    });
    vi.mocked(workspaceApi.removeHistory).mockResolvedValue([]);

    // Act
    render(<WorkspacePicker />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove aumx-file-browser-e2e from history' }));

    // Assert
    await waitFor(() => {
      expect(workspaceApi.removeHistory).toHaveBeenCalledWith({ root });
    });
    expect(projectApi.switchProject).not.toHaveBeenCalled();
    expect(screen.queryByText('aumx-file-browser-e2e')).toBeNull();
  });
});
