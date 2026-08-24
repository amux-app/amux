import type { RefObject } from 'react';
import { useLayoutEffect, useRef } from 'react';

const FLIP_DURATION_MS = 180;
const FLIP_EASING = 'cubic-bezier(0.2, 0, 0, 1)';
const FLIP_SELECTOR = '[data-flip-id]';

type TopsById = Map<string, number>;

const prefersReducedMotion = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function flipElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FLIP_SELECTOR)];
}

function resetFlipStyle(el: HTMLElement): void {
  el.style.transform = '';
  el.style.transition = '';
}

/** Nested flip elements (a row inside a group wrapper) inherit their ancestor's
 * transform visually, so measuring everyone against the outer container would
 * double-apply a moving group's delta onto its own rows. Walking up to the
 * nearest flip ancestor — falling back to the container for top-level elements
 * like groups — isolates each level's own local movement. */
function referenceElement(container: HTMLElement, el: HTMLElement): HTMLElement {
  let node = el.parentElement;
  while (node && node !== container) {
    if (node.hasAttribute('data-flip-id')) return node;
    node = node.parentElement;
  }
  return container;
}

function relativeTop(container: HTMLElement, el: HTMLElement): number {
  return el.getBoundingClientRect().top - referenceElement(container, el).getBoundingClientRect().top;
}

/**
 * The FLIP "start" per element: `playInvert` always leaves the inline
 * `transform` at identity (`''`) while it plays, driving the glide purely via
 * the inline `transition` — so a still in-flight element is detected by that
 * transition being set, not by the transform. In a real browser,
 * `getBoundingClientRect()` on such an element reports its true current
 * (interpolated) position even though the inline transform reads empty, so
 * measuring it here — before the transition is cleared — continues the glide
 * from where it visually is instead of snapping. An element with no active
 * transition reuses its last settled position, which is what lets a genuinely
 * fresh reorder animate at all.
 */
function measureStartTops(
  container: HTMLElement,
  elements: readonly HTMLElement[],
  prevTops: TopsById | null,
): TopsById {
  const tops: TopsById = new Map();
  for (const el of elements) {
    const id = el.dataset.flipId;
    if (!id) continue;
    if (el.style.transition) {
      tops.set(id, relativeTop(container, el));
    } else if (prevTops?.has(id)) {
      tops.set(id, prevTops.get(id) as number);
    }
  }
  return tops;
}

function measureSettledTops(container: HTMLElement, elements: readonly HTMLElement[]): TopsById {
  const tops: TopsById = new Map();
  for (const el of elements) {
    const id = el.dataset.flipId;
    if (id) tops.set(id, relativeTop(container, el));
  }
  return tops;
}

function playInvert(el: HTMLElement, delta: number): void {
  el.style.transition = 'none';
  el.style.transform = `translateY(${delta}px)`;
  el.getBoundingClientRect();
  el.style.transition = `transform ${FLIP_DURATION_MS}ms ${FLIP_EASING}`;
  el.style.transform = '';

  const onTransitionEnd = (event: TransitionEvent) => {
    if (event.target !== el || event.propertyName !== 'transform') return;
    resetFlipStyle(el);
    el.removeEventListener('transitionend', onTransitionEnd);
  };
  el.addEventListener('transitionend', onTransitionEnd);
}

function playDeltas(elements: readonly HTMLElement[], startTops: TopsById, endTops: TopsById): void {
  for (const el of elements) {
    const id = el.dataset.flipId;
    if (!id) continue;
    const start = startTops.get(id);
    const end = endTops.get(id);
    if (start === undefined || end === undefined) continue;
    const delta = start - end;
    if (delta !== 0) playInvert(el, delta);
  }
}

/**
 * Vanilla FLIP animation for reordering. Any descendant of the container carrying
 * `data-flip-id` glides from its previous position to its new one, transform only.
 * Continuation-safe: an element still mid-glide when a new reorder lands is measured
 * at its true current visual position (not its stale target), so back-to-back
 * reorders continue smoothly instead of snapping. Nested flip elements (rows inside
 * a group) are measured relative to their nearest flip ancestor, so a moving group
 * never double-applies its own delta onto its rows. A no-op under
 * `prefers-reduced-motion` and in zero-rect environments (e.g. jsdom), where every
 * measured top comes out equal.
 */
export function useFlipReorder(containerRef: RefObject<HTMLElement | null>): void {
  const prevTopsRef = useRef<TopsById | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || prefersReducedMotion()) {
      prevTopsRef.current = null;
      return;
    }

    const elements = flipElements(container);
    if (elements.length === 0) {
      prevTopsRef.current = null;
      return;
    }

    const startTops = measureStartTops(container, elements, prevTopsRef.current);

    for (const el of elements) resetFlipStyle(el);

    const endTops = measureSettledTops(container, elements);
    prevTopsRef.current = endTops;

    playDeltas(elements, startTops, endTops);
  });
}
