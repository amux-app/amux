// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MuxBasePane } from 'muxbase/core';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KanbanCard, KanbanCardPreview } from '../../src/renderer/components/kanban/KanbanCard';
import type { KanbanColumnItem } from '../../src/renderer/hooks/useKanbanColumns';
import { usePaneActivityStore } from '../../src/renderer/stores/pane-activity.store';
import { useWorktreeStatusStore } from '../../src/renderer/stores/worktree-status.store';
import { makeActivity as activity } from '../helpers/pane-activity-fixtures';

function pane(overrides: Partial<MuxBasePane> = {}): MuxBasePane {
  return {
    id: 'p1',
    paneId: '%1',
    prompt: 'do the thing',
    slug: 'p1',
    ...overrides,
  };
}

function paneItem(data: MuxBasePane): KanbanColumnItem {
  return { type: 'pane', data };
}

afterEach(() => {
  cleanup();
  usePaneActivityStore.getState().reset();
  useWorktreeStatusStore.setState({ statuses: {} });
});

describe('KanbanCard status precedence', () => {
  it('prefers confirmed idle activity over a stale waiting agentStatus', () => {
    // Arrange
    usePaneActivityStore.setState({ activityByPaneId: { p1: activity({ state: 'idle' }) } });

    // Act
    render(<KanbanCardPreview item={paneItem(pane({ agentStatus: 'waiting' }))} />);

    // Assert
    expect(screen.getByText('Completed')).not.toBeNull();
    expect(screen.queryByText('Needs Input')).toBeNull();
  });

  it('prefers working activity over a stale idle agentStatus', () => {
    // Arrange
    usePaneActivityStore.setState({ activityByPaneId: { p1: activity({ state: 'working' }) } });

    // Act
    render(<KanbanCardPreview item={paneItem(pane({ agentStatus: 'idle' }))} />);

    // Assert
    expect(screen.getByText('Working')).not.toBeNull();
  });

  it('renders completed/unknown while no activity is known yet', () => {
    // Act
    render(<KanbanCardPreview item={paneItem(pane({ agentStatus: 'waiting' }))} />);

    // Assert
    expect(screen.getByText('Completed')).not.toBeNull();
  });

  it('does not project stale waiting metadata for an unresolved activity state', () => {
    // Arrange — activity is present (not undefined) but 'unknown' is an
    // uncertainty state (e.g. an evidence lease expiring), not a confirmed-dead
    // one, so the last known agentStatus should win rather than being
    // collapsed to a fresh idle/busy reading.
    usePaneActivityStore.setState({ activityByPaneId: { p1: activity({ state: 'unknown' }) } });

    // Act
    const { container } = render(<KanbanCardPreview item={paneItem(pane({ agentStatus: 'waiting' }))} />);

    // Assert
    expect(screen.getByText('Completed')).not.toBeNull();
    expect(screen.queryByText('Working')).toBeNull();
    const card = container.querySelector('[data-card-id]');
    expect(card?.className).not.toContain('shadow-[0_0_0_1px_rgba(59,130,246,0.14)_inset,0_0_24px_rgba(56,189,248,0.07)]');
  });
});

describe('KanbanCard states and actions', () => {
  it('renders backlog, launching, and done cards with their state-specific labels', () => {
    render(
      <KanbanCardPreview
        item={{
          type: 'backlog',
          data: {
            complexity: 'L',
            createdAt: Date.now(),
            id: 'backlog-1',
            prompt: 'build it',
            title: 'Build it',
            useWorktree: false,
          },
        }}
      />,
    );
    expect(screen.getByText('Large')).toBeTruthy();
    cleanup();

    render(
      <KanbanCardPreview
        item={{
          type: 'launching',
          data: {
            complexity: 'M',
            createdAt: Date.now(),
            id: 'launching-1',
            prompt: 'launch it',
            title: 'Launching task',
          },
        }}
      />,
    );
    expect(screen.getByText('Launching...')).toBeTruthy();
    cleanup();

    render(
      <KanbanCardPreview
        item={{
          type: 'done',
          data: {
            id: 'done-1',
            mergedAt: Date.now(),
            prompt: 'done prompt',
            slug: 'done-task',
          },
        }}
      />,
    );
    expect(screen.getByText(/merged/)).toBeTruthy();
  });

  it('dispatches user-selected backlog context actions', () => {
    const onAction = vi.fn();
    render(
      <KanbanCard
        draggable={false}
        isSelected={false}
        item={{
          type: 'backlog',
          data: {
            complexity: 'S',
            createdAt: Date.now(),
            id: 'backlog-1',
            prompt: 'build it',
            title: 'Build it',
          },
        }}
        onAction={onAction}
        onClick={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle('Launch agent'));
    fireEvent.click(screen.getByTitle('Edit task'));
    fireEvent.click(screen.getByTitle('Remove'));
    expect(onAction.mock.calls.map(([action]) => action)).toEqual(['launch', 'edit', 'remove']);
  });

  it('renders Git ahead, changed-file, and dirty indicators from the real status store', () => {
    useWorktreeStatusStore.setState({
      statuses: {
        p1: {
          commitsAhead: 2,
          deletions: 1,
          filesChanged: 3,
          hasChanges: true,
          insertions: 4,
          isDirty: true,
        },
      },
    });
    render(<KanbanCardPreview item={paneItem(pane({ branchName: 'feature', worktreePath: '/repo/wt' }))} />);
    expect(screen.getByText('feature')).toBeTruthy();
    expect(screen.getByText('3 files')).toBeTruthy();
    expect(screen.getByText('2 ahead')).toBeTruthy();
    expect(screen.getByTitle('Uncommitted changes')).toBeTruthy();
  });
});
