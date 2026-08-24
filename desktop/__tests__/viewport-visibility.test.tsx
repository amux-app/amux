// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useViewportVisibility } from '../src/renderer/hooks/useViewportVisibility';

interface ObserverHarness {
  callback?: IntersectionObserverCallback;
  disconnect: ReturnType<typeof vi.fn>;
  observe: ReturnType<typeof vi.fn>;
  options?: IntersectionObserverInit;
}

const observer = vi.hoisted<ObserverHarness>(() => ({
  disconnect: vi.fn(),
  observe: vi.fn(),
}));

describe('useViewportVisibility', () => {
  beforeEach(() => {
    observer.callback = undefined;
    observer.disconnect.mockClear();
    observer.observe.mockClear();
    observer.options = undefined;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        observer.callback = callback;
        observer.options = options;
      }

      disconnect = observer.disconnect;
      observe = observer.observe;
      takeRecords = vi.fn(() => []);
      unobserve = vi.fn();
      root = null;
      rootMargin = '';
      thresholds = [];
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('starts visible and observes with a prefetch margin', () => {
    const element = document.createElement('div');

    const { result } = renderHook(() => useViewportVisibility(element));

    expect(result.current).toBe(true);
    expect(observer.observe).toHaveBeenCalledWith(element);
    expect(observer.options).toEqual(expect.objectContaining({
      rootMargin: '200px 0px',
      threshold: 0.01,
    }));
  });

  it('tracks whether the pane intersects the scroll viewport', () => {
    const element = document.createElement('div');
    const { result } = renderHook(() => useViewportVisibility(element));

    act(() => {
      observer.callback?.(
        [{ isIntersecting: false, target: element } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(result.current).toBe(false);

    act(() => {
      observer.callback?.(
        [{ isIntersecting: true, target: element } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(result.current).toBe(true);
  });

  it('stays visible when IntersectionObserver is unavailable', () => {
    vi.unstubAllGlobals();
    const element = document.createElement('div');

    const { result } = renderHook(() => useViewportVisibility(element));

    expect(result.current).toBe(true);
  });
});
