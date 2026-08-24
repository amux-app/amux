// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_RESIZE_HANDLE_PX,
  MIN_FLEET_PANE_HEIGHT_PX,
  MIN_FLEET_PANE_WIDTH_PX,
  MIN_FLEET_ROW_COMPRESSED_HEIGHT_PX,
  compactFleetPaneSlots,
  getFleetLayoutMinHeight,
  getFleetRowMinHeight,
  getResponsiveColumnCount,
  useResponsivePanelLayout,
} from '../../src/renderer/hooks/usePanelLayout';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('responsive fleet panel layout', () => {
  it('compacts visible panes while preserving their stable relative order', () => {
    const stableSlots = new Map([
      ['pane-1', 0],
      ['pane-2', 1],
      ['pane-3', 2],
      ['pane-4', 3],
    ]);

    expect([...compactFleetPaneSlots(['pane-4', 'pane-1', 'pane-3'], stableSlots)]).toEqual([
      ['pane-1', 0],
      ['pane-3', 1],
      ['pane-4', 2],
    ]);
  });

  it('uses one column until two readable panes and their separator fit', () => {
    const twoColumnThreshold = (MIN_FLEET_PANE_WIDTH_PX * 2) + FLEET_RESIZE_HANDLE_PX;

    expect(getResponsiveColumnCount(4, twoColumnThreshold - 1)).toBe(1);
    expect(getResponsiveColumnCount(4, twoColumnThreshold)).toBe(2);
  });

  it('reserves enough width for a non-fixed 80-column agent at its readable font floor', () => {
    // 80 columns at the 11px profile need roughly 7px per cell, before panel
    // chrome. Keeping the floor at 560px prevents the normal agent path from
    // satisfying its 80-column invariant by clipping the right edge.
    expect(MIN_FLEET_PANE_WIDTH_PX).toBeGreaterThanOrEqual(80 * 7);
  });

  it('caps Fleet at two columns so every pane keeps a stable pair path', () => {
    const fourPaneWidth = (MIN_FLEET_PANE_WIDTH_PX * 4) + (FLEET_RESIZE_HANDLE_PX * 3);

    expect(getResponsiveColumnCount(6, fourPaneWidth)).toBe(2);
  });

  it('reserves a readable pixel height per row so narrow fleets scroll instead of crushing panes', () => {
    expect(getFleetLayoutMinHeight(5, 1)).toBe(
      (MIN_FLEET_PANE_HEIGHT_PX * 5) + (FLEET_RESIZE_HANDLE_PX * 4),
    );
    expect(getFleetLayoutMinHeight(5, 2)).toBe(
      (MIN_FLEET_PANE_HEIGHT_PX * 3) + (FLEET_RESIZE_HANDLE_PX * 2),
    );
    expect(getFleetLayoutMinHeight(0, 1)).toBe(0);
  });

  it('keeps row minimums compressible below the scrolled group height so row separators stay draggable', () => {
    const rowCount = 5;

    expect(getFleetRowMinHeight(2)).toBe(
      (MIN_FLEET_ROW_COMPRESSED_HEIGHT_PX * 2) + FLEET_RESIZE_HANDLE_PX,
    );
    expect(getFleetRowMinHeight(1) * rowCount).toBeLessThan(
      getFleetLayoutMinHeight(rowCount, 1),
    );
  });

  it('measures when Fleet transitions from an empty state to mounted pane content', () => {
    vi.stubGlobal('ResizeObserver', class {
      disconnect = vi.fn();
      observe = vi.fn();
    });
    const width = (MIN_FLEET_PANE_WIDTH_PX * 2) + FLEET_RESIZE_HANDLE_PX;
    const container = document.createElement('div');
    Object.defineProperty(container, 'offsetWidth', { configurable: true, value: width });
    container.getBoundingClientRect = () => ({ width } as DOMRect);

    const { result, rerender } = renderHook(
      ({ paneCount }) => {
        const containerRef = useRef<HTMLElement | null>(null);
        return {
          containerRef,
          layout: useResponsivePanelLayout(paneCount, containerRef),
        };
      },
      { initialProps: { paneCount: 0 } },
    );

    expect(result.current.layout.columnCount).toBe(1);
    act(() => {
      result.current.containerRef.current = container;
      rerender({ paneCount: 2 });
    });

    expect(result.current.layout.columnCount).toBe(2);
  });

  it('does not rerender Fleet for resize ticks inside the current column breakpoint', () => {
    let notifyResize: ResizeObserverCallback | null = null;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = callback;
      }

      disconnect = vi.fn();
      observe = vi.fn();
    });
    const width = (MIN_FLEET_PANE_WIDTH_PX * 2) + FLEET_RESIZE_HANDLE_PX;
    const container = document.createElement('div');
    Object.defineProperty(container, 'offsetWidth', { configurable: true, value: width });
    container.getBoundingClientRect = () => ({ width } as DOMRect);
    let renderCount = 0;

    const { result, rerender } = renderHook(
      ({ paneCount }) => {
        renderCount += 1;
        const containerRef = useRef<HTMLElement | null>(null);
        return {
          containerRef,
          layout: useResponsivePanelLayout(paneCount, containerRef),
        };
      },
      { initialProps: { paneCount: 0 } },
    );

    act(() => {
      result.current.containerRef.current = container;
      rerender({ paneCount: 2 });
    });
    expect(result.current.layout.columnCount).toBe(2);
    const settledRenderCount = renderCount;

    act(() => {
      notifyResize?.([
        {
          contentRect: { width: width + 1 },
          target: container,
        } as ResizeObserverEntry,
      ], {} as ResizeObserver);
    });

    expect(result.current.layout.columnCount).toBe(2);
    expect(renderCount).toBe(settledRenderCount);
  });
});
