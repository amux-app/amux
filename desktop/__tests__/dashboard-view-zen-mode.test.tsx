// @vitest-environment happy-dom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '../src/renderer/stores/ui.store';
import { usePaneStore } from '../src/renderer/stores/pane.store';

vi.mock('../src/renderer/hooks/useProviderStatus', () => ({ useProviderStatus: () => {} }));
vi.mock('../src/renderer/hooks/useAgentHealth', () => ({ useAgentHealth: () => {} }));
vi.mock('../src/renderer/hooks/useWorktreeStatus', () => ({ useWorktreeStatus: () => {} }));

vi.mock('../src/renderer/components/dashboard/PaneTerminalGrid', () => ({
  PaneTerminalGrid: () => <div data-testid="pane-terminal-grid" />,
}));
vi.mock('../src/renderer/components/dashboard/FocusView', () => ({
  FocusView: () => <div data-testid="focus-view" />,
}));
vi.mock('../src/renderer/components/dashboard/PaneSummaryView', () => ({
  PaneSummaryView: () => <div data-testid="summary-view" />,
}));
vi.mock('../src/renderer/components/kanban/KanbanBoard', () => ({
  KanbanBoard: () => <div data-testid="kanban-board" />,
}));
vi.mock('../src/renderer/components/conflict-resolution/ConflictResolutionView', () => ({
  ConflictResolutionView: () => <div data-testid="conflict-view" />,
}));
vi.mock('../src/renderer/components/worktree/WorktreeOverviewModal', () => ({
  WorktreeOverviewModal: () => null,
}));
vi.mock('../src/renderer/components/dashboard/ResourceBar', () => ({
  ResourceBar: () => <div data-testid="resource-bar" />,
}));
vi.mock('../src/renderer/components/dashboard/StatusBar', () => ({
  StatusBar: () => <div data-testid="status-bar" />,
}));

import { DashboardView } from '../src/renderer/components/dashboard/DashboardView';

describe('DashboardView Zen mode', () => {
  const uiInitial = useUiStore.getState();
  const paneInitial = usePaneStore.getState();

  beforeEach(() => {
    useUiStore.setState({ ...uiInitial, zenMode: false, viewMode: 'fleet' });
    usePaneStore.setState({ ...paneInitial, loaded: true });
  });

  afterEach(() => {
    cleanup();
    useUiStore.setState({ ...uiInitial, zenMode: false });
    usePaneStore.setState(paneInitial);
  });

  it('shows the resource bar when zenMode is false', () => {
    render(<DashboardView />);
    expect(screen.getByTestId('resource-bar')).toBeTruthy();
    expect(screen.getByTestId('status-bar')).toBeTruthy();
  });

  it('hides the resource bar and keeps the status bar when zenMode is true', () => {
    useUiStore.setState({ ...uiInitial, zenMode: true, viewMode: 'fleet' });
    render(<DashboardView />);
    expect(screen.queryByTestId('resource-bar')).toBeNull();
    expect(screen.getByTestId('status-bar')).toBeTruthy();
    expect(screen.getByTestId('pane-terminal-grid')).toBeTruthy();
  });
});
