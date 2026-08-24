// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React, { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFlipReorder } from '../src/renderer/hooks/useFlipReorder';

const ROW_HEIGHT_PX = 32;
const GROUP_HEIGHT_PX = 100;

interface TestGroup {
  key: string;
  rows: string[];
}

function TestList({ items }: Readonly<{ items: string[] }>) {
  const containerRef = useRef<HTMLDivElement>(null);
  useFlipReorder(containerRef);
  return (
    <div ref={containerRef}>
      {items.map((id) => (
        <div key={id} data-flip-id={id}>{id}</div>
      ))}
    </div>
  );
}

function TestNestedList({ groups }: Readonly<{ groups: TestGroup[] }>) {
  const containerRef = useRef<HTMLDivElement>(null);
  useFlipReorder(containerRef);
  return (
    <div ref={containerRef}>
      {groups.map((group) => (
        <div key={group.key} data-flip-id={group.key}>
          {group.rows.map((row) => (
            <div key={row} data-flip-id={row}>{row}</div>
          ))}
        </div>
      ))}
    </div>
  );
}

function rectAt(top: number): DOMRect {
  return { bottom: top + ROW_HEIGHT_PX, height: ROW_HEIGHT_PX, left: 0, right: 100, toJSON() {}, top, width: 100, x: 0, y: top } as DOMRect;
}

/** Layout position purely by DOM order among siblings — no transform involved. */
function mockRectsByDomOrder(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mocked(
    this: HTMLElement,
  ) {
    const siblings = this.parentElement ? [...this.parentElement.children] : [];
    return rectAt(siblings.indexOf(this) * ROW_HEIGHT_PX);
  });
}

/** Every element (container and rows alike) sits `pageOffset` further down the
 * page, as it would after an ancestor scroll moved the whole rigid block. */
function mockRectsWithPageOffset(getPageOffset: () => number): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mocked(
    this: HTMLElement,
  ) {
    const isRow = this.hasAttribute('data-flip-id');
    const siblings = this.parentElement ? [...this.parentElement.children] : [];
    const localOffset = isRow ? siblings.indexOf(this) * ROW_HEIGHT_PX : 0;
    return rectAt(getPageOffset() + localOffset);
  });
}

/** Two-level layout: a group's top is its index among the container's children
 * times a group-sized row; a row's top is its group's top plus its own index
 * among its group's children. Mirrors the real group-wrapper/row DOM shape. */
function mockNestedRectsByDomOrder(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mocked(
    this: HTMLElement,
  ) {
    const parent = this.parentElement;
    const parentIsGroup = parent?.hasAttribute('data-flip-id') === true;
    if (parent && parentIsGroup) {
      const groupSiblings = parent.parentElement ? [...parent.parentElement.children] : [];
      const groupTop = groupSiblings.indexOf(parent) * GROUP_HEIGHT_PX;
      const rowIndex = [...parent.children].indexOf(this);
      return rectAt(groupTop + rowIndex * ROW_HEIGHT_PX);
    }
    const siblings = parent ? [...parent.children] : [];
    return rectAt(siblings.indexOf(this) * GROUP_HEIGHT_PX);
  });
}

