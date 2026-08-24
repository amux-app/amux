// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDelayedTerminalVisibility } from '../../src/renderer/components/pane-detail/interactive-terminal/useDelayedTerminalVisibility';

describe('useDelayedTerminalVisibility', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a hidden terminal effective until the grace period expires', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ visible }) => useDelayedTerminalVisibility(visible, 2_500),
      { initialProps: { visible: true } },
    );

    rerender({ visible: false });
    act(() => vi.advanceTimersByTime(2_499));
    expect(result.current).toBe(true);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(false);
  });

  it('cancels a pending hide when the terminal becomes visible again', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ visible }) => useDelayedTerminalVisibility(visible, 2_500),
      { initialProps: { visible: true } },
    );

    rerender({ visible: false });
    act(() => vi.advanceTimersByTime(1_000));
    rerender({ visible: true });
    act(() => vi.advanceTimersByTime(5_000));

    expect(result.current).toBe(true);
  });
});
