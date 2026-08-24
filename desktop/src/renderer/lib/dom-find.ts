/**
 * Pure DOM-search primitives used by `useDomFind`.
 *
 * Walks text nodes under a container element and returns Range objects for
 * every substring match. Uses `document.createTreeWalker` to enumerate text
 * nodes, including those nested in arbitrary depth.
 *
 * Skips text inside <script>, <style>, and elements with attribute
 * `data-find-skip` so e.g. virtualized scroll spacers, syntax-highlighting
 * background tokens, or our own find overlay never appear as matches.
 */

const FIND_SKIP_ATTR = 'data-find-skip';
const SKIPPED_TAG_NAMES = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);

/** Escapes a user-typed string for use inside a RegExp literal. */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isSkippedAncestor(node: Node | null): boolean {
  let cur: Node | null = node;
  while (cur && cur.nodeType !== Node.DOCUMENT_NODE) {
    if (cur.nodeType === Node.ELEMENT_NODE) {
      const el = cur as Element;
      if (SKIPPED_TAG_NAMES.has(el.tagName)) return true;
      if (el.hasAttribute(FIND_SKIP_ATTR)) return true;
    }
    cur = cur.parentNode;
  }
  return false;
}

/**
 * Returns one Range per match, in document order. Empty queries return [].
 *
 * Matches that span text-node boundaries are ignored — this matches Chrome's
 * built-in find behaviour and keeps Range construction simple. Long-form
 * markdown still finds individual words because they're contained in a single
 * text node per word.
 */
export function findMatches(
  container: HTMLElement,
  query: string,
  caseSensitive: boolean,
): Range[] {
  if (!query) return [];
  if (typeof document === 'undefined') return [];

  let regex: RegExp;
  try {
    regex = new RegExp(escapeRegex(query), caseSensitive ? 'g' : 'gi');
  } catch {
    return [];
  }

  const ranges: Range[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (isSkippedAncestor(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let textNode = walker.nextNode() as Text | null;
  while (textNode) {
    const value = textNode.nodeValue ?? '';
    if (value.length > 0) {
      const matches = value.matchAll(regex);
      for (const m of matches) {
        if (m.index === undefined) continue;
        const range = document.createRange();
        range.setStart(textNode, m.index);
        range.setEnd(textNode, m.index + m[0].length);
        ranges.push(range);
      }
    }
    textNode = walker.nextNode() as Text | null;
  }

  return ranges;
}

const HIGHLIGHT_KEY_ALL = 'amux-find';
const HIGHLIGHT_KEY_ACTIVE = 'amux-find-active';
const HIGHLIGHT_STYLE_ID = 'aumx-find-highlight-style';

interface HighlightCtor {
  new (...ranges: AbstractRange[]): Highlight;
}
interface CssHighlightApi {
  highlights: Map<string, Highlight>;
}

function getHighlightCtor(): HighlightCtor | null {
  const w = (typeof globalThis !== 'undefined' ? globalThis : undefined) as
    | (typeof globalThis & { Highlight?: HighlightCtor })
    | undefined;
  return w?.Highlight ?? null;
}

function getCssHighlights(): CssHighlightApi['highlights'] | null {
  const c = (typeof CSS !== 'undefined' ? CSS : null) as unknown as CssHighlightApi | null;
  return c?.highlights ?? null;
}

function ensureHighlightStyle(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = [
    '::highlight(amux-find) { background-color: color-mix(in srgb, var(--accent) 22%, transparent); }',
    '::highlight(amux-find-active) { background-color: var(--accent); color: var(--bg); text-shadow: none; }',
  ].join('\n');
  document.head.appendChild(style);
}

/**
 * Push a set of ranges into the global CSS highlight registry under the given
 * key. Pass an empty array to clear that key. No-op when the browser does not
 * support the CSS Custom Highlight API (extremely old engines).
 *
 * The `active` highlight gets a higher priority so it paints on top of the
 * `all` highlight when a Range belongs to both (which is always the case —
 * the active match is also one of all matches).
 */
export function setHighlightRanges(key: 'all' | 'active', ranges: Range[]): void {
  const Ctor = getHighlightCtor();
  const registry = getCssHighlights();
  if (!Ctor || !registry) return;
  ensureHighlightStyle();
  const registryKey = key === 'active' ? HIGHLIGHT_KEY_ACTIVE : HIGHLIGHT_KEY_ALL;
  if (ranges.length === 0) {
    registry.delete(registryKey);
    return;
  }
  const highlight = new Ctor(...ranges);
  // `priority` exists on Highlight but is not in every TS lib version; set
  // defensively.
  try {
    (highlight as Highlight & { priority?: number }).priority = key === 'active' ? 2 : 1;
  } catch {
    /* older engines: insertion order will determine paint order */
  }
  registry.set(registryKey, highlight);
}

/** Clear both highlight buckets. Safe to call when keys aren't registered. */
export function clearAllHighlights(): void {
  const registry = getCssHighlights();
  if (!registry) return;
  registry.delete(HIGHLIGHT_KEY_ALL);
  registry.delete(HIGHLIGHT_KEY_ACTIVE);
}

/**
 * Scrolls the active match's range into view inside its scroll container.
 *
 * The container passed in may itself be `overflow: hidden` (and have a
 * scrollable descendant inside it — e.g. AgentActivityPanel's `contentRef`
 * wraps a sub-view that owns its own `overflow-y: auto` scroller). So we walk
 * up from the range's start node to find the nearest actually-scrollable
 * ancestor, then nudge that one. Falls back to `scrollIntoView` if no
 * scrollable ancestor was found inside the container.
 */
export function scrollRangeIntoView(range: Range, container: HTMLElement): void {
  const startNode = range.startContainer;
  const startElement =
    startNode.nodeType === Node.ELEMENT_NODE
      ? (startNode as Element)
      : startNode.parentElement;
  if (!startElement) return;

  const scroller = findScrollableAncestor(startElement, container);
  if (!scroller) {
    // No scrollable ancestor inside the container — let the browser do its best.
    try {
      (startElement as HTMLElement).scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch {
      /* element may have been detached between scan and scroll */
    }
    return;
  }

  const rangeRect = range.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();

  const margin = 40;
  const above = rangeRect.top - scrollerRect.top;
  const below = rangeRect.bottom - scrollerRect.bottom;

  if (above < margin) {
    scroller.scrollBy({ top: above - margin, behavior: 'auto' });
  } else if (below > -margin) {
    scroller.scrollBy({ top: below + margin, behavior: 'auto' });
  }
}

/**
 * Find the nearest ancestor of `start` (up to and including `boundary`) that
 * actually scrolls vertically. Returns null if none is found.
 */
function findScrollableAncestor(start: Element, boundary: HTMLElement): HTMLElement | null {
  let cur: Element | null = start;
  while (cur && cur !== boundary.parentElement) {
    if (cur instanceof HTMLElement) {
      const style = getComputedStyle(cur);
      const overflowY = style.overflowY;
      const scrollable =
        (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
        cur.scrollHeight > cur.clientHeight;
      if (scrollable) return cur;
    }
    if (cur === boundary) return null;
    cur = cur.parentElement;
  }
  return null;
}
