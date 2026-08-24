// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC, IPC_EVENT } from '../src/shared/ipc-channels';
import type { AppBootState } from '../src/shared/ipc-types';
import { useAppBootState } from '../src/renderer/hooks/useAppBootState';

const ipcMock = vi.hoisted(() => {
  let bootListener: ((state: AppBootState) => void) | null = null;
  return {
    emit(state: AppBootState) {
      bootListener?.(state);
    },
    invoke: vi.fn<() => Promise<AppBootState>>(),
    on: vi.fn((_channel: string, callback: (state: AppBootState) => void) => {
      bootListener = callback;
      return () => {
        bootListener = null;
      };
    }),
    reset() {
      bootListener = null;
    },
  };
});

vi.mock('../src/renderer/api/ipc', () => ({
  invoke: ipcMock.invoke,
  on: ipcMock.on,
}));

describe('useAppBootState', () => {
  beforeEach(() => {
    ipcMock.invoke.mockReset();
    ipcMock.on.mockClear();
    ipcMock.reset();
  });

  afterEach(() => {
    cleanup();
  });

  it('subscribes before reading the current state', () => {
    ipcMock.invoke.mockResolvedValue({ phase: 'starting', revision: 0 });

    renderHook(() => useAppBootState());

    expect(ipcMock.on).toHaveBeenCalledWith(
      IPC_EVENT.APP_BOOT_STATE_CHANGED,
      expect.any(Function),
    );
    expect(ipcMock.invoke).toHaveBeenCalledWith(IPC.APP_BOOT_STATE_GET);
    expect(ipcMock.on.mock.invocationCallOrder[0]).toBeLessThan(
      ipcMock.invoke.mock.invocationCallOrder[0],
    );
  });

  it('does not let a stale getter response overwrite a newer event', async () => {
    let resolveSnapshot: ((state: AppBootState) => void) | undefined;
    ipcMock.invoke.mockReturnValue(new Promise((resolve) => {
      resolveSnapshot = resolve;
    }));
    const { result } = renderHook(() => useAppBootState());

    act(() => {
      ipcMock.emit({ phase: 'ready', revision: 1 });
    });
    await act(async () => {
      resolveSnapshot?.({ phase: 'starting', revision: 0 });
      await Promise.resolve();
    });

    expect(result.current).toEqual({ phase: 'ready', revision: 1 });
  });

  it('exposes a failed state when the boot snapshot cannot be read', async () => {
    ipcMock.invoke.mockRejectedValue(new Error('IPC unavailable'));

    const { result } = renderHook(() => useAppBootState());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current).toEqual({
      message: 'Unable to read application startup state.',
      phase: 'failed',
      revision: 1,
    });
  });

  it('does not replace an observed terminal event when the getter later fails', async () => {
    let rejectSnapshot: ((error: Error) => void) | undefined;
    ipcMock.invoke.mockReturnValue(new Promise((_resolve, reject) => {
      rejectSnapshot = reject;
    }));
    const { result } = renderHook(() => useAppBootState());

    act(() => {
      ipcMock.emit({ phase: 'ready', revision: 1 });
    });
    await act(async () => {
      rejectSnapshot?.(new Error('IPC unavailable'));
      await Promise.resolve();
    });

    expect(result.current).toEqual({ phase: 'ready', revision: 1 });
  });
});
