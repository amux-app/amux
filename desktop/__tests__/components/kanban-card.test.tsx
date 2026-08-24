// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import type { AumxPane } from 'aumx/core';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { KanbanCardPreview } from '../../src/renderer/components/kanban/KanbanCard';
import type { KanbanColumnItem } from '../../src/renderer/hooks/useKanbanColumns';
import { usePaneActivityStore } from '../../src/renderer/stores/pane-activity.store';
import { makeActivity as activity } from '../helpers/pane-activity-fixtures';

function pane(overrides: Partial<AumxPane> = {}): AumxPane {
  return {
    id: 'p1',
    paneId: '%1',
    prompt: 'do the thing',
    slug: 'p1',
    ...overrides,
  };
}

function paneItem(data: AumxPane): KanbanColumnItem {
  return { type: 'pane', data };
}

afterEach(() => {
  cleanup();
  usePaneActivityStore.getState().reset();
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
