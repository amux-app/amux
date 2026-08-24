// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTerminalBoot } from '../../src/renderer/components/pane-detail/interactive-terminal/useTerminalBoot';

describe('useTerminalBoot', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for the minimum boot floor before completing ready output', () => {
    vi.useFakeTimers();
    const unlockInput = vi.fn();
    const { result } = renderHook(() => useTerminalBoot({
      activityIdle: false,
      agent: 'claude',
      initialBooting: true,
      lockInput: vi.fn(),
      sessionWaiting: false,
      terminalFailure: false,
      unlockInput,
    }));

    act(() => result.current.onTerminalOutput('Claude Code v2.1 ready'));
    act(() => vi.advanceTimersByTime(199));
    expect(result.current.booting).toBe(true);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.booting).toBe(false);
    expect(unlockInput).toHaveBeenCalledOnce();
  });

  it('pauses for a trailing trust prompt and restarts after submitted input', () => {
    vi.useFakeTimers();
    const lockInput = vi.fn();
    const unlockInput = vi.fn();
    const { result } = renderHook(() => useTerminalBoot({
      activityIdle: false,
      agent: 'claude',
      initialBooting: true,
      lockInput,
      sessionWaiting: false,
      terminalFailure: false,
      unlockInput,
    }));

    act(() => result.current.onTerminalOutput('Enter to confirm · Esc to cancel'));
    expect(result.current.booting).toBe(false);
    expect(unlockInput).toHaveBeenCalledOnce();

    act(() => result.current.onTerminalInput('\r'));
    expect(result.current.booting).toBe(true);
    expect(lockInput).toHaveBeenCalledOnce();
  });

  it('unlocks at the soft timeout and completes at the hard timeout', () => {
    vi.useFakeTimers();
    const unlockInput = vi.fn();
    const { result } = renderHook(() => useTerminalBoot({
      activityIdle: false,
      agent: 'opencode',
      initialBooting: true,
      lockInput: vi.fn(),
      sessionWaiting: false,
      terminalFailure: false,
      unlockInput,
    }));

    act(() => vi.advanceTimersByTime(15_000));
    expect(result.current.booting).toBe(true);
    expect(unlockInput).toHaveBeenCalledOnce();

    act(() => vi.advanceTimersByTime(30_000));
    expect(result.current.booting).toBe(false);
    expect(unlockInput).toHaveBeenCalledTimes(2);
  });

  it('uses session waiting before idle activity and can reset for a fresh session', () => {
    const unlockInput = vi.fn();
    const { result, rerender } = renderHook(
      ({ activityIdle, sessionWaiting }) => useTerminalBoot({
        activityIdle,
        agent: 'claude',
        initialBooting: true,
        lockInput: vi.fn(),
        sessionWaiting,
        terminalFailure: false,
        unlockInput,
      }),
      { initialProps: { activityIdle: true, sessionWaiting: true } },
    );

    expect(result.current.booting).toBe(false);
    rerender({ activityIdle: false, sessionWaiting: false });
    expect(result.current.booting).toBe(false);

    act(() => result.current.reset(true));
    expect(result.current.booting).toBe(true);
    expect(result.current.bootPhase).toBe(0);
  });

  it('preserves an already-waiting session when the terminal lifecycle resets', () => {
    const lockInput = vi.fn();
    const unlockInput = vi.fn();
    const { result } = renderHook(() => useTerminalBoot({
      activityIdle: false,
      agent: 'claude',
      initialBooting: true,
      lockInput,
      sessionWaiting: true,
      terminalFailure: false,
      unlockInput,
    }));

    expect(result.current.booting).toBe(false);

    act(() => result.current.reset(true));
    expect(result.current.booting).toBe(false);

    act(() => result.current.onTerminalInput('\r'));
    expect(result.current.booting).toBe(true);
    expect(lockInput).toHaveBeenCalledOnce();
  });

  it('restarts phase and timeout schedules when the terminal lifecycle resets', () => {
    vi.useFakeTimers();
    const unlockInput = vi.fn();
    const { result } = renderHook(() => useTerminalBoot({
      activityIdle: false,
      agent: 'opencode',
      initialBooting: true,
      lockInput: vi.fn(),
      sessionWaiting: false,
      terminalFailure: false,
      unlockInput,
    }));

    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current.bootPhase).toBe(2);

    act(() => result.current.reset(true));
    expect(result.current.bootPhase).toBe(0);

    act(() => vi.advanceTimersByTime(1_499));
    expect(result.current.bootPhase).toBe(0);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.bootPhase).toBe(1);
    act(() => vi.advanceTimersByTime(2_500));
    expect(result.current.bootPhase).toBe(2);

    act(() => vi.advanceTimersByTime(10_999));
    expect(unlockInput).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(unlockInput).toHaveBeenCalledOnce();
    expect(result.current.bootPhase).toBe(3);

    act(() => vi.advanceTimersByTime(29_999));
    expect(result.current.booting).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.booting).toBe(false);
    expect(unlockInput).toHaveBeenCalledTimes(2);
  });
});
