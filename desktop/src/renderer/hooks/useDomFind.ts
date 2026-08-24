import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  clearAllHighlights,
  findMatches,
  scrollRangeIntoView,
  setHighlightRanges,
} from '../lib/dom-find';

export interface UseDomFindResult {
  matchCount: number;
  /** 1-based index of the currently-active match. 0 when no matches. */
  matchIndex: number;
  next: () => void;
  prev: () => void;
}

interface UseDomFindOptions {
  /** Container the search runs against. */
  containerRef: RefObject<HTMLElement | null>;
  /** Currently-typed query. Empty string → no highlights, no matches. */
  query: string;
  caseSensitive: boolean;
  /** When true, the find state is active (typing, navigating). When false, all
   *  highlights are removed and the hook returns zeros. Drive this from the
   *  parent's "find overlay open?" state. */
  enabled: boolean;
  /** Tokens that should force a re-scan even when query/caseSensitive haven't
   *  changed (e.g. sub-tab key in the activity panel). Falsy values are fine. */
  resetKey?: string | number;
}

/**
 * Browser-style "find in container" backed by the CSS Custom Highlight API.
 *
 * Re-scans whenever query/caseSensitive/resetKey change, AND on debounced
 * MutationObserver ticks so streaming agent output stays searchable.
 *
 * Layout note: the parent must give the container a stable scroll viewport
 * (overflow-y: auto). Highlights are painted directly on the rendered text
 * nodes — no DOM mutation, no React reconciliation interference.
 */
export function useDomFind(opts: UseDomFindOptions): UseDomFindResult {
  const { containerRef, query, caseSensitive, enabled, resetKey } = opts;
  const rangesRef = useRef<Range[]>([]);
  const [matchCount, setMatchCount] = useState(0);
  const [matchIndex, setMatchIndex] = useState(0);
  // matchIndex is mirrored to a ref so next/prev (and the streaming-DOM
  // observer) can read it synchronously without depending on stale closures
  // or threading state through setMatchIndex's updater (whose body runs LATER
  // during reconcile, so any value computed inside it is unavailable from the
  // calling scope).
  const matchIndexRef = useRef(0);

  // Re-scan when query / caseSensitive / resetKey / enabled changes.
  useEffect(() => {
    if (!enabled) {
      rangesRef.current = [];
      setMatchCount(0);
      setMatchIndex(0);
      matchIndexRef.current = 0;
      clearAllHighlights();
      return;
    }
    const container = containerRef.current;
    if (!container) {
      rangesRef.current = [];
      setMatchCount(0);
      setMatchIndex(0);
      matchIndexRef.current = 0;
      clearAllHighlights();
      return;
    }
    const ranges = query ? findMatches(container, query, caseSensitive) : [];
    rangesRef.current = ranges;
    setMatchCount(ranges.length);
    const initialIndex = ranges.length > 0 ? 1 : 0;
    setMatchIndex(initialIndex);
    matchIndexRef.current = initialIndex;
    setHighlightRanges('all', ranges);
    if (ranges.length > 0) {
      setHighlightRanges('active', [ranges[0]]);
      scrollRangeIntoView(ranges[0], container);
    } else {
      setHighlightRanges('active', []);
    }
  }, [enabled, query, caseSensitive, resetKey, containerRef]);

  // Re-scan on streaming DOM changes (debounced).
  useEffect(() => {
    if (!enabled || !query) return;
    const container = containerRef.current;
    if (!container) return;
    let rafToken: number | null = null;
    const observer = new MutationObserver(() => {
      if (rafToken != null) return;
      rafToken = requestAnimationFrame(() => {
        rafToken = null;
        const fresh = findMatches(container, query, caseSensitive);
        rangesRef.current = fresh;
        setMatchCount(fresh.length);
        setHighlightRanges('all', fresh);
        // Clamp current index if matches shrank; otherwise keep position.
        const prev = matchIndexRef.current;
        if (fresh.length === 0) {
          matchIndexRef.current = 0;
          setMatchIndex(0);
          setHighlightRanges('active', []);
          return;
        }
        const clamped = Math.min(prev || 1, fresh.length);
        matchIndexRef.current = clamped;
        setMatchIndex(clamped);
        setHighlightRanges('active', [fresh[clamped - 1]]);
      });
    });
    observer.observe(container, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    return () => {
      observer.disconnect();
      if (rafToken != null) cancelAnimationFrame(rafToken);
    };
  }, [enabled, query, caseSensitive, containerRef]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => clearAllHighlights();
  }, []);

  const next = useCallback(() => {
    const ranges = rangesRef.current;
    if (ranges.length === 0) return;
    const cur = matchIndexRef.current;
    const nextIdx = cur >= ranges.length ? 1 : cur + 1;
    matchIndexRef.current = nextIdx;
    setMatchIndex(nextIdx);
    const chosen = ranges[nextIdx - 1];
    if (!chosen) return;
    setHighlightRanges('active', [chosen]);
    const container = containerRef.current;
    if (container) scrollRangeIntoView(chosen, container);
  }, [containerRef]);

  const prev = useCallback(() => {
    const ranges = rangesRef.current;
    if (ranges.length === 0) return;
    const cur = matchIndexRef.current;
    const prevIdx = cur <= 1 ? ranges.length : cur - 1;
    matchIndexRef.current = prevIdx;
    setMatchIndex(prevIdx);
    const chosen = ranges[prevIdx - 1];
    if (!chosen) return;
    setHighlightRanges('active', [chosen]);
    const container = containerRef.current;
    if (container) scrollRangeIntoView(chosen, container);
  }, [containerRef]);

  return useMemo(
    () => ({ matchCount, matchIndex, next, prev }),
    [matchCount, matchIndex, next, prev],
  );
}
