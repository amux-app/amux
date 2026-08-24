import type { SearchAddon } from '@xterm/addon-search';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import { rendererLog } from '../../../lib/rendererLog';

interface SearchResults {
  resultCount: number;
  resultIndex: number;
}

interface UseTerminalFindOptions {
  activeMatchBorder: string;
  blurTerminal: () => void;
  focusTerminal: () => void;
  searchAddonRef: RefObject<SearchAddon | null>;
}

interface UseTerminalFindResult {
  caseSensitive: boolean;
  close: () => void;
  onResultsChanged: (results: SearchResults) => void;
  open: () => void;
  opened: boolean;
  openedRef: RefObject<boolean>;
  query: string;
  result: { count: number; index: number };
  runFind: (direction: 'next' | 'prev') => void;
  setQuery: Dispatch<SetStateAction<string>>;
  toggleCaseSensitive: () => void;
}

function resolveSearchAccent(): string {
  if (typeof window === 'undefined') return '#3b82f6';
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw : '#3b82f6';
}

export function useTerminalFind({
  activeMatchBorder,
  blurTerminal,
  focusTerminal,
  searchAddonRef,
}: UseTerminalFindOptions): UseTerminalFindResult {
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState({ count: 0, index: 0 });
  const openedRef = useRef(false);
  const queryRef = useRef('');
  const caseSensitiveRef = useRef(false);

  useEffect(() => { openedRef.current = opened; }, [opened]);
  useEffect(() => { queryRef.current = query; }, [query]);
  useEffect(() => { caseSensitiveRef.current = caseSensitive; }, [caseSensitive]);

  const runFind = useCallback((direction: 'next' | 'prev') => {
    const addon = searchAddonRef.current;
    const currentQuery = queryRef.current;
    if (!addon) return;
    if (!currentQuery) {
      addon.clearDecorations();
      setResult({ count: 0, index: 0 });
      return;
    }
    const accent = resolveSearchAccent();
    // The addon registers overview-ruler decorations unconditionally. All six
    // colors must be concrete for its result event pipeline to remain active.
    const options: Parameters<typeof addon.findNext>[1] = {
      caseSensitive: caseSensitiveRef.current,
      decorations: {
        activeMatchBackground: accent,
        activeMatchBorder,
        activeMatchColorOverviewRuler: accent,
        matchBackground: accent,
        matchBorder: accent,
        matchOverviewRuler: accent,
      },
    };
    try {
      if (direction === 'next') addon.findNext(currentQuery, options);
      else addon.findPrevious(currentQuery, options);
    } catch (error) {
      rendererLog.warn('terminal-find', 'Search threw', { error });
      setResult({ count: 0, index: 0 });
    }
  }, [activeMatchBorder, searchAddonRef]);

  useEffect(() => {
    if (!opened) return;
    if (!query) {
      searchAddonRef.current?.clearDecorations();
      setResult({ count: 0, index: 0 });
      return;
    }
    runFind('next');
  }, [caseSensitive, opened, query, runFind, searchAddonRef]);

  useEffect(() => {
    if (opened) blurTerminal();
  }, [blurTerminal, opened]);

  useEffect(() => {
    if (opened) return;
    searchAddonRef.current?.clearDecorations();
    setResult({ count: 0, index: 0 });
  }, [opened, searchAddonRef]);

  const open = useCallback(() => {
    if (!openedRef.current) {
      setOpened(true);
      return;
    }
    setOpened(false);
    requestAnimationFrame(() => setOpened(true));
  }, []);

  const close = useCallback(() => {
    setOpened(false);
    setQuery('');
    requestAnimationFrame(focusTerminal);
  }, [focusTerminal]);

  const onResultsChanged = useCallback((results: SearchResults) => {
    setResult({
      count: results.resultCount,
      index: results.resultIndex >= 0 ? results.resultIndex + 1 : 0,
    });
  }, []);

  const toggleCaseSensitive = useCallback(() => {
    setCaseSensitive((value) => !value);
  }, []);

  return {
    caseSensitive,
    close,
    onResultsChanged,
    open,
    opened,
    openedRef,
    query,
    result,
    runFind,
    setQuery,
    toggleCaseSensitive,
  };
}
