// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoverTooltip } from '../src/renderer/components/shared/HoverTooltip';

const LABEL = 'Close pane';
const DWELL_MS = 400;

function tooltip(): HTMLElement | null {
  return screen.queryByRole('tooltip');
}

// The tooltip closes on a grace delay so the pointer can travel onto it.
function flushClose() {
  act(() => {
    vi.runAllTimers();
  });
}

function renderTrigger(children: React.ReactNode, props: { enabled?: boolean; suppressed?: boolean } = {}) {
  const view = render(
    <HoverTooltip label={LABEL} {...props}>
      {children}
    </HoverTooltip>,
  );
  const wrapper = view.container.firstElementChild as HTMLElement;
  return { ...view, wrapper };
}

function renderButtonTrigger(buttonProps: React.ComponentProps<'button'> = {}) {
  const result = renderTrigger(
    <button type="button" {...buttonProps}>
      Go
    </button>,
  );
  return { ...result, button: screen.getByRole('button') };
}

function setOverflow(el: HTMLElement, scrollWidth: number, clientWidth: number) {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth });
}

describe('HoverTooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('pointer', () => {
    it('opens on hover and closes when the pointer leaves', () => {
      // Arrange
      const { wrapper } = renderButtonTrigger();

      // Act
      fireEvent.mouseEnter(wrapper);

      // Assert
      expect(tooltip()?.textContent).toBe(LABEL);
      fireEvent.mouseLeave(wrapper);
      flushClose();
      expect(tooltip()).toBeNull();
    });

    it('stays open while the tooltip itself is hovered', () => {
      // Arrange
      const { wrapper } = renderButtonTrigger();
      fireEvent.mouseEnter(wrapper);
      const tip = tooltip()!;

      // Act
      fireEvent.mouseEnter(tip);
      fireEvent.mouseLeave(wrapper);
      flushClose();

      // Assert
      expect(tooltip()).not.toBeNull();
      fireEvent.mouseLeave(tip);
      flushClose();
      expect(tooltip()).toBeNull();
    });

    it('leaves the tooltip hit-testable so the pointer can actually reach it', () => {
      // Arrange
      const { wrapper } = renderButtonTrigger();

      // Act
      fireEvent.mouseEnter(wrapper);

      // Assert
      expect(tooltip()!.className).not.toContain('pointer-events-none');
      expect(tooltip()!.style.pointerEvents).not.toBe('none');
    });

    it('dismisses itself on a press so it stops covering what is under the trigger', () => {
      // Arrange
      const { wrapper } = renderButtonTrigger();
      fireEvent.mouseEnter(wrapper);
      const tip = tooltip()!;
      fireEvent.mouseEnter(tip);
      fireEvent.mouseLeave(wrapper);
      expect(tooltip()).not.toBeNull();

      // Act
      fireEvent.pointerDown(tip);

      // Assert
      expect(tooltip()).toBeNull();
      flushClose();
      expect(tooltip()).toBeNull();

      // Act — the pointer goes back to the trigger.
      fireEvent.mouseEnter(wrapper);

      // Assert
      expect(tooltip()?.textContent).toBe(LABEL);
    });

    it('cancels a pending close when the pointer returns', () => {
      // Arrange
      const { wrapper } = renderButtonTrigger();
      fireEvent.mouseEnter(wrapper);
      const id = tooltip()!.id;

      // Act
      fireEvent.mouseLeave(wrapper);
      fireEvent.mouseEnter(wrapper);
      flushClose();

      // Assert
      expect(tooltip()?.id).toBe(id);
    });
  });

  describe('openDelayMs dwell', () => {
    function renderDelayedTrigger() {
      const view = render(
        <HoverTooltip label={LABEL} openDelayMs={DWELL_MS}>
          <button type="button">Go</button>
        </HoverTooltip>,
      );
      return view.container.firstElementChild as HTMLElement;
    }

    function advance(ms: number) {
      act(() => {
        vi.advanceTimersByTime(ms);
      });
    }

    it('stays closed until the dwell elapses', () => {
      // Arrange
      const wrapper = renderDelayedTrigger();

      // Act
      fireEvent.mouseEnter(wrapper);
      advance(DWELL_MS - 1);
      const early = tooltip();
      advance(1);

      // Assert
      expect(early).toBeNull();
      expect(tooltip()).not.toBeNull();
    });

    it('restarts the dwell when the pointer skims off and back before it elapses', () => {
      // Arrange — leaving mid-dwell must not leave a close timer that fakes "already open"
      const wrapper = renderDelayedTrigger();

      // Act
      fireEvent.mouseEnter(wrapper);
      advance(200);
      fireEvent.mouseLeave(wrapper);
      advance(50);
      fireEvent.mouseEnter(wrapper);
      advance(200);

      // Assert — 200ms into the second dwell, so still closed
      expect(tooltip()).toBeNull();
      advance(DWELL_MS - 200);
      expect(tooltip()).not.toBeNull();
    });

    it('opens on focus with no dwell, unlike a pointer hover', () => {
      // Arrange
      renderDelayedTrigger();
      const button = screen.getByRole('button');

      // Act
      fireEvent.focusIn(button);

      // Assert
      expect(tooltip()?.textContent).toBe(LABEL);
    });
  });

  describe('keyboard focus', () => {
    it('opens on focus and closes on blur', () => {
      // Arrange
      const { button } = renderButtonTrigger();

      // Act
      fireEvent.focusIn(button);

      // Assert
      expect(tooltip()?.textContent).toBe(LABEL);
      fireEvent.focusOut(button, { relatedTarget: document.body });
      flushClose();
      expect(tooltip()).toBeNull();
    });

    it('stays open when focus moves between children inside the trigger', () => {
      // Arrange
      const { wrapper } = renderTrigger(
        <>
          <button type="button">One</button>
          <button type="button">Two</button>
        </>,
      );
      const [first, second] = Array.from(wrapper.querySelectorAll('button'));
      fireEvent.focusIn(first);

      // Act
      fireEvent.focusOut(first, { relatedTarget: second });
      fireEvent.focusIn(second);
      flushClose();

      // Assert
      expect(tooltip()).not.toBeNull();
    });

    it('keeps a focus-opened tooltip open across a hover in and out', () => {
      // Arrange
      const { button, wrapper } = renderButtonTrigger();
      fireEvent.focusIn(button);

      // Act
      fireEvent.mouseEnter(wrapper);
      fireEvent.mouseLeave(wrapper);
      flushClose();

      // Assert
      expect(tooltip()).not.toBeNull();
      fireEvent.focusOut(button, { relatedTarget: document.body });
      flushClose();
      expect(tooltip()).toBeNull();
    });

    it('does not pin the tooltip open when focus arrives from a pointer press', () => {
      // Arrange
      const { button, wrapper } = renderButtonTrigger();

      // Act
      fireEvent.mouseEnter(wrapper);
      fireEvent.focusIn(button);
      fireEvent.mouseLeave(wrapper);
      flushClose();

      // Assert
      expect(tooltip()).toBeNull();
    });
  });

  describe('escape', () => {
    it('closes the tooltip without running the trigger action or ancestor handlers', () => {
      // Arrange
      const onClick = vi.fn();
      const onKeyDown = vi.fn();
      const ancestorKeyDown = vi.fn();
      const windowKeyDown = vi.fn();
      window.addEventListener('keydown', windowKeyDown);
      const { container } = render(
        <div onKeyDown={ancestorKeyDown}>
          <HoverTooltip label={LABEL}>
            <button type="button" onClick={onClick} onKeyDown={onKeyDown}>
              Go
            </button>
          </HoverTooltip>
        </div>,
      );
      const button = screen.getByRole('button');
      fireEvent.focusIn(button);

      // Act
      fireEvent.keyDown(button, { key: 'Escape' });

      // Assert
      expect(tooltip()).toBeNull();
      expect(onClick).not.toHaveBeenCalled();
      expect(onKeyDown).not.toHaveBeenCalled();
      expect(ancestorKeyDown).not.toHaveBeenCalled();
      expect(windowKeyDown).not.toHaveBeenCalled();
      expect(container.contains(button)).toBe(true);
      window.removeEventListener('keydown', windowKeyDown);
    });

    it('does not swallow Escape when no tooltip is open', () => {
      // Arrange
      const onKeyDown = vi.fn();
      const documentKeyDown = vi.fn();
      const windowKeyDown = vi.fn();
      document.addEventListener('keydown', documentKeyDown);
      window.addEventListener('keydown', windowKeyDown);
      renderButtonTrigger({ onKeyDown });
      const button = screen.getByRole('button');

      // Act
      fireEvent.keyDown(button, { key: 'Escape' });

      // Assert
      expect(onKeyDown).toHaveBeenCalledTimes(1);
      expect(documentKeyDown).toHaveBeenCalledTimes(1);
      expect(windowKeyDown).toHaveBeenCalledTimes(1);
      document.removeEventListener('keydown', documentKeyDown);
      window.removeEventListener('keydown', windowKeyDown);
    });

    it('lets other keys through while the tooltip is open', () => {
      // Arrange
      const onKeyDown = vi.fn();
      const windowKeyDown = vi.fn();
      window.addEventListener('keydown', windowKeyDown);
      const { button } = renderButtonTrigger({ onKeyDown });
      fireEvent.focusIn(button);

      // Act
      fireEvent.keyDown(button, { key: 'Enter' });

      // Assert
      expect(onKeyDown).toHaveBeenCalledTimes(1);
      expect(windowKeyDown).toHaveBeenCalledTimes(1);
      expect(tooltip()).not.toBeNull();
      window.removeEventListener('keydown', windowKeyDown);
    });

    it('reopens only after the trigger loses hover and focus', () => {
      // Arrange
      const { button, wrapper } = renderButtonTrigger();
      fireEvent.focusIn(button);
      fireEvent.keyDown(button, { key: 'Escape' });

      // Act
      fireEvent.mouseEnter(wrapper);

      // Assert
      expect(tooltip()).toBeNull();
      fireEvent.mouseLeave(wrapper);
      fireEvent.focusOut(button, { relatedTarget: document.body });
      fireEvent.focusIn(button);
      expect(tooltip()).not.toBeNull();
    });
  });

  describe('aria-describedby', () => {
    it('describes the focusable trigger only while the tooltip is on screen', () => {
      // Arrange
      const { button, wrapper } = renderButtonTrigger();

      // Act
      fireEvent.mouseEnter(wrapper);

      // Assert
      expect(button.getAttribute('aria-describedby')).toBe(tooltip()!.id);
      fireEvent.mouseLeave(wrapper);
      flushClose();
      expect(button.hasAttribute('aria-describedby')).toBe(false);
    });

    it('composes with a caller-provided aria-describedby and restores it on close', () => {
      // Arrange
      const { button, wrapper } = renderButtonTrigger({ 'aria-describedby': 'caller-hint' });

      // Act
      fireEvent.mouseEnter(wrapper);

      // Assert
      const ids = button.getAttribute('aria-describedby')!.split(' ');
      expect(ids[0]).toBe('caller-hint');
      expect(ids).toHaveLength(2);
      expect(ids[1]).toBe(tooltip()!.id);
      fireEvent.mouseLeave(wrapper);
      flushClose();
      expect(button.getAttribute('aria-describedby')).toBe('caller-hint');
    });

    it('restores the caller value when the tooltip unmounts while open', () => {
      // Arrange
      const { button, unmount, wrapper } = renderButtonTrigger({ 'aria-describedby': 'caller-hint' });
      fireEvent.mouseEnter(wrapper);
      const detached = button;

      // Act
      unmount();

      // Assert
      expect(detached.getAttribute('aria-describedby')).toBe('caller-hint');
    });

    it('gives simultaneously open tooltips unique ids', () => {
      // Arrange
      render(
        <>
          <HoverTooltip label="First">
            <button type="button">One</button>
          </HoverTooltip>
          <HoverTooltip label="Second">
            <button type="button">Two</button>
          </HoverTooltip>
        </>,
      );
      const [first, second] = screen.getAllByRole('button');

      // Act
      fireEvent.focusIn(first);
      fireEvent.focusIn(second);

      // Assert
      const ids = screen.getAllByRole('tooltip').map((el) => el.id);
      expect(ids).toHaveLength(2);
      expect(ids[0]).toBeTruthy();
      expect(new Set(ids).size).toBe(2);
      expect(first.getAttribute('aria-describedby')).not.toBe(second.getAttribute('aria-describedby'));
    });

    it('falls back to the wrapper when the trigger has no focusable child', () => {
      // Arrange
      const { wrapper } = renderTrigger(<span>label text</span>);

      // Act
      fireEvent.mouseEnter(wrapper);

      // Assert
      expect(wrapper.getAttribute('aria-describedby')).toBe(tooltip()!.id);
    });
  });

  describe('composition', () => {
    it('still runs the caller handlers on the child', () => {
      // Arrange
      const onFocus = vi.fn();
      const onMouseEnter = vi.fn();
      const { button, wrapper } = renderButtonTrigger({ onFocus, onMouseEnter });

      // Act
      fireEvent.mouseEnter(button);
      fireEvent.mouseEnter(wrapper);
      fireEvent.focusIn(button);

      // Assert
      expect(onMouseEnter).toHaveBeenCalledTimes(1);
      expect(onFocus).toHaveBeenCalledTimes(1);
      expect(tooltip()).not.toBeNull();
    });

    it('still runs a caller click handler on the child', () => {
      // Arrange
      const onClick = vi.fn();
      const { button, wrapper } = renderButtonTrigger({ onClick });

      // Act
      fireEvent.mouseEnter(wrapper);
      fireEvent.click(button);

      // Assert
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('keeps the wrapper element and its className', () => {
      // Arrange
      const { container } = render(
        <HoverTooltip label={LABEL} className="min-w-0 truncate">
          <span>text</span>
        </HoverTooltip>,
      );

      // Assert
      const wrapper = container.firstElementChild!;
      expect(wrapper.tagName).toBe('SPAN');
      expect(wrapper.className).toBe('min-w-0 truncate');
      expect(wrapper.hasAttribute('tabindex')).toBe(false);
    });
  });

  describe('enabled=false truncation gate', () => {
    it('stays closed while the trigger content fits', () => {
      // Arrange
      const { wrapper } = renderTrigger(<span>label text</span>, { enabled: false });
      setOverflow(wrapper, 100, 100);

      // Act
      fireEvent.mouseEnter(wrapper);
      fireEvent.focusIn(wrapper);

      // Assert
      expect(tooltip()).toBeNull();
    });

    it('opens once the trigger content overflows', () => {
      // Arrange
      const { wrapper } = renderTrigger(<span>label text</span>, { enabled: false });
      setOverflow(wrapper, 200, 100);

      // Act
      fireEvent.mouseEnter(wrapper);

      // Assert
      expect(tooltip()?.textContent).toBe(LABEL);
    });
  });

  describe('suppressed', () => {
    it('force-closes an open tooltip and blocks reopening until it is released', () => {
      // Arrange
      const { rerender, wrapper } = renderTrigger(<button type="button">Go</button>);
      fireEvent.mouseEnter(wrapper);
      expect(tooltip()?.textContent).toBe(LABEL);

      // Act
      rerender(
        <HoverTooltip label={LABEL} suppressed>
          <button type="button">Go</button>
        </HoverTooltip>,
      );

      // Assert
      expect(tooltip()).toBeNull();
      fireEvent.mouseEnter(wrapper);
      fireEvent.focusIn(wrapper);
      expect(tooltip()).toBeNull();

      // Act
      rerender(
        <HoverTooltip label={LABEL} suppressed={false}>
          <button type="button">Go</button>
        </HoverTooltip>,
      );
      fireEvent.mouseEnter(wrapper);

      // Assert
      expect(tooltip()?.textContent).toBe(LABEL);
    });
  });

  describe('tooltip element', () => {
    it('is never focusable and carries no motion', () => {
      // Arrange
      const { wrapper } = renderButtonTrigger();

      // Act
      fireEvent.mouseEnter(wrapper);

      // Assert
      const tip = tooltip()!;
      expect(tip.hasAttribute('tabindex')).toBe(false);
      expect(tip.querySelector('a[href],button,input,select,textarea,[tabindex]')).toBeNull();
      expect(tip.className).not.toMatch(/transition|animate|duration/);
      expect(tip.getAttribute('style')).not.toMatch(/transition|animation/);
    });

    it('renders into document.body outside the trigger subtree', () => {
      // Arrange
      const { container, wrapper } = renderButtonTrigger();

      // Act
      fireEvent.mouseEnter(wrapper);

      // Assert
      expect(tooltip()!.parentElement).toBe(document.body);
      expect(container.contains(tooltip())).toBe(false);
    });
  });

  describe('lifecycle', () => {
    it('clears a pending close timer on unmount', () => {
      // Arrange
      const { unmount, wrapper } = renderButtonTrigger();
      fireEvent.mouseEnter(wrapper);
      fireEvent.mouseLeave(wrapper);
      expect(vi.getTimerCount()).toBe(1);

      // Act
      unmount();

      // Assert
      expect(vi.getTimerCount()).toBe(0);
    });

    it('leaves no pending timers or post-unmount updates behind', () => {
      // Arrange
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { button, unmount, wrapper } = renderButtonTrigger();
      fireEvent.mouseEnter(wrapper);
      fireEvent.focusIn(button);

      // Act
      unmount();
      vi.runAllTimers();

      // Assert
      expect(vi.getTimerCount()).toBe(0);
      expect(tooltip()).toBeNull();
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });
});
