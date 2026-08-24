// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React, { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnchoredMenu, type AnchoredMenuAlign, type AnchoredMenuRole } from '../src/renderer/components/shared/AnchoredMenu';

interface Box {
  height: number;
  left: number;
  top: number;
  width: number;
}

interface ItemSpec {
  disabled?: boolean;
  label: string;
  onSelect?: () => void;
}

const SURFACE_HEIGHT = 200;
const SURFACE_WIDTH = 160;
const TRIGGER_TESTID = 'anchored-trigger';
const VIEWPORT_HEIGHT = 800;
const VIEWPORT_WIDTH = 1000;

const boxes: { surface: Box; trigger: Box } = {
  surface: { height: SURFACE_HEIGHT, left: 0, top: 0, width: SURFACE_WIDTH },
  trigger: { height: 24, left: 400, top: 100, width: 24 },
};

function toRect({ height, left, top, width }: Box): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    toJSON: () => ({}),
    width,
    x: left,
    y: top,
  };
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

function Harness({
  align,
  items,
  onClose,
  role,
}: Readonly<{
  align?: AnchoredMenuAlign;
  items: ItemSpec[];
  onClose?: () => void;
  role?: AnchoredMenuRole;
}>) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <div data-testid="panel" style={{ overflow: 'hidden' }}>
      <button
        data-testid={TRIGGER_TESTID}
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        type="button"
      >
        Open
      </button>
      <AnchoredMenu
        align={align}
        label="Actions"
        onClose={() => { setOpen(false); onClose?.(); }}
        open={open}
        role={role}
        triggerRef={triggerRef}
      >
        {items.map((item) => (
          <button
            data-testid={`item-${item.label}`}
            disabled={item.disabled}
            key={item.label}
            onClick={item.onSelect}
            role="menuitem"
            type="button"
          >
            {item.label}
          </button>
        ))}
      </AnchoredMenu>
    </div>
  );
}

function openMenu(items: ItemSpec[], props: Omit<React.ComponentProps<typeof Harness>, 'items'> = {}) {
  const view = render(<Harness items={items} {...props} />);
  const trigger = screen.getByTestId(TRIGGER_TESTID);
  fireEvent.click(trigger);
  return { ...view, trigger };
}

function surface(): HTMLElement {
  return screen.getByRole('menu');
}

function item(label: string): HTMLElement {
  return screen.getByTestId(`item-${label}`);
}

const SINGLE_ITEM: ItemSpec[] = [{ label: 'One' }];

