// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { MuxBasePane } from 'muxbase/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KanbanBoard } from '../src/renderer/components/kanban/KanbanBoard';
import type { KanbanColumn } from '../src/renderer/hooks/useKanbanColumns';
import { useKanbanStore } from '../src/renderer/stores/kanban.store';
import { usePaneStore } from '../src/renderer/stores/pane.store';
import { useProjectStore } from '../src/renderer/stores/project.store';
import { useNotificationStore } from '../src/renderer/stores/notification.store';

const boardMocks = vi.hoisted(() => ({
  columns: [] as KanbanColumn[],
  dragEnd: null as ((event: unknown) => Promise<void>) | null,
  refreshDirtyMap: vi.fn(),
  setOverride: vi.fn(),
  mergePane: vi.fn(),
}));

vi.mock('../src/renderer/hooks/useKanbanColumns', () => ({
  useColumnOverride: () => ({
    removeOverride: vi.fn(),
    setOverride: boardMocks.setOverride,
  }),
  useKanbanColumns: () => ({ columns: boardMocks.columns, isLoading: false }),
  useRefreshDirtyMap: () => boardMocks.refreshDirtyMap,
}));
vi.mock('../src/renderer/hooks/usePaneActions', () => ({
  usePaneActions: () => ({
    closePane: vi.fn(),
    createPane: vi.fn(),
    duplicatePane: vi.fn(),
    jumpToPane: vi.fn(),
    mergePane: boardMocks.mergePane,
  }),
}));
vi.mock('../src/renderer/components/kanban/KanbanColumn', () => ({
  KanbanColumn: ({
    column,
    footerAction,
    onCardAction,
    onCardClick,
    secondaryAction,
  }: {
    column: KanbanColumn;
    footerAction?: { label: string; onClick: () => void };
    onCardAction?: (id: string, action: string) => void;
    onCardClick: (id: string) => void;
    secondaryAction?: { label: string; onClick: () => void };
  }) => (
    <section data-testid={`kanban-column-${column.id}`}>
      <h2>{column.title}</h2>
      {secondaryAction && <button onClick={secondaryAction.onClick}>{secondaryAction.label}</button>}
      {column.items.map((item) => {
        const id =
          item.type === 'backlog'
            ? `backlog-${item.data.id}`
            : item.type === 'pane'
              ? `pane-${item.data.id}`
              : `${item.type}-${item.data.id}`;
        const label =
          item.type === 'backlog' || item.type === 'launching'
            ? item.data.title
            : item.type === 'pane'
              ? item.data.slug
              : item.data.slug;
        return (
          <button
            data-card-id={id}
            key={id}
            onClick={() => onCardClick(id)}
            onContextMenu={(event) => {
              event.preventDefault();
              onCardAction?.(id, 'remove');
            }}
          >
            {label}
          </button>
        );
      })}
      {footerAction && <button onClick={footerAction.onClick}>{footerAction.label}</button>}
    </section>
  ),
}));
vi.mock('../src/renderer/components/kanban/KanbanCard', () => ({
  KanbanCardPreview: () => null,
  getCardId: (item: { type: string; data: { id: string } }) => `${item.type}-${item.data.id}`,
}));
vi.mock('../src/renderer/components/kanban/AddBacklogDialog', () => ({
  AddBacklogDialog: () => null,
}));
vi.mock('../src/renderer/components/kanban/KanbanSidePanel', () => ({
  KanbanSidePanel: ({ pane }: { pane: MuxBasePane }) => <div data-testid="selected-pane">{pane.id}</div>,
}));
vi.mock('../src/renderer/components/worktree/WorktreeOverviewModal', () => ({
  WorktreeOverviewModal: () => null,
}));
vi.mock('../src/renderer/components/shared/Spinner', () => ({
  Spinner: () => null,
}));
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({
    children,
    onDragEnd,
  }: {
    children: React.ReactNode;
    onDragEnd: (event: unknown) => Promise<void>;
  }) => {
    boardMocks.dragEnd = onDragEnd;
    return <>{children}</>;
  },
  DragOverlay: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  KeyboardSensor: {},
  PointerSensor: {},
  closestCenter: vi.fn(),
  pointerWithin: vi.fn(() => []),
  rectIntersection: vi.fn(() => []),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));
vi.mock('react-resizable-panels', () => ({
  Group: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Panel: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Separator: () => null,
}));

function backlog(id: string, title = id) {
  return {
    complexity: 'M' as const,
    createdAt: Date.now(),
    id,
    order: Number(id.slice(-1)) || 0,
    prompt: `prompt ${id}`,
    title,
  };
}

function pane(id: string): MuxBasePane {
  return {
    agent: 'codex',
    id,
    paneId: `%${id}`,
    projectRoot: '/repo',
    prompt: `prompt ${id}`,
    slug: id,
  };
}

