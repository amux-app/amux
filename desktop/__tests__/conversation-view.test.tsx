// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConversationView } from '../src/renderer/components/agent-devtools/ConversationView';
import type { NormalizedMessage, NormalizedSession } from '../src/shared/agent-session-types';
import { createEmptySession } from '../src/shared/agent-session-types';

vi.mock('../src/renderer/api/system.api', () => ({
  clipboardWrite: vi.fn(),
}));

function makeMessage(index: number): NormalizedMessage {
  return {
    content: `Conversation message ${index}`,
    id: `message-${index}`,
    timestamp: 1_000 + index,
    toolCalls: [],
    toolResults: [],
    type: index % 2 === 0 ? 'assistant' : 'user',
  };
}

function makeSession(messageCount: number): NormalizedSession {
  const session = createEmptySession('codex', 'session-1');
  session.messages = Array.from({ length: messageCount }, (_, index) => makeMessage(index + 1));
  session.metrics.messageCount = session.messages.length;
  return session;
}

let scrollToDescriptor: PropertyDescriptor | undefined;
let clientHeightDescriptor: PropertyDescriptor | undefined;
let scrollHeightDescriptor: PropertyDescriptor | undefined;

describe('ConversationView', () => {
  beforeAll(() => {
    clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    scrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value(this: HTMLElement, options?: ScrollToOptions | number, y?: number) {
        this.scrollTop = typeof options === 'number' ? y ?? 0 : options?.top ?? 0;
      },
    });
  });

  afterEach(() => {
    cleanup();
    restorePrototypeProperty('clientHeight', clientHeightDescriptor);
    restorePrototypeProperty('scrollHeight', scrollHeightDescriptor);
  });

  afterAll(() => {
    if (scrollToDescriptor) {
      Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollToDescriptor);
      return;
    }
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  });

  it('renders the full conversation so users can scroll back to the first message', () => {
    // Arrange
    const session = makeSession(151);

    // Act
    render(<ConversationView session={session} paneId="pane-1" />);

    // Assert
    expect(screen.getByText('Conversation message 1')).toBeTruthy();
    expect(screen.getByText('Conversation message 151')).toBeTruthy();
    expect(screen.queryByText(/Show 1 earlier messages/i)).toBeNull();
  });

  it('pins a newly opened conversation to the latest message', () => {
    // Arrange
    const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });

    try {
      // Act
      render(<ConversationView session={makeSession(151)} paneId="pane-1" />);

      // Assert
      expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'end' }));
    } finally {
      restorePrototypeProperty('scrollIntoView', scrollIntoViewDescriptor);
    }
  });

  it('keeps pinned when visible messages append without a timestamp update', () => {
    // Arrange
    const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });

    try {
      const { rerender } = render(<ConversationView session={makeSession(2)} paneId="pane-1" />);
      const initialCallCount = scrollIntoView.mock.calls.length;

      // Act
      rerender(<ConversationView session={makeSession(3)} paneId="pane-1" />);

      // Assert
      expect(scrollIntoView.mock.calls.length).toBeGreaterThan(initialCallCount);
    } finally {
      restorePrototypeProperty('scrollIntoView', scrollIntoViewDescriptor);
    }
  });

  it('keeps pinned when rendered content reflows in place', () => {
    // Arrange
    const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
    const scrollIntoView = vi.fn();
    let resizeCallback: ResizeObserverCallback | null = null;
    let resizeObserver: ResizeObserver | null = null;
    class TestResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        resizeObserver = this;
      }

      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    }
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: TestResizeObserver });

    try {
      render(<ConversationView session={makeSession(2)} paneId="pane-1" />);
      const initialCallCount = scrollIntoView.mock.calls.length;

      // Act
      act(() => {
        resizeCallback?.([] as ResizeObserverEntry[], resizeObserver!);
      });

      // Assert
      expect(scrollIntoView.mock.calls.length).toBeGreaterThan(initialCallCount);
    } finally {
      restorePrototypeProperty('scrollIntoView', scrollIntoViewDescriptor);
      restoreGlobalProperty('ResizeObserver', resizeObserverDescriptor);
    }
  });

  it('does not force-scroll new messages after upward scroll intent', () => {
    // Arrange
    const { rerender } = render(<ConversationView session={makeSession(2)} paneId="pane-1" />);
    const log = screen.getByRole('log');
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 200 });
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1_000 });
    log.scrollTop = 500;

    // Act
    fireEvent.wheel(log, { deltaY: -120 });
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1_400 });
    rerender(<ConversationView session={makeSession(3)} paneId="pane-1" />);

    // Assert
    expect(log.scrollTop).toBe(500);
  });

  it('does not re-enable auto-scroll from a programmatic scroll event after upward scroll intent', () => {
    // Arrange
    const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });

    try {
      const { rerender } = render(<ConversationView session={makeSession(2)} paneId="pane-1" />);
      const log = screen.getByRole('log');
      Object.defineProperty(log, 'clientHeight', { configurable: true, value: 200 });
      Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1_000 });
      log.scrollTop = 500;
      fireEvent.wheel(log, { deltaY: -120 });
      log.scrollTop = 800;
      fireEvent.scroll(log);
      const callCountBeforeAppend = scrollIntoView.mock.calls.length;

      // Act
      Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1_400 });
      rerender(<ConversationView session={makeSession(3)} paneId="pane-1" />);

      // Assert
      expect(scrollIntoView.mock.calls.length).toBe(callCountBeforeAppend);
    } finally {
      restorePrototypeProperty('scrollIntoView', scrollIntoViewDescriptor);
    }
  });

  it('does not re-enable auto-scroll from a near-bottom upward wheel event', () => {
    // Arrange
    vi.useFakeTimers();
    const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });

    try {
      const { rerender } = render(<ConversationView session={makeSession(2)} paneId="pane-1" />);
      const log = screen.getByRole('log');
      Object.defineProperty(log, 'clientHeight', { configurable: true, value: 200 });
      Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1_000 });
      log.scrollTop = 800;
      const callCountBeforeUserScroll = scrollIntoView.mock.calls.length;
      act(() => {
        vi.advanceTimersByTime(250);
      });

      // Act
      fireEvent.wheel(log, { deltaY: -20 });
      log.scrollTop = 790;
      fireEvent.scroll(log);
      Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1_400 });
      rerender(<ConversationView session={makeSession(3)} paneId="pane-1" />);

      // Assert
      expect(scrollIntoView.mock.calls.length).toBe(callCountBeforeUserScroll);
    } finally {
      restorePrototypeProperty('scrollIntoView', scrollIntoViewDescriptor);
      vi.useRealTimers();
    }
  });

  it('attaches compaction markers to the original message after hidden messages are filtered', () => {
    // Arrange
    const session = makeSession(3);
    session.messages[1] = { ...session.messages[1], content: '' };
    session.compactionEvents = [{
      tokensAfter: 5_000,
      tokensBefore: 20_000,
      turnIndex: 2,
    }];

    // Act
    render(<ConversationView session={session} paneId="pane-1" />);
    const marker = screen.getByText(/Context compacted/i);

    // Assert
    expect(marker.closest('[data-msg-id]')?.getAttribute('data-msg-id')).toBe('message-3');
  });
});

function restorePrototypeProperty(key: keyof HTMLElement, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(HTMLElement.prototype, key, descriptor);
    return;
  }
  Reflect.deleteProperty(HTMLElement.prototype, key);
}

function restoreGlobalProperty(key: keyof typeof globalThis, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(globalThis, key, descriptor);
    return;
  }
  Reflect.deleteProperty(globalThis, key);
}
