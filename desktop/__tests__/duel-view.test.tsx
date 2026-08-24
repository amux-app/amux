// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AumxPane } from 'aumx/core';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DuelView } from '../src/renderer/components/dashboard/DuelView';
import { usePaneStore, useUiStore } from '../src/renderer/stores';

vi.mock('react-resizable-panels', () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Separator: () => <div role="separator" />,
}));

vi.mock('../src/renderer/components/pane-detail/InteractiveTerminal', () => ({
  InteractiveTerminal: ({ pane }: { pane: AumxPane }) => (
    <div data-testid="interactive-terminal">{pane.id}</div>
  ),
}));

const resolveDuel = vi.fn(async () => ({ success: true as const, loserPaneId: 'pane-b' }));
vi.mock('../src/renderer/api/pane.api', () => ({
  closePane: vi.fn(async () => ({ type: 'success', message: 'closed' })),
  executeCallback: vi.fn(),
  resolveDuel: (...args: unknown[]) => resolveDuel(...args),
}));

function makeDuelPane(role: 'a' | 'b'): AumxPane {
  const id = role === 'a' ? 'pane-a' : 'pane-b';
  return {
    agent: 'claude',
    agentStatus: 'idle',
    duel: { groupId: 'g1', prompt: 'Which is faster?', role, siblingPaneId: role === 'a' ? 'pane-b' : 'pane-a' },
    id,
    paneId: role === 'a' ? '%1' : '%2',
    projectRoot: '/repo',
    prompt: 'Which is faster?',
    slug: role === 'a' ? 'candidate-a' : 'candidate-b',
    type: 'worktree',
  };
}

function setState(panes: AumxPane[], duelGroupId: string | null): void {
  usePaneStore.setState({
    isCreating: false,
    justFinishedPaneIds: new Set<string>(),
    loaded: true,
    panes,
    pendingPane: null,
    selectedPaneId: panes[0]?.id ?? null,
  });
  useUiStore.setState({ duelGroupId, viewMode: 'duel' });
}

describe('DuelView', () => {
  afterEach(cleanup);
  beforeEach(() => vi.clearAllMocks());

  // AAA: arrange two duel panes, act by rendering, assert both terminals mount.
  it('renders both duel terminals side by side', () => {
    setState([makeDuelPane('a'), makeDuelPane('b')], 'g1');

    render(<DuelView />);

    const terminals = screen.getAllByTestId('interactive-terminal').map((n) => n.textContent);
    expect(terminals).toEqual(['pane-a', 'pane-b']);
  });

  // AAA: arrange a single duel pane, act by rendering, assert the empty state escape hatch.
  it('shows an empty state when a sibling is missing', () => {
    setState([makeDuelPane('a')], 'g1');

    render(<DuelView />);

    expect(screen.getByText('Duel unavailable')).toBeTruthy();
    expect(screen.getByRole('button', { name: /back to fleet/i })).toBeTruthy();
  });

  it('rejects malformed groups instead of comparing two panes with the same role', () => {
    const firstA = makeDuelPane('a');
    const secondA = { ...makeDuelPane('a'), id: 'pane-a-2', paneId: '%3' };
    setState([firstA, secondA], 'g1');

    render(<DuelView />);

    expect(screen.getByText('Duel unavailable')).toBeTruthy();
    expect(screen.queryAllByTestId('interactive-terminal')).toHaveLength(0);
  });

  // AAA: arrange both panes, act by declaring + confirming, assert resolveDuel is invoked.
  it('resolves the duel after confirming the winner', () => {
    setState([makeDuelPane('a'), makeDuelPane('b')], 'g1');
    render(<DuelView />);

    fireEvent.click(screen.getByRole('button', { name: /declare candidate-a the winner/i }));
    expect(screen.getByRole('dialog', { name: 'Declare duel winner' })).toBeTruthy();
    expect(screen.getByText(/worktree and branch will be deleted/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep winner' }));

    expect(resolveDuel).toHaveBeenCalledWith({ winnerPaneId: 'pane-a' });
  });
});
