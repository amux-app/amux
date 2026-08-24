// @vitest-environment happy-dom
import { act, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TypewriterText } from '../../src/renderer/components/shared/TypewriterText';

const pendingFrames = new Map<number, FrameRequestCallback>();
let nextHandle = 1;
let clock = 0;

function advance(ms: number): void {
  clock += ms;
  const due = [...pendingFrames.values()];
  pendingFrames.clear();
  act(() => {
    for (const frame of due) frame(clock);
  });
}

function setReducedMotion(matches: boolean): void {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches } as unknown as MediaQueryList);
}

function caretOf(container: HTMLElement): Element | null {
  return container.querySelector('[aria-hidden="true"]');
}

beforeEach(() => {
  pendingFrames.clear();
  nextHandle = 1;
  clock = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const handle = nextHandle++;
    pendingFrames.set(handle, callback);
    return handle;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    pendingFrames.delete(handle);
  });
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  setReducedMotion(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TypewriterText', () => {
  it('renders the initial text instantly without scheduling an animation', () => {
    // Arrange + Act
    const { container } = render(<TypewriterText text="alpha task" />);

    // Assert
    expect(container.textContent).toBe('alpha task');
    expect(pendingFrames.size).toBe(0);
    expect(caretOf(container)).toBeNull();
  });

  it('types the changed suffix and settles on the exact final text', () => {
    // Arrange
    const { container, rerender } = render(<TypewriterText text="alpha task" />);

    // Act
    act(() => rerender(<TypewriterText text="alpha rename" />));
    advance(100);
    const midway = container.textContent;
    const midwayCaret = caretOf(container);
    advance(400);

    // Assert
    expect(midway).toBe('alpha re');
    expect(midwayCaret).not.toBeNull();
    expect(container.textContent).toBe('alpha rename');
    expect(caretOf(container)).toBeNull();
    expect(pendingFrames.size).toBe(0);
  });

  it('swaps instantly and shows no caret when reduced motion is preferred', () => {
    // Arrange
    const { container, rerender } = render(<TypewriterText text="alpha task" />);
    setReducedMotion(true);

    // Act
    act(() => rerender(<TypewriterText text="beta rename" />));

    // Assert
    expect(container.textContent).toBe('beta rename');
    expect(pendingFrames.size).toBe(0);
    expect(caretOf(container)).toBeNull();
  });

  it('cancels the pending frame when unmounted mid-animation', () => {
    // Arrange
    const { rerender, unmount } = render(<TypewriterText text="alpha task" />);
    act(() => rerender(<TypewriterText text="alpha rename" />));
    expect(pendingFrames.size).toBe(1);

    // Act
    unmount();

    // Assert
    expect(pendingFrames.size).toBe(0);
  });
});
