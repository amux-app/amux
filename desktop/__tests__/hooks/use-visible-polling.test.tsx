// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVisiblePolling } from '../../src/renderer/hooks/useVisiblePolling';

const INTERVAL_MS = 1000;

function setVisibility(state: 'hidden' | 'visible'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

function Poller({ onPoll, enabled = true }: Readonly<{ onPoll: () => void; enabled?: boolean }>) {
  useVisiblePolling(onPoll, INTERVAL_MS, enabled);
  return null;
}

describe('useVisiblePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('polls on the interval while the document is visible', () => {
    // Arrange
    const onPoll = vi.fn();
    render(<Poller onPoll={onPoll} />);

    // Act
    vi.advanceTimersByTime(INTERVAL_MS * 3);

    // Assert
    expect(onPoll).toHaveBeenCalledTimes(3);
  });

  it('stops polling while the document is hidden', () => {
    // Arrange
    const onPoll = vi.fn();
    render(<Poller onPoll={onPoll} />);
    vi.advanceTimersByTime(INTERVAL_MS);
    onPoll.mockClear();

    // Act
    setVisibility('hidden');
    vi.advanceTimersByTime(INTERVAL_MS * 5);

    // Assert
    expect(onPoll).not.toHaveBeenCalled();
  });

  it('refreshes immediately when the document becomes visible again', () => {
    // Arrange
    const onPoll = vi.fn();
    render(<Poller onPoll={onPoll} />);
    setVisibility('hidden');
    vi.advanceTimersByTime(INTERVAL_MS * 5);
    onPoll.mockClear();

    // Act
    setVisibility('visible');

    // Assert: no timer wait — the refresh fires on the transition itself.
    expect(onPoll).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(onPoll).toHaveBeenCalledTimes(2);
  });

  it('never starts a timer while disabled', () => {
    // Arrange
    const onPoll = vi.fn();
    render(<Poller onPoll={onPoll} enabled={false} />);

    // Act
    vi.advanceTimersByTime(INTERVAL_MS * 4);
    setVisibility('visible');

    // Assert
    expect(onPoll).not.toHaveBeenCalled();
  });

  it('clears the interval on unmount', () => {
    // Arrange
    const onPoll = vi.fn();
    const view = render(<Poller onPoll={onPoll} />);

    // Act
    view.unmount();
    vi.advanceTimersByTime(INTERVAL_MS * 4);

    // Assert
    expect(onPoll).not.toHaveBeenCalled();
  });
});
