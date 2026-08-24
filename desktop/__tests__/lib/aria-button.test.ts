import { describe, expect, it, vi } from 'vitest';
import type { KeyboardEvent } from 'react';
import { activateOnEnterOrSpace } from '../../src/renderer/lib/aria-button';

function makeKeyboardEvent(key: string): KeyboardEvent {
  const preventDefault = vi.fn();
  return { key, preventDefault } as unknown as KeyboardEvent;
}

describe('activateOnEnterOrSpace', () => {
  it('invokes the activator and prevents default on Enter', () => {
    // Arrange
    const activate = vi.fn();
    const handler = activateOnEnterOrSpace(activate);
    const event = makeKeyboardEvent('Enter');

    // Act
    handler(event);

    // Assert
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('invokes the activator and prevents default on Space', () => {
    // Arrange
    const activate = vi.fn();
    const handler = activateOnEnterOrSpace(activate);
    const event = makeKeyboardEvent(' ');

    // Act
    handler(event);

    // Assert
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('does nothing for other keys (Tab/Escape/letters)', () => {
    // Arrange
    const activate = vi.fn();
    const handler = activateOnEnterOrSpace(activate);
    const events = ['Tab', 'Escape', 'a', 'ArrowDown'].map(makeKeyboardEvent);

    // Act
    events.forEach(handler);

    // Assert
    expect(activate).not.toHaveBeenCalled();
    events.forEach((e) => expect(e.preventDefault).not.toHaveBeenCalled());
  });
});
