// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AumxPane } from 'aumx/core';
import React, { useEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneTerminalGrid } from '../src/renderer/components/dashboard/PaneTerminalGrid';
import {
  FLEET_RESIZE_HANDLE_PX,
  MIN_FLEET_PANE_WIDTH_PX,
} from '../src/renderer/hooks/usePanelLayout';
import { useHiddenPanesStore, usePaneStore } from '../src/renderer/stores';

const paneLifecycle = vi.hoisted(() => ({
  mount: vi.fn(),
  nextStreamId: 1,
  unmount: vi.fn(),
}));

vi.mock('../src/renderer/components/dashboard/PaneCell', () => ({
  PaneCell: ({ pane }: { pane: AumxPane }) => {
    const [localView, setLocalView] = useState('terminal');
    const streamIdRef = useRef(0);
    if (streamIdRef.current === 0) {
      streamIdRef.current = paneLifecycle.nextStreamId;
      paneLifecycle.nextStreamId += 1;
    }

    useEffect(() => {
      paneLifecycle.mount(pane.id, streamIdRef.current);
      return () => paneLifecycle.unmount(pane.id, streamIdRef.current);
    }, [pane.id]);

    return (
      <div
        data-stream-id={streamIdRef.current}
        data-testid={`mock-pane-${pane.id}`}
      >
        <span data-testid={`local-view-${pane.id}`}>{localView}</span>
        <button type="button" onClick={() => setLocalView('inspected')}>
          Inspect {pane.id}
        </button>
      </div>
    );
  },
}));

let containerWidth = 0;
const resizeObservers: Array<{
  callback: ResizeObserverCallback;
  instance: ResizeObserver;
  targets: Set<Element>;
}> = [];

function rect(width: number): DOMRect {
  return {
    bottom: 700,
    height: 700,
    left: 0,
    right: width,
    toJSON: () => ({}),
    top: 0,
    width,
    x: 0,
    y: 0,
  } as DOMRect;
}

function makePane(index: number): AumxPane {
  return {
    agentStatus: 'idle',
    id: `pane-${index}`,
    paneId: `%${index}`,
    projectRoot: '/repo',
    prompt: '',
    slug: `terminal-${index}`,
    type: 'shell',
  };
}

function makeDuelPane(index: number, groupId: string, role: 'a' | 'b', siblingPaneId: string): AumxPane {
  return {
    ...makePane(index),
    agent: 'claude',
    duel: { groupId, prompt: 'Which is faster?', role, siblingPaneId },
    type: 'worktree',
  };
}

function setPanes(panes: AumxPane[]): void {
  usePaneStore.setState({
    isCreating: false,
    justFinishedPaneIds: new Set<string>(),
    loaded: true,
    panes,
    pendingPane: null,
    selectedPaneId: panes[0]?.id ?? null,
  });
}

function renderedPaneOrder(): Array<string | null> {
  return Array.from(document.querySelectorAll('[data-testid^="mock-pane-"]'))
    .map((node) => node.getAttribute('data-testid'));
}

function resizeFleet(width: number): void {
  containerWidth = width;
  const grid = document.querySelector('[data-fleet-column-count]');
  if (!grid) throw new Error('Fleet grid is not mounted');
  act(() => {
    for (const observer of resizeObservers) {
      if (!observer.targets.has(grid)) continue;
      observer.callback([
        {
          contentRect: rect(width),
          target: grid,
        } as ResizeObserverEntry,
      ], observer.instance);
    }
  });
}

