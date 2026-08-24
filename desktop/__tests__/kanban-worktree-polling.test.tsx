// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KanbanBoard } from '../src/renderer/components/kanban/KanbanBoard';
import { useKanbanStore } from '../src/renderer/stores/kanban.store';
import { usePaneStore } from '../src/renderer/stores/pane.store';
import { useProjectStore } from '../src/renderer/stores/project.store';

const worktreePollingMock = vi.hoisted(() => ({
  useWorktreeStatus: vi.fn(),
}));

vi.mock('../src/renderer/hooks/useWorktreeStatus', () => worktreePollingMock);

vi.mock('../src/renderer/hooks/useKanbanColumns', () => ({
  useColumnOverride: () => ({ removeOverride: vi.fn(), setOverride: vi.fn() }),
  useKanbanColumns: () => ({ columns: [], isLoading: false }),
  useRefreshDirtyMap: () => vi.fn(),
}));

vi.mock('../src/renderer/hooks/usePaneActions', () => ({
  usePaneActions: () => ({ mergePane: vi.fn() }),
}));

describe('KanbanBoard worktree polling ownership', () => {
  beforeEach(() => {
    worktreePollingMock.useWorktreeStatus.mockClear();
    useKanbanStore.setState({
      backlog: [],
      done: [],
      loaded: true,
      loadedProjectRoot: null,
    });
    usePaneStore.setState({ panes: [] });
    useProjectStore.setState({
      activeProject: null,
      sessionProjectRoot: null,
    });
  });

  afterEach(() => cleanup());

  it('leaves project-wide worktree polling to the parent dashboard', () => {
    render(<KanbanBoard />);

    expect(worktreePollingMock.useWorktreeStatus).not.toHaveBeenCalled();
  });
});