describe('AnchoredMenu', () => {
  beforeEach(() => {
    setViewport(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    boxes.surface = { height: SURFACE_HEIGHT, left: 0, top: 0, width: SURFACE_WIDTH };
    boxes.trigger = { height: 24, left: 400, top: 100, width: 24 };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return toRect(this.dataset.testid === TRIGGER_TESTID ? boxes.trigger : boxes.surface);
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe('portal', () => {
    it('renders into document.body outside the clipping panel', () => {
      // Arrange + Act
      openMenu(SINGLE_ITEM);

      // Assert
      expect(surface().parentElement).toBe(document.body);
      expect(screen.getByTestId('panel').contains(surface())).toBe(false);
    });

    it('positions the surface with fixed coordinates', () => {
      // Arrange + Act
      openMenu(SINGLE_ITEM);

      // Assert
      expect(surface().className).toContain('fixed');
      expect(surface().style.top).toBe('128px');
    });
  });

  describe('collision handling', () => {
    it('flips above the trigger when there is no room below', () => {
      // Arrange
      boxes.trigger = { height: 24, left: 400, top: 700, width: 24 };

      // Act
      openMenu(SINGLE_ITEM);

      // Assert
      expect(surface().style.top).toBe('496px');
    });

    it('clamps to the viewport margin when the surface fits on neither side', () => {
      // Arrange
      boxes.surface = { height: 790, left: 0, top: 0, width: SURFACE_WIDTH };

      // Act
      openMenu(SINGLE_ITEM);

      // Assert
      expect(surface().style.top).toBe('8px');
    });

    it('clamps the right edge to the viewport margin', () => {
      // Arrange
      boxes.trigger = { height: 24, left: 970, top: 100, width: 24 };

      // Act
      openMenu(SINGLE_ITEM);

      // Assert
      expect(surface().style.left).toBe(`${VIEWPORT_WIDTH - SURFACE_WIDTH - 8}px`);
    });

    it('clamps the left edge to the viewport margin', () => {
      // Arrange
      boxes.trigger = { height: 24, left: -50, top: 100, width: 24 };

      // Act
      openMenu(SINGLE_ITEM, { align: 'start' });

      // Assert
      expect(surface().style.left).toBe('8px');
    });
  });

  describe('tracking', () => {
    it('re-anchors on window resize', () => {
      // Arrange
      openMenu(SINGLE_ITEM);
      boxes.trigger = { height: 24, left: 200, top: 300, width: 24 };

      // Act
      fireEvent(window, new Event('resize'));

      // Assert
      expect(surface().style.top).toBe('328px');
      expect(surface().style.left).toBe('64px');
    });

    it('re-anchors on a capture-phase scroll from an ancestor', () => {
      // Arrange
      openMenu(SINGLE_ITEM);
      const panel = screen.getByTestId('panel');
      boxes.trigger = { height: 24, left: 400, top: 50, width: 24 };

      // Act — scroll does not bubble, so only a capture listener sees it.
      fireEvent.scroll(panel);

      // Assert
      expect(surface().style.top).toBe('78px');
    });
  });

  describe('dismissal', () => {
    it('closes on Escape and restores focus to the trigger', () => {
      // Arrange
      const onClose = vi.fn();
      const { trigger } = openMenu(SINGLE_ITEM, { onClose });

      // Act
      fireEvent.keyDown(surface(), { key: 'Escape' });

      // Assert
      expect(screen.queryByRole('menu')).toBeNull();
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(trigger);
    });

    it('falls back to the app shell when the trigger is gone by close time', () => {
      // Arrange
      const shell = document.createElement('div');
      shell.setAttribute('data-testid', 'app-shell');
      document.body.append(shell);
      const { trigger } = openMenu(SINGLE_ITEM);
      expect(surface().contains(document.activeElement)).toBe(true);

      // Act — the row owning the trigger unmounts while the menu still holds focus.
      trigger.remove();
      fireEvent.keyDown(surface(), { key: 'Escape' });

      // Assert
      expect(document.activeElement).toBe(shell);
      expect(document.activeElement).not.toBe(document.body);
      shell.remove();
    });

    it('closes on an outside pointer down', () => {
      // Arrange
      const onClose = vi.fn();
      openMenu(SINGLE_ITEM, { onClose });

      // Act
      fireEvent.pointerDown(document.body);

      // Assert
      expect(screen.queryByRole('menu')).toBeNull();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('stays open for a pointer down inside the surface', () => {
      // Arrange
      openMenu(SINGLE_ITEM);

      // Act
      fireEvent.pointerDown(item('One'));

      // Assert
      expect(screen.queryByRole('menu')).not.toBeNull();
    });

    it('leaves the trigger press to the trigger so the toggle never double-fires', () => {
      // Arrange
      const onClose = vi.fn();
      const { trigger } = openMenu(SINGLE_ITEM, { onClose });

      // Act
      fireEvent.pointerDown(trigger);

      // Assert
      expect(screen.queryByRole('menu')).not.toBeNull();
      expect(onClose).not.toHaveBeenCalled();

      // Act
      fireEvent.click(trigger);

      // Assert
      expect(screen.queryByRole('menu')).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('keyboard', () => {
    const NAV_ITEMS: ItemSpec[] = [{ label: 'A' }, { disabled: true, label: 'B' }, { label: 'C' }];

    it('focuses the first enabled item on open', () => {
      // Arrange + Act
      openMenu([{ disabled: true, label: 'A' }, { label: 'B' }]);

      // Assert
      expect(document.activeElement).toBe(item('B'));
    });

    it('closes a menu when Tab moves focus back into the page', () => {
      // Arrange
      const onClose = vi.fn();
      openMenu(SINGLE_ITEM, { onClose });

      // Act
      fireEvent.keyDown(item('One'), { key: 'Tab' });

      // Assert
      expect(screen.queryByRole('menu')).toBeNull();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('skips disabled items and wraps with the arrow keys', () => {
      // Arrange
      openMenu(NAV_ITEMS);

      // Act + Assert
      fireEvent.keyDown(surface(), { key: 'ArrowDown' });
      expect(document.activeElement).toBe(item('C'));

      fireEvent.keyDown(surface(), { key: 'ArrowDown' });
      expect(document.activeElement).toBe(item('A'));

      fireEvent.keyDown(surface(), { key: 'ArrowUp' });
      expect(document.activeElement).toBe(item('C'));
    });

    it('jumps to the first and last enabled item with Home and End', () => {
      // Arrange
      openMenu(NAV_ITEMS);

      // Act + Assert
      fireEvent.keyDown(surface(), { key: 'End' });
      expect(document.activeElement).toBe(item('C'));

      fireEvent.keyDown(surface(), { key: 'Home' });
      expect(document.activeElement).toBe(item('A'));
    });

    it('activates the focused item exactly once with Enter', () => {
      // Arrange
      const onSelect = vi.fn();
      openMenu([{ label: 'A', onSelect }, { label: 'B' }]);

      // Act
      fireEvent.keyDown(item('A'), { key: 'Enter' });

      // Assert
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('activates the focused item exactly once with Space', () => {
      // Arrange
      const onSelect = vi.fn();
      openMenu([{ label: 'A' }, { label: 'B', onSelect }]);
      fireEvent.keyDown(surface(), { key: 'ArrowDown' });

      // Act
      fireEvent.keyDown(item('B'), { key: ' ' });

      // Assert
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('activates a clicked item exactly once', () => {
      // Arrange
      const onSelect = vi.fn();
      openMenu([{ label: 'A', onSelect }]);

      // Act
      fireEvent.click(item('A'));

      // Assert
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('never activates a disabled item', () => {
      // Arrange
      const onSelect = vi.fn();
      openMenu([{ label: 'A' }, { disabled: true, label: 'B', onSelect }]);

      // Act
      fireEvent.keyDown(surface(), { key: 'End' });
      fireEvent.keyDown(item('A'), { key: 'Enter' });

      // Assert
      expect(onSelect).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(item('A'));
    });
  });

  describe('dialog role', () => {
    it('exposes dialog semantics without menu navigation', () => {
      // Arrange
      const onSelect = vi.fn();
      render(<Harness items={[{ label: 'A', onSelect }]} role="dialog" />);

      // Act
      fireEvent.click(screen.getByTestId(TRIGGER_TESTID));

      // Assert
      expect(screen.getByRole('dialog').parentElement).toBe(document.body);
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('still closes on Escape', () => {
      // Arrange
      render(<Harness items={SINGLE_ITEM} role="dialog" />);
      fireEvent.click(screen.getByTestId(TRIGGER_TESTID));

      // Act
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

      // Assert
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});