describe('PaneTerminalGrid lifecycle', () => {
  beforeEach(() => {
    containerWidth = (MIN_FLEET_PANE_WIDTH_PX * 2) + FLEET_RESIZE_HANDLE_PX;
    resizeObservers.length = 0;
    paneLifecycle.mount.mockClear();
    paneLifecycle.unmount.mockClear();
    paneLifecycle.nextStreamId = 1;
    useHiddenPanesStore.setState({ hiddenPaneIds: new Set<string>() });
    setPanes([]);

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(() => rect(containerWidth));
    vi.stubGlobal('ResizeObserver', class implements ResizeObserver {
      private readonly record: (typeof resizeObservers)[number];

      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, instance: this, targets: new Set<Element>() };
        resizeObservers.push(this.record);
      }

      disconnect = () => this.record.targets.clear();
      observe = (target: Element) => this.record.targets.add(target);
      unobserve = (target: Element) => this.record.targets.delete(target);
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('preserves existing pane streams and local state when a third pane is appended', () => {
    const first = makePane(1);
    const second = makePane(2);
    const third = makePane(3);
    setPanes([first, second]);
    render(<PaneTerminalGrid />);

    expect(document.getElementById('fleet-pair-pos-0')?.style.flexDirection).toBe('row');
    expect(document.getElementById('fleet-pane-separator-pos-0')?.getAttribute('role')).toBe('separator');
    const firstPaneNode = screen.getByTestId('mock-pane-pane-1');
    const firstStreamId = firstPaneNode.getAttribute('data-stream-id');
    fireEvent.click(screen.getByRole('button', { name: 'Inspect pane-1' }));
    paneLifecycle.mount.mockClear();
    paneLifecycle.unmount.mockClear();

    act(() => setPanes([first, second, third]));

    expect(screen.getByTestId('mock-pane-pane-1')).toBe(firstPaneNode);
    expect(screen.getByTestId('mock-pane-pane-1').getAttribute('data-stream-id')).toBe(firstStreamId);
    expect(screen.getByTestId('local-view-pane-1').textContent).toBe('inspected');
    expect(paneLifecycle.unmount).not.toHaveBeenCalled();
    expect(paneLifecycle.mount).toHaveBeenCalledOnce();
    expect(paneLifecycle.mount).toHaveBeenCalledWith('pane-3', expect.any(Number));
  });

  it('preserves pane streams and local state across the one/two-column breakpoint', () => {
    const panes = [makePane(1), makePane(2), makePane(3)];
    setPanes(panes);
    render(<PaneTerminalGrid />);

    expect(document.querySelector('[data-fleet-column-count]')?.getAttribute('data-fleet-column-count')).toBe('2');
    const firstPaneNode = screen.getByTestId('mock-pane-pane-1');
    const firstStreamId = firstPaneNode.getAttribute('data-stream-id');
    fireEvent.click(screen.getByRole('button', { name: 'Inspect pane-1' }));
    paneLifecycle.mount.mockClear();
    paneLifecycle.unmount.mockClear();

    resizeFleet((MIN_FLEET_PANE_WIDTH_PX * 2) + FLEET_RESIZE_HANDLE_PX - 1);

    expect(document.querySelector('[data-fleet-column-count]')?.getAttribute('data-fleet-column-count')).toBe('1');
    expect(document.getElementById('fleet-pair-pos-0')?.style.flexDirection).toBe('column');
    expect(screen.getByTestId('mock-pane-pane-1')).toBe(firstPaneNode);
    expect(screen.getByTestId('mock-pane-pane-1').getAttribute('data-stream-id')).toBe(firstStreamId);
    expect(screen.getByTestId('local-view-pane-1').textContent).toBe('inspected');
    expect(paneLifecycle.mount).not.toHaveBeenCalled();
    expect(paneLifecycle.unmount).not.toHaveBeenCalled();

    resizeFleet((MIN_FLEET_PANE_WIDTH_PX * 2) + FLEET_RESIZE_HANDLE_PX);

    expect(document.querySelector('[data-fleet-column-count]')?.getAttribute('data-fleet-column-count')).toBe('2');
    expect(document.getElementById('fleet-pair-pos-0')?.style.flexDirection).toBe('row');
    expect(screen.getByTestId('mock-pane-pane-1')).toBe(firstPaneNode);
    expect(screen.getByTestId('local-view-pane-1').textContent).toBe('inspected');
    expect(paneLifecycle.mount).not.toHaveBeenCalled();
    expect(paneLifecycle.unmount).not.toHaveBeenCalled();
  });

  it('only unmounts the closed pane when an earlier slot is removed', () => {
    const panes = [makePane(1), makePane(2), makePane(3), makePane(4)];
    setPanes(panes);
    render(<PaneTerminalGrid />);
    const survivingNodes = new Map(
      panes.slice(1).map((pane) => [pane.id, screen.getByTestId(`mock-pane-${pane.id}`)]),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Inspect pane-3' }));
    paneLifecycle.mount.mockClear();
    paneLifecycle.unmount.mockClear();

    act(() => setPanes(panes.slice(1)));

    for (const [paneId, node] of survivingNodes) {
      expect(screen.getByTestId(`mock-pane-${paneId}`)).toBe(node);
    }
    expect(screen.getByTestId('local-view-pane-3').textContent).toBe('inspected');
    expect(paneLifecycle.mount).not.toHaveBeenCalled();
    expect(paneLifecycle.unmount).toHaveBeenCalledOnce();
    expect(paneLifecycle.unmount).toHaveBeenCalledWith('pane-1', expect.any(Number));
  });

  it('keeps every visible pane mounted while an earlier pane is hidden and restored', () => {
    const panes = [makePane(1), makePane(2), makePane(3), makePane(4)];
    setPanes(panes);
    render(<PaneTerminalGrid />);
    const visibleNodes = new Map(
      panes.slice(1).map((pane) => [pane.id, screen.getByTestId(`mock-pane-${pane.id}`)]),
    );
    paneLifecycle.mount.mockClear();
    paneLifecycle.unmount.mockClear();

    act(() => useHiddenPanesStore.setState({ hiddenPaneIds: new Set(['pane-1']) }));

    for (const [paneId, node] of visibleNodes) {
      expect(screen.getByTestId(`mock-pane-${paneId}`)).toBe(node);
    }
    expect(paneLifecycle.mount).not.toHaveBeenCalled();
    expect(paneLifecycle.unmount).toHaveBeenCalledOnce();
    expect(paneLifecycle.unmount).toHaveBeenCalledWith('pane-1', expect.any(Number));
    paneLifecycle.mount.mockClear();
    paneLifecycle.unmount.mockClear();

    act(() => useHiddenPanesStore.setState({ hiddenPaneIds: new Set<string>() }));

    for (const [paneId, node] of visibleNodes) {
      expect(screen.getByTestId(`mock-pane-${paneId}`)).toBe(node);
    }
    expect(paneLifecycle.mount).toHaveBeenCalledOnce();
    expect(paneLifecycle.mount).toHaveBeenCalledWith('pane-1', expect.any(Number));
    expect(paneLifecycle.unmount).not.toHaveBeenCalled();
  });

  it('compacts visible panes into the earliest Fleet positions after minimizing a pane', () => {
    const panes = [makePane(1), makePane(2), makePane(3), makePane(4)];
    setPanes(panes);
    render(<PaneTerminalGrid />);

    act(() => useHiddenPanesStore.setState({ hiddenPaneIds: new Set(['pane-2']) }));

    const firstRowPaneIds = Array.from(
      document.getElementById('fleet-pair-pos-0')?.querySelectorAll('[data-testid^="mock-pane-"]') ?? [],
    ).map((node) => node.getAttribute('data-testid'));
    const secondRowPaneIds = Array.from(
      document.getElementById('fleet-pair-pos-1')?.querySelectorAll('[data-testid^="mock-pane-"]') ?? [],
    ).map((node) => node.getAttribute('data-testid'));

    expect(firstRowPaneIds).toEqual(['mock-pane-pane-1', 'mock-pane-pane-3']);
    expect(secondRowPaneIds).toEqual(['mock-pane-pane-4']);
    expect(document.querySelector('[data-fleet-row-count]')?.getAttribute('data-fleet-row-count')).toBe('2');
  });

  it('preserves pane identity when store synchronization reorders the pane array', () => {
    const panes = [makePane(1), makePane(2), makePane(3), makePane(4)];
    setPanes(panes);
    render(<PaneTerminalGrid />);
    const paneNodes = new Map(
      panes.map((pane) => [pane.id, screen.getByTestId(`mock-pane-${pane.id}`)]),
    );
    paneLifecycle.mount.mockClear();
    paneLifecycle.unmount.mockClear();

    act(() => setPanes([panes[2], panes[0], panes[3], panes[1]]));

    for (const [paneId, node] of paneNodes) {
      expect(screen.getByTestId(`mock-pane-${paneId}`)).toBe(node);
    }
    expect(paneLifecycle.mount).not.toHaveBeenCalled();
    expect(paneLifecycle.unmount).not.toHaveBeenCalled();
  });

  it('fills a released slot with a new pane without moving surviving panes', () => {
    const panes = [makePane(1), makePane(2), makePane(3), makePane(4)];
    const replacement = makePane(5);
    setPanes(panes);
    render(<PaneTerminalGrid />);
    const survivingNodes = new Map(
      panes.slice(1).map((pane) => [pane.id, screen.getByTestId(`mock-pane-${pane.id}`)]),
    );

    act(() => setPanes(panes.slice(1)));
    paneLifecycle.mount.mockClear();
    paneLifecycle.unmount.mockClear();
    act(() => setPanes([...panes.slice(1), replacement]));

    for (const [paneId, node] of survivingNodes) {
      expect(screen.getByTestId(`mock-pane-${paneId}`)).toBe(node);
    }
    expect(screen.getByTestId('mock-pane-pane-5')).toBeTruthy();
    expect(document.querySelector('[data-fleet-row-count]')?.getAttribute('data-fleet-row-count')).toBe('2');
    expect(paneLifecycle.unmount).not.toHaveBeenCalled();
    expect(paneLifecycle.mount).toHaveBeenCalledOnce();
    expect(paneLifecycle.mount).toHaveBeenCalledWith('pane-5', expect.any(Number));
  });

  it('keeps pane identity and order across waiting and ready transitions', () => {
    const panes = [makePane(1), makePane(2), makePane(3)];
    setPanes(panes);
    render(<PaneTerminalGrid />);
    const paneNodes = new Map(panes.map((pane) => [pane.id, screen.getByTestId(`mock-pane-${pane.id}`)]));
    const initialOrder = renderedPaneOrder();
    paneLifecycle.mount.mockClear();
    paneLifecycle.unmount.mockClear();

    act(() => setPanes([{ ...panes[0], agentStatus: 'waiting' }, panes[1], panes[2]]));

    expect(renderedPaneOrder()).toEqual(initialOrder);

    act(() => usePaneStore.setState({ justFinishedPaneIds: new Set(['pane-2']) }));

    expect(renderedPaneOrder()).toEqual(initialOrder);
    for (const [paneId, node] of paneNodes) {
      expect(screen.getByTestId(`mock-pane-${paneId}`)).toBe(node);
    }
    expect(paneLifecycle.mount).not.toHaveBeenCalled();
    expect(paneLifecycle.unmount).not.toHaveBeenCalled();
  });

  it('announces pane creation without forcing motion on reduced-motion users', () => {
    usePaneStore.setState({
      panes: [],
      pendingPane: { agent: 'claude', prompt: 'Review the project' },
    });

    render(<PaneTerminalGrid />);

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.getAttribute('aria-atomic')).toBe('true');
    expect(status.querySelectorAll('[class*="motion-reduce:animate-none"]')).toHaveLength(4);
  });

  it('pairs duel siblings adjacently even when their slot indices are non-adjacent', () => {
    const duelA = makeDuelPane(1, 'g1', 'a', 'pane-4');
    const filler1 = makePane(2);
    const filler2 = makePane(3);
    const duelB = makeDuelPane(4, 'g1', 'b', 'pane-1');
    setPanes([duelA, filler1, filler2, duelB]);
    render(<PaneTerminalGrid />);

    const duelGroup = document.getElementById('fleet-pair-duel-g1');
    expect(duelGroup).not.toBeNull();
    const paneIds = Array.from(duelGroup!.querySelectorAll('[data-testid^="mock-pane-"]'))
      .map((node) => node.getAttribute('data-testid'));
    expect(paneIds).toEqual(['mock-pane-pane-1', 'mock-pane-pane-4']);
    expect(screen.getByTestId('fleet-duel-vs-chip')).toBeTruthy();
  });

  it('renders a duel pane as a normal positional pane when its sibling is not visible', () => {
    const duelA = makeDuelPane(1, 'g2', 'a', 'pane-9');
    const normal = makePane(2);
    setPanes([duelA, normal]);
    render(<PaneTerminalGrid />);

    expect(document.getElementById('fleet-pair-duel-g2')).toBeNull();
    expect(document.getElementById('fleet-pair-pos-0')).not.toBeNull();
    expect(screen.queryByTestId('fleet-duel-vs-chip')).toBeNull();
  });

  it('shows the VS chip only for duel pairs, not positional pairs', () => {
    setPanes([makePane(1), makePane(2)]);
    render(<PaneTerminalGrid />);

    expect(screen.queryByTestId('fleet-duel-vs-chip')).toBeNull();
  });

  it('does not pair malformed Duel groups with duplicate roles', () => {
    const firstA = makeDuelPane(1, 'g3', 'a', 'pane-2');
    const secondA = makeDuelPane(2, 'g3', 'a', 'pane-1');
    setPanes([firstA, secondA]);

    render(<PaneTerminalGrid />);

    expect(document.getElementById('fleet-pair-duel-g3')).toBeNull();
    expect(screen.queryByTestId('fleet-duel-vs-chip')).toBeNull();
  });
});
