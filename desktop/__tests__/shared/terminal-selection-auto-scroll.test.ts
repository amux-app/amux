// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachTerminalSelectionAutoScroll } from '../../src/renderer/lib/terminal-selection-auto-scroll';

describe('attachTerminalSelectionAutoScroll', () => {
  let element: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    element = document.createElement('div');
    document.body.appendChild(element);
    element.getBoundingClientRect = () => ({
      bottom: 240,
      height: 240,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  });

  afterEach(() => {
    element.remove();
    vi.useRealTimers();
  });

  it('repeats edge scrolling until the primary mouse button is released', () => {
    const onScroll = vi.fn();
    const onSelectionEnd = vi.fn();
    const onSelectionMove = vi.fn();
    const onSelectionStart = vi.fn();
    const dispose = attachTerminalSelectionAutoScroll({
      canStartSelection: () => true,
      element,
      getRowHeight: () => 10,
      getSelection: () => 'selected text',
      needsCustomScroll: () => true,
      onScroll,
      onSelectionEnd,
      onSelectionMove,
      onSelectionStart,
    });

    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 }));
    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      buttons: 1,
      clientX: 400,
      clientY: 239,
    }));
    expect(onSelectionStart).toHaveBeenCalledOnce();
    expect(onSelectionMove).toHaveBeenCalledWith({ clientX: 400, clientY: 239 });
    vi.advanceTimersByTime(110);

    expect(onScroll).toHaveBeenCalledTimes(2);
    expect(onScroll).toHaveBeenLastCalledWith('down', 1, { clientX: 400, clientY: 239 });

    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    expect(onSelectionEnd).toHaveBeenCalledWith(true);
    vi.advanceTimersByTime(100);
    expect(onScroll).toHaveBeenCalledTimes(2);

    dispose();
    expect(onSelectionEnd).toHaveBeenCalledOnce();
  });

  it('cancels selection ownership without completing copy-on-select when the window blurs', () => {
    const onSelectionEnd = vi.fn();
    const dispose = attachTerminalSelectionAutoScroll({
      canStartSelection: () => true,
      element,
      getRowHeight: () => 10,
      getSelection: () => 'selected text',
      needsCustomScroll: () => true,
      onScroll: vi.fn(),
      onSelectionEnd,
    });

    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 }));
    window.dispatchEvent(new Event('blur'));

    expect(onSelectionEnd).toHaveBeenCalledWith(false);
    dispose();
  });

  it('scrolls faster outside the top edge and stops when the pointer returns to the middle', () => {
    const onScroll = vi.fn();
    const dispose = attachTerminalSelectionAutoScroll({
      canStartSelection: () => true,
      element,
      getRowHeight: () => 10,
      getSelection: () => 'selected text',
      needsCustomScroll: () => true,
      onScroll,
    });

    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 }));
    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      buttons: 1,
      clientX: 400,
      clientY: -25,
    }));
    vi.advanceTimersByTime(50);
    expect(onScroll).toHaveBeenCalledWith('up', 3, { clientX: 400, clientY: -25 });

    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      buttons: 1,
      clientX: 400,
      clientY: 120,
    }));
    vi.advanceTimersByTime(100);
    expect(onScroll).toHaveBeenCalledTimes(1);

    dispose();
  });

  it.each([
    {
      canStartSelection: true,
      getSelection: () => 'selected text',
      label: 'xterm owns normal-buffer scrolling',
      needsCustomScroll: false,
    },
    {
      canStartSelection: false,
      getSelection: () => 'selected text',
      label: 'a mouse-tracking TUI owns an unmodified drag',
      needsCustomScroll: true,
    },
    {
      canStartSelection: true,
      getSelection: () => '',
      label: 'the drag has not produced a text selection',
      needsCustomScroll: true,
    },
  ])('does not scroll when $label', ({ canStartSelection, getSelection, needsCustomScroll }) => {
    const onScroll = vi.fn();
    const dispose = attachTerminalSelectionAutoScroll({
      canStartSelection: () => canStartSelection,
      element,
      getRowHeight: () => 10,
      getSelection,
      needsCustomScroll: () => needsCustomScroll,
      onScroll,
    });

    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 }));
    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      buttons: 1,
      clientY: 239,
    }));
    vi.advanceTimersByTime(100);

    expect(onScroll).not.toHaveBeenCalled();
    dispose();
  });
});