function columnsFor(items: ReturnType<typeof backlog>[], panes: MuxBasePane[] = []): KanbanColumn[] {
  return [
    {
      id: 'backlog',
      title: 'Backlog',
      color: 'gray',
      draggableCards: true,
      droppable: true,
      items: items.map((data) => ({ data, type: 'backlog' as const })),
    },
    {
      id: 'in-progress',
      title: 'In Progress',
      color: 'blue',
      draggableCards: true,
      droppable: true,
      items: panes.map((data) => ({ data, type: 'pane' as const })),
    },
    {
      id: 'needs-attention',
      title: 'Needs Attention',
      color: 'yellow',
      draggableCards: true,
      droppable: true,
      items: [],
    },
    {
      id: 'review',
      title: 'Review',
      color: 'purple',
      draggableCards: true,
      droppable: true,
      items: [],
    },
    {
      id: 'done',
      title: 'Done',
      color: 'green',
      draggableCards: true,
      droppable: true,
      items: [],
    },
  ];
}

describe('KanbanBoard interactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boardMocks.columns = columnsFor([backlog('b1', 'First'), backlog('b2', 'Second')]);
    boardMocks.dragEnd = null;
    useProjectStore.setState({
      activeProject: {
        name: 'repo',
        root: '/repo',
        sessionName: 'muxbase-repo',
        configPath: '',
        paneCount: 0,
      },
      sessionProjectRoot: '/repo',
    });
    usePaneStore.setState({ panes: [] });
    useNotificationStore.getState().clearToasts();
    useKanbanStore.setState({
      backlog: [],
      done: [],
      loaded: true,
      loadedProjectRoot: '/repo',
    });
  });

  afterEach(() => cleanup());

  it('reorders backlog cards through the board DnD boundary', async () => {
    const reorderBacklog = vi.fn().mockResolvedValue(undefined);
    useKanbanStore.setState({ reorderBacklog });
    render(<KanbanBoard />);
    await boardMocks.dragEnd?.({
      active: { id: 'backlog-b1' },
      over: { data: { current: { columnId: 'backlog' } }, id: 'backlog-b2' },
    });
    expect(reorderBacklog).toHaveBeenCalledWith('/repo', ['b2', 'b1']);
  });

  it('suppresses duplicate launch requests and retains failed backlog items', async () => {
    let release!: (value: { errors: string[]; launched: number; launchedPaneIds: string[] }) => void;
    const batchLaunch = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    useKanbanStore.setState({ batchLaunch });
    render(<KanbanBoard />);
    const event = {
      active: { id: 'backlog-b1' },
      over: {
        data: { current: { columnId: 'in-progress' } },
        id: 'in-progress',
      },
    };
    const first = boardMocks.dragEnd?.(event);
    const second = boardMocks.dragEnd?.(event);
    expect(batchLaunch).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(
        useNotificationStore.getState().toasts.some((toast) => toast.message.includes('already in progress')),
      ).toBe(true),
    );
    release({
      errors: ['Second failed'],
      launched: 1,
      launchedPaneIds: ['pane-new'],
    });
    await Promise.all([first, second]);
    await waitFor(() =>
      expect(useNotificationStore.getState().toasts.some((toast) => toast.message === 'Second failed')).toBe(true),
    );
    expect(screen.getByText('Second')).toBeTruthy();
  });

  it('applies only valid cross-column pane overrides and follows selection', async () => {
    const existing = pane('pane-1');
    boardMocks.columns = columnsFor([], [existing]);
    usePaneStore.setState({ panes: [existing] });
    render(<KanbanBoard />);
    fireEvent.click(screen.getByText('pane-1'));
    expect(screen.getByTestId('selected-pane').textContent).toBe('pane-1');
    await boardMocks.dragEnd?.({
      active: { id: 'pane-pane-1' },
      over: { data: { current: { columnId: 'done' } }, id: 'done' },
    });
    expect(boardMocks.setOverride).toHaveBeenCalledWith('pane-1', 'done');
    await boardMocks.dragEnd?.({
      active: { id: 'pane-pane-1' },
      over: { data: { current: { columnId: 'backlog' } }, id: 'backlog' },
    });
    expect(boardMocks.setOverride).toHaveBeenCalledTimes(1);
  });

  it('shows batch controls only when the active project has valid backlog work', () => {
    render(<KanbanBoard />);
    expect(screen.getByRole('button', { name: 'Launch All' }).disabled).toBe(false);
    useProjectStore.setState({ activeProject: null, sessionProjectRoot: '' });
    cleanup();
    render(<KanbanBoard />);
    fireEvent.click(screen.getByRole('button', { name: 'Launch All' }));
    expect(useNotificationStore.getState().toasts.some((toast) => toast.severity === 'error')).toBe(true);
  });
});
