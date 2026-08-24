// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const ipcSpies = vi.hoisted(() => {
  const unsubscribe = vi.fn();
  return {
    unsubscribe,
    on: vi.fn(() => unsubscribe),
    handlers: new Map<string, (...args: unknown[]) => void>(),
  };
});

vi.mock('../../src/renderer/api/ipc', () => ({
  on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
    ipcSpies.handlers.set(channel, handler);
    return ipcSpies.on(channel, handler);
  }),
}));

const rendererLogSpies = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock('../../src/renderer/lib/rendererLog', () => ({
  rendererLog: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: rendererLogSpies.error,
  },
}));

import { useIpcListener } from '../../src/renderer/hooks/useIpcListener';

describe('useIpcListener', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcSpies.handlers.clear();
  });

  it('subscribes to the channel on mount', () => {
    // Arrange
    const callback = vi.fn();

    // Act
    renderHook(() => useIpcListener('terminal:data', callback));

    // Assert
    expect(ipcSpies.on).toHaveBeenCalledWith('terminal:data', expect.any(Function));
  });

  it('unsubscribes when the component unmounts', () => {
    // Arrange
    const callback = vi.fn();
    const { unmount } = renderHook(() => useIpcListener('terminal:data', callback));

    // Act
    unmount();

    // Assert
    expect(ipcSpies.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('forwards event arguments to the consumer callback', () => {
    // Arrange
    const callback = vi.fn();
    renderHook(() => useIpcListener('terminal:data', callback));

    // Act — invoke the handler the hook registered with the IPC layer
    ipcSpies.handlers.get('terminal:data')?.({ paneId: 'p1' }, 'extra');

    // Assert
    expect(callback).toHaveBeenCalledWith({ paneId: 'p1' }, 'extra');
  });

  it('catches errors thrown by the consumer callback and logs them instead of crashing', () => {
    // Arrange
    const callback = vi.fn(() => {
      throw new Error('listener boom');
    });
    renderHook(() => useIpcListener('terminal:data', callback));

    // Act + Assert — the thrown error must not escape the handler
    expect(() => ipcSpies.handlers.get('terminal:data')?.('payload')).not.toThrow();
    expect(rendererLogSpies.error).toHaveBeenCalledWith(
      'ipc',
      'Listener failed',
      expect.objectContaining({ channel: 'terminal:data' }),
    );
  });

  it('re-subscribes when the channel changes', () => {
    // Arrange
    const callback = vi.fn();
    const { rerender } = renderHook(
      ({ channel }: { channel: string }) => useIpcListener(channel, callback),
      { initialProps: { channel: 'channel:a' } },
    );

    // Act
    rerender({ channel: 'channel:b' });

    // Assert — old subscription torn down, new one created
    expect(ipcSpies.unsubscribe).toHaveBeenCalledTimes(1);
    expect(ipcSpies.on).toHaveBeenCalledWith('channel:b', expect.any(Function));
  });
});
