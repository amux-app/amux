// @vitest-environment happy-dom
import { cleanup, render, within } from '@testing-library/react';
import type { AgentStatus, AumxPane } from 'aumx/core';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEffectivePaneStatus } from '../../src/renderer/lib/pane-attention';
import { SidebarAgentRow } from '../../src/renderer/components/layout/SidebarAgentRow';
import type { SidebarPaneStatus } from '../../src/renderer/lib/sidebar-order';
import { useWorktreeStatusStore } from '../../src/renderer/stores/worktree-status.store';
import { usePaneActivityStore } from '../../src/renderer/stores/pane-activity.store';

function pane(overrides: Partial<AumxPane> = {}): AumxPane {
  return {
    agent: 'claude',
    id: 'p1',
    paneId: '%1',
    projectRoot: '/work/alpha',
    prompt: 'do the thing',
    slug: 'p1',
    type: 'worktree',
    ...overrides,
  };
}

function renderRow(status: SidebarPaneStatus | undefined) {
  const { container } = render(
    <ul>
      <SidebarAgentRow
        hidden={false}
        onDelete={async () => false}
        onRename={() => {}}
        onSelect={() => {}}
        pane={pane()}
        selected={false}
        status={status}
      />
    </ul>,
  );
  return within(container);
}

/**
 * Mirrors the sidebar's own derivation: a pane whose config still carries a
 * persisted status, with no live activity yet, must resolve to `unknown`.
 */
function bootStatusFor(persistedStatus: AgentStatus): SidebarPaneStatus {
  const status = getEffectivePaneStatus(pane({ agentStatus: persistedStatus }), null, undefined);
  return { status, waiting: false };
}

function renderPaneRow(paneOverrides: Partial<AumxPane>) {
  const { container } = render(
    <ul>
      <SidebarAgentRow
        hidden={false}
        onDelete={async () => false}
        onRename={() => {}}
        onSelect={() => {}}
        pane={pane(paneOverrides)}
        selected={false}
        status={{ status: 'idle', waiting: false }}
      />
    </ul>,
  );
  return container;
}

afterEach(() => {
  cleanup();
  useWorktreeStatusStore.getState().remove('p1');
  usePaneActivityStore.getState().reset();
});

// The status indicator subtree is aria-hidden — status already reaches
// assistive tech via the row's own aria-label — so these queries opt back in
// with { hidden: true } to inspect the visual affordance directly.
describe('SidebarAgentRow status indicator', () => {
  it('renders a spinner (not a green dot) while working', () => {
    // Arrange / Act
    const row = renderRow({ status: 'working', waiting: false });

    // Assert
    expect(row.getByRole('button', { name: 'p1 · Working' })).not.toBeNull();
    expect(row.getByRole('status', { hidden: true, name: 'Loading' })).not.toBeNull();
    expect(row.queryByRole('status', { hidden: true, name: 'waiting' })).toBeNull();
  });

  it('renders the amber dot while waiting', () => {
    // Arrange / Act
    const row = renderRow({ status: 'idle', waiting: true });

    // Assert
    expect(row.getByRole('button', { name: 'p1 · Waiting for input' })).not.toBeNull();
    expect(row.getByRole('status', { hidden: true, name: 'waiting' })).not.toBeNull();
    expect(row.queryByRole('status', { hidden: true, name: 'Loading' })).toBeNull();
  });

  it('renders nothing in the status indicator while idle', () => {
    // Arrange / Act
    const row = renderRow({ status: 'idle', waiting: false });

    // Assert
    expect(row.getByRole('button', { name: 'p1 · Idle' })).not.toBeNull();
    expect(row.queryByRole('status', { hidden: true })).toBeNull();
  });

  it('does not revive a persisted working spinner when live activity is unknown at boot', () => {
    // Arrange / Act
    const row = renderRow(bootStatusFor('working'));

    // Assert
    expect(row.getByRole('button', { name: 'p1 · Unknown' })).not.toBeNull();
    expect(row.queryByRole('status', { hidden: true, name: 'Loading' })).toBeNull();
  });

  it('never auto-reveals a stale working spinner over time, however long the boot state persists', () => {
    vi.useFakeTimers();
    try {
      const row = renderRow(bootStatusFor('working'));
      const assertNoSpinner = () => {
        expect(row.getByRole('button', { name: 'p1 · Unknown' })).not.toBeNull();
        expect(row.queryByRole('status', { hidden: true, name: 'Loading' })).toBeNull();
      };

      assertNoSpinner();
      vi.advanceTimersByTime(500);
      assertNoSpinner();
      vi.advanceTimersByTime(1500);
      assertNoSpinner();
      vi.advanceTimersByTime(23000);
      assertNoSpinner();
    } finally {
      vi.useRealTimers();
    }
  });
});

// The brand mark anchors the row's right edge for agent identity. It is an
// aria-hidden decorative <svg>; identity already reaches assistive tech via the
// row aria-label and tooltip, so these assertions inspect the DOM directly.
describe('SidebarAgentRow trailing brand', () => {
  it('renders a brand mark for an agent pane', () => {
    // Arrange / Act
    const container = renderPaneRow({ agent: 'codex', type: 'worktree' });

    // Assert
    expect(container.querySelector('[data-testid="sidebar-agent-brand"] svg')).not.toBeNull();
  });

  it('renders the shell glyph for a shell pane with no agent', () => {
    // Arrange / Act
    const container = renderPaneRow({ agent: undefined, type: 'shell', shellType: 'zsh' });

    // Assert
    expect(container.querySelector('[data-testid="sidebar-agent-brand"] svg')).not.toBeNull();
  });

  it('renders no brand mark when the pane has neither an agent nor a shell type', () => {
    // Arrange / Act
    const container = renderPaneRow({ agent: undefined, type: 'worktree' });

    // Assert
    expect(container.querySelector('[data-testid="sidebar-agent-brand"]')).toBeNull();
  });
});

describe('SidebarAgentRow diff counts', () => {
  it('uses light green and red semantic colors without changing the +/- indicators', () => {
    // Arrange
    useWorktreeStatusStore.getState().set('p1', {
      commitsAhead: 0,
      deletions: 3,
      filesChanged: 2,
      insertions: 13,
      isDirty: true,
      lastFetched: 1,
    });

    // Act
    const row = renderRow({ status: 'idle', waiting: false });
    const additions = row.getByText((_content, element) => element?.textContent === '+13');
    const deletions = row.getByText((_content, element) => element?.textContent === '-3');

    // Assert
    expect(additions.textContent).toBe('+13');
    expect(deletions.textContent).toBe('-3');
    expect(additions.classList.contains('text-[var(--sidebar-diff-addition)]')).toBe(true);
    expect(deletions.classList.contains('text-[var(--sidebar-diff-deletion)]')).toBe(true);
    expect(additions.classList.contains('text-[9px]')).toBe(true);
    expect(deletions.classList.contains('text-[9px]')).toBe(true);
    expect(additions.classList.contains('leading-none')).toBe(true);
    expect(deletions.classList.contains('leading-none')).toBe(true);
    expect(additions.parentElement?.classList.contains('items-baseline')).toBe(true);
  });
});