function dispatchTransitionEnd(element: HTMLElement, propertyName: string): void {
  const event = new Event('transitionend', { bubbles: true });
  Object.defineProperty(event, 'propertyName', { value: propertyName });
  fireEvent(element, event);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useFlipReorder', () => {
  it('is a no-op in a zero-rect environment (default jsdom/happy-dom layout)', () => {
    // Arrange
    const { rerender } = render(<TestList items={['a', 'b']} />);

    // Act — reorder while every measured rect stays 0
    rerender(<TestList items={['b', 'a']} />);

    // Assert
    expect(screen.getByText('a').style.transform).toBe('');
    expect(screen.getByText('b').style.transform).toBe('');
  });

  it('inverts the transform and transitions to identity when a flip element moves', () => {
    // Arrange
    mockRectsByDomOrder();
    const { rerender } = render(<TestList items={['a', 'b']} />);

    // Act — swap order, moving "a" down by one row
    rerender(<TestList items={['b', 'a']} />);

    // Assert — the element settles at identity, driven there by a 180ms transition
    const movedEl = screen.getByText('a');
    expect(movedEl.style.transform).toBe('');
    expect(movedEl.style.transition).toContain('transform 180ms');

    // Act — the transition completes
    dispatchTransitionEnd(movedEl, 'transform');

    // Assert — inline styles are cleaned up
    expect(movedEl.style.transition).toBe('');
  });

  it('ignores transition completion for properties the FLIP animation does not own', () => {
    // Arrange
    mockRectsByDomOrder();
    const { rerender } = render(<TestList items={['a', 'b']} />);
    rerender(<TestList items={['b', 'a']} />);
    const movedEl = screen.getByText('a');
    expect(movedEl.style.transition).toContain('transform 180ms');

    // Act — another property finishes on the same element first
    dispatchTransitionEnd(movedEl, 'opacity');

    // Assert — the FLIP transition stays active until transform itself ends
    expect(movedEl.style.transition).toContain('transform 180ms');
    dispatchTransitionEnd(movedEl, 'transform');
    expect(movedEl.style.transition).toBe('');
  });

  it('leaves an unmoved flip element untouched', () => {
    // Arrange
    mockRectsByDomOrder();
    const { rerender } = render(<TestList items={['a', 'b', 'c']} />);

    // Act — "a" stays first; only "b" and "c" swap
    rerender(<TestList items={['a', 'c', 'b']} />);

    // Assert
    expect(screen.getByText('a').style.transition).toBe('');
  });

  it('continues from the true mid-flight position instead of the stale settled one', () => {
    // Arrange — settle a baseline at mount, then put "a" into the EXACT state
    // playInvert leaves behind mid-glide: inline transform back at identity,
    // inline transition still set. The mock reports a mid-flight rect ONLY
    // while that transition is active, mirroring how a real browser's
    // getBoundingClientRect() reflects the current interpolated position even
    // though the inline transform reads empty.
    const MID_FLIGHT_TOP = 12;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mocked(
      this: HTMLElement,
    ) {
      if (this.dataset.flipId === 'a' && this.style.transition) return rectAt(MID_FLIGHT_TOP);
      const siblings = this.parentElement ? [...this.parentElement.children] : [];
      return rectAt(siblings.indexOf(this) * ROW_HEIGHT_PX);
    });
    const { rerender } = render(<TestList items={['a', 'b']} />);
    const aEl = screen.getByText('a');
    expect(aEl.style.transform).toBe('');
    aEl.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1)';

    // Act — no reorder; "a" would settle back at its unchanged position (0)
    rerender(<TestList items={['a', 'b']} />);

    // Assert — start (12, mid-flight) !== end (0, settled) drives a fresh glide
    // that continues from the true visual position instead of snapping
    expect(aEl.style.transform).toBe('');
    expect(aEl.style.transition).toContain('transform 180ms');
  });

  it('does not glide when the whole list shifts on the page (e.g. an ancestor scroll)', () => {
    // Arrange
    let pageOffset = 1000;
    mockRectsWithPageOffset(() => pageOffset);
    const { rerender } = render(<TestList items={['a', 'b']} />);

    // Act — no reorder, only the container and its rows moving together
    pageOffset = 1500;
    rerender(<TestList items={['a', 'b']} />);

    // Assert — no spurious glide from the ambient shift
    expect(screen.getByText('a').style.transform).toBe('');
    expect(screen.getByText('b').style.transform).toBe('');
  });

  it('still animates a genuine reorder that happens alongside a page shift', () => {
    // Arrange
    let pageOffset = 1000;
    mockRectsWithPageOffset(() => pageOffset);
    const { rerender } = render(<TestList items={['a', 'b']} />);

    // Act — the page shifts AND the rows swap in the same render
    pageOffset = 1500;
    rerender(<TestList items={['b', 'a']} />);

    // Assert — the reorder still animates
    const movedEl = screen.getByText('a');
    expect(movedEl.style.transform).toBe('');
    expect(movedEl.style.transition).toContain('transform 180ms');
  });

  it('does not double-apply a group move onto its rows when groups reorder', () => {
    // Arrange — two groups, each with two rows in a stable intra-group order
    mockNestedRectsByDomOrder();
    const groupsBefore: TestGroup[] = [
      { key: 'A', rows: ['a1', 'a2'] },
      { key: 'B', rows: ['b1', 'b2'] },
    ];
    const { container, rerender } = render(<TestNestedList groups={groupsBefore} />);

    // Act — groups A and B swap; rows keep their order within each group
    const groupsAfter: TestGroup[] = [
      { key: 'B', rows: ['b1', 'b2'] },
      { key: 'A', rows: ['a1', 'a2'] },
    ];
    rerender(<TestNestedList groups={groupsAfter} />);

    // Assert — the groups themselves glide...
    const groupA = container.querySelector('[data-flip-id="A"]') as HTMLElement;
    const groupB = container.querySelector('[data-flip-id="B"]') as HTMLElement;
    expect(groupA.style.transition).toContain('transform 180ms');
    expect(groupB.style.transition).toContain('transform 180ms');

    // Assert — ...but every row is untouched: its position within its own
    // group never changed, so it must not receive its own transform on top
    // of the transform its moving parent already carries
    for (const row of ['a1', 'a2', 'b1', 'b2']) {
      const el = screen.getByText(row);
      expect(el.style.transform).toBe('');
      expect(el.style.transition).toBe('');
    }
  });
});
