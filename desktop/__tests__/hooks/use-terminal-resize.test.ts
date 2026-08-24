// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import type { MutableRefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalResize } from '../../src/renderer/components/pane-detail/interactive-terminal/useTerminalResize';

const { fitTerminalToContainer, resize } = vi.hoisted(() => ({
  fitTerminalToContainer: vi.fn(),
  resize: vi.fn(),
}));

vi.mock('../../src/renderer/api/terminal.api', () => ({ resize }));
vi.mock('../../src/renderer/lib/terminal-fit', () => ({ fitTerminalToContainer }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe('useTerminalResize', () => {
  const containerRef = {
    current: document.createElement('div'),
  } as MutableRefObject<HTMLDivElement | null>;
  const fitAddonRef = {
    current: {} as FitAddon,
  } as MutableRefObject<FitAddon | null>;
  const terminal = {
    options: { fontSize: 14 },
    refresh: vi.fn(),
    rows: 24,
  } as unknown as Terminal;
  const termRef = { current: terminal } as MutableRefObject<Terminal | null>;

  beforeEach(() => {
    vi.useFakeTimers();
    fitTerminalToContainer.mockReset();
    resize.mockReset();
    fitTerminalToContainer.mockReturnValue({ cols: 100, rows: 30 });
    resize.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces measurements and serializes only the latest queued geometry', async () => {
    const firstResize = deferred<{ success: boolean }>();
    resize.mockReturnValueOnce(firstResize.promise).mockResolvedValue({ success: true });
    const { result } = renderHook(() => useTerminalResize({
      agent: 'claude',
      containerRef,
      fitAddonRef,
      fixedCols: undefined,
      paneCount: 2,
      paneId: 'pane-1',
      preemptPendingScroll: vi.fn(),
      readyRef: { current: true },
      setTerminalFailure: vi.fn(),
      terminalFontSize: 14,
      termRef,
    }));
    vi.clearAllTimers();

    act(() => result.current.requestResize());
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(resize).toHaveBeenCalledWith({ cols: 100, paneId: 'pane-1', rows: 30 });

    fitTerminalToContainer.mockReturnValue({ cols: 120, rows: 40 });
    act(() => result.current.requestResize());
    fitTerminalToContainer.mockReturnValue({ cols: 140, rows: 50 });
    act(() => result.current.requestResize());
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(resize).toHaveBeenCalledTimes(1);

    await act(async () => { firstResize.resolve({ success: true }); });
    expect(resize).toHaveBeenLastCalledWith({ cols: 140, paneId: 'pane-1', rows: 50 });
  });

  it('ignores an obsolete resize response after reset', async () => {
    const pendingResize = deferred<{ success: boolean }>();
    resize.mockReturnValueOnce(pendingResize.promise);
    const setTerminalFailure = vi.fn();
    const { result } = renderHook(() => useTerminalResize({
      agent: undefined,
      containerRef,
      fitAddonRef,
      fixedCols: undefined,
      paneCount: 1,
      paneId: 'pane-1',
      preemptPendingScroll: vi.fn(),
      readyRef: { current: true },
      setTerminalFailure,
      terminalFontSize: 14,
      termRef,
    }));
    vi.clearAllTimers();

    act(() => result.current.requestResize());
    await act(() => vi.advanceTimersByTimeAsync(150));
    act(() => result.current.reset());
    await act(async () => { pendingResize.resolve({ success: true }); });

    expect(setTerminalFailure).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'resize' }));
    expect(resize).toHaveBeenCalledOnce();
  });
});
