// @vitest-environment happy-dom

import { cleanup, render, screen, act } from '@testing-library/react';
import type { MuxBasePane } from 'muxbase/core';
import React, { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneTerminalGrid } from '../src/renderer/components/dashboard/PaneTerminalGrid';
import { useHiddenPanesStore, usePaneStore } from '../src/renderer/stores';

type ResizeCb = (size: { asPercentage: number; inPixels: number }) => void;
const panelResizeCallbacks: ResizeCb[] = [];

vi.mock('react-resizable-panels', () => ({
  Group: ({ children }: { children: ReactNode }) => <div data-mock="group">{children}</div>,
  Separator: () => <div data-mock="separator" />,
  Panel: ({ children, onResize }: { children: ReactNode; onResize?: ResizeCb }) => {
    if (onResize) panelResizeCallbacks.push(onResize);
    return <div data-mock="panel">{children}</div>;
  },
}));

vi.mock('../src/renderer/components/dashboard/PaneCell', () => ({
  PaneCell: ({ pane }: { pane: MuxBasePane }) => <div data-testid={`mock-pane-${pane.id}`} />,
}));

function makeDuelPane(index: number, role: 'a' | 'b', siblingPaneId: string): MuxBasePane {
  return {
    agent: 'claude',
    agentStatus: 'idle',
    duel: { groupId: 'g1', prompt: 'q', role, siblingPaneId },
    id: `pane-${index}`,
    paneId: `%${index}`,
    projectRoot: '/repo',
    prompt: '',
    slug: `t-${index}`,
    type: 'worktree',
  };
}

function chipWrapperStyle(): string {
  const chip = screen.getByTestId('fleet-duel-vs-chip');
  const wrapper = chip.closest('.-translate-x-1\\/2') as HTMLElement;
  return wrapper.getAttribute('style') ?? '';
}

describe('Duel VS chip position tracks the divider', () => {
  beforeEach(() => {
    panelResizeCallbacks.length = 0;
    usePaneStore.getState().setPanes([]);
    useHiddenPanesStore.setState({ hiddenPaneIds: new Set() });
  });
  afterEach(cleanup);

  it('centers at 50% initially, then follows the panel A resize percentage', () => {
    // Arrange: two linked duel siblings → one duel pair with a VS chip.
    act(() => {
      usePaneStore.getState().setPanes([
        makeDuelPane(1, 'a', 'pane-2'),
        makeDuelPane(2, 'b', 'pane-1'),
      ]);
    });
    render(<PaneTerminalGrid />);

    // Assert: default centered on the seam (both axes 50%), not hardcoded justify-center.
    expect(chipWrapperStyle()).toContain('left: 50%');
    expect(chipWrapperStyle()).toContain('top: 50%');
    expect(panelResizeCallbacks.length).toBeGreaterThan(0);

    // Act: simulate dragging the divider so panel A becomes 72% of the pair.
    act(() => panelResizeCallbacks[0]({ asPercentage: 72, inPixels: 720 }));

    // Assert: chip tracks the divider to 72% along the split axis; the cross axis stays centered.
    const style = chipWrapperStyle();
    expect(style.includes('left: 72%') || style.includes('top: 72%')).toBe(true);
    expect(style.includes('left: 50%') || style.includes('top: 50%')).toBe(true);
  });
});
