// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import type { SearchAddon } from '@xterm/addon-search';
import type { MutableRefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalFind } from '../../src/renderer/components/pane-detail/interactive-terminal/useTerminalFind';

describe('useTerminalFind', () => {
  const addon = {
    clearDecorations: vi.fn(),
    findNext: vi.fn(),
    findPrevious: vi.fn(),
  };
  const searchAddonRef = {
    current: addon as unknown as SearchAddon,
  } as MutableRefObject<SearchAddon | null>;

  beforeEach(() => {
    addon.clearDecorations.mockClear();
    addon.findNext.mockClear();
    addon.findPrevious.mockClear();
    document.documentElement.style.setProperty('--accent', '#123456');
  });

  afterEach(() => {
    document.documentElement.style.removeProperty('--accent');
    vi.unstubAllGlobals();
  });

  it('searches with the live accent and current case preference', () => {
    const { result } = renderHook(() => useTerminalFind({
      activeMatchBorder: '#ffffff',
      blurTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      searchAddonRef,
    }));

    act(() => result.current.open());
    act(() => result.current.setQuery('needle'));

    expect(addon.findNext).toHaveBeenCalledWith('needle', {
      caseSensitive: false,
      decorations: {
        activeMatchBackground: '#123456',
        activeMatchBorder: '#ffffff',
        activeMatchColorOverviewRuler: '#123456',
        matchBackground: '#123456',
        matchBorder: '#123456',
        matchOverviewRuler: '#123456',
      },
    });

    act(() => result.current.toggleCaseSensitive());
    expect(addon.findNext).toHaveBeenLastCalledWith(
      'needle',
      expect.objectContaining({ caseSensitive: true }),
    );
    act(() => result.current.runFind('prev'));
    expect(addon.findPrevious).toHaveBeenCalled();
  });

  it('normalizes addon result indexes and clears state when closed', () => {
    const focusTerminal = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const { result } = renderHook(() => useTerminalFind({
      activeMatchBorder: '#ffffff',
      blurTerminal: vi.fn(),
      focusTerminal,
      searchAddonRef,
    }));

    act(() => result.current.open());
    act(() => result.current.onResultsChanged({ resultCount: 4, resultIndex: 2 }));
    expect(result.current.result).toEqual({ count: 4, index: 3 });

    act(() => result.current.close());
    expect(result.current.opened).toBe(false);
    expect(result.current.query).toBe('');
    expect(result.current.result).toEqual({ count: 0, index: 0 });
    expect(addon.clearDecorations).toHaveBeenCalled();
    expect(focusTerminal).toHaveBeenCalled();
  });
});
