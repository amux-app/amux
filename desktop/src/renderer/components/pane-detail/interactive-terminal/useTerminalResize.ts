import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import type { AumxPane } from 'aumx/core';
import { useCallback, useEffect, useRef, type RefObject } from 'react';
import * as terminalApi from '../../../api/terminal.api';
import { fitTerminalToContainer, type TerminalFitFailureReason } from '../../../lib/terminal-fit';
import { rendererLog } from '../../../lib/rendererLog';
import {
  isSameTerminalSize,
  NARROW_TERMINAL_FAILURE_MESSAGE,
  resolveTerminalFontSize,
  type PendingTerminalResize,
  type TerminalFailure,
  type TerminalSize,
} from './terminal-model';

const AGENT_MIN_TERMINAL_COLS = 80;
const AGENT_MIN_TERMINAL_FONT_SIZE = 11;
const AGENT_MIN_TERMINAL_ROWS = 24;
const MAX_RESIZE_ATTEMPTS = 3;
const RESIZE_DEBOUNCE_MS = 150;

type TerminalFailureUpdate = TerminalFailure
  | null
  | ((current: TerminalFailure | null) => TerminalFailure | null);

interface UseTerminalResizeOptions {
  agent: AumxPane['agent'];
  containerRef: RefObject<HTMLDivElement | null>;
  fitAddonRef: RefObject<FitAddon | null>;
  fixedCols: number | undefined;
  paneCount: number;
  paneId: string;
  preemptPendingScroll: () => void;
  readyRef: RefObject<boolean>;
  setTerminalFailure: (update: TerminalFailureUpdate) => void;
  terminalFontSize: number | undefined;
  termRef: RefObject<Terminal | null>;
}

interface UseTerminalResizeResult {
  fit: () => TerminalSize | null;
  getLastFitFailure: () => TerminalFitFailureReason | null;
  recordAttachedSize: (size: TerminalSize, appliedFontSize?: number | null) => void;
  requestResize: () => void;
  reset: () => void;
  setAttachPending: (size: TerminalSize | null) => void;
}

function refreshTerminalRenderer(terminal: Terminal): void {
  terminal.refresh(0, Math.max(0, terminal.rows - 1));
}

export function useTerminalResize({
  agent,
  containerRef,
  fitAddonRef,
  fixedCols,
  paneCount,
  paneId,
  preemptPendingScroll,
  readyRef,
  setTerminalFailure,
  terminalFontSize,
  termRef,
}: UseTerminalResizeOptions): UseTerminalResizeResult {
  const drainResizeRef = useRef<() => void>(() => undefined);
  const lastAppliedFontSizeRef = useRef<number | null>(null);
  const lastAppliedSizeRef = useRef<TerminalSize | null>(null);
  const lastFitFailureRef = useRef<TerminalFitFailureReason | null>(null);
  const lastSentSizeRef = useRef<TerminalSize | null>(null);
  const pendingAttachSizeRef = useRef<TerminalSize | null>(null);
  const pendingResizeRef = useRef<PendingTerminalResize | null>(null);
  const queuedResizeRef = useRef<TerminalSize | null>(null);
  const resizeAttemptRef = useRef<{ attempts: number; size: TerminalSize } | null>(null);
  const resizeRequestIdRef = useRef(0);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fit = useCallback((): TerminalSize | null => {
    const container = containerRef.current;
    const fitAddon = fitAddonRef.current;
    const terminal = termRef.current;
    if (!fitAddon || !terminal || !container) return null;
    lastFitFailureRef.current = null;
    try {
      return fitTerminalToContainer(fitAddon, terminal, container, {
        baseFontSize: resolveTerminalFontSize(terminalFontSize, !!agent),
        fixedCols,
        minCols: agent ? AGENT_MIN_TERMINAL_COLS : undefined,
        minFontSize: agent ? AGENT_MIN_TERMINAL_FONT_SIZE : undefined,
        minRows: agent ? AGENT_MIN_TERMINAL_ROWS : undefined,
        onFailure: (reason) => {
          lastFitFailureRef.current = reason;
        },
      });
    } catch {
      return null;
    }
  }, [agent, containerRef, fitAddonRef, fixedCols, termRef, terminalFontSize]);

  const getLastFitFailure = useCallback(() => lastFitFailureRef.current, []);

  const drainResize = useCallback(() => {
    if (pendingAttachSizeRef.current || pendingResizeRef.current) return;
    const requestedSize = queuedResizeRef.current;
    if (!requestedSize) return;
    if (isSameTerminalSize(lastSentSizeRef.current, requestedSize)) {
      queuedResizeRef.current = null;
      resizeAttemptRef.current = null;
      setTerminalFailure((failure) => failure?.kind === 'resize' ? null : failure);
      return;
    }

    const previousAttempt = resizeAttemptRef.current;
    const attempts = previousAttempt && isSameTerminalSize(previousAttempt.size, requestedSize)
      ? previousAttempt.attempts
      : 0;
    if (attempts >= MAX_RESIZE_ATTEMPTS) return;

    preemptPendingScroll();
    queuedResizeRef.current = null;
    const requestId = resizeRequestIdRef.current + 1;
    resizeRequestIdRef.current = requestId;
    resizeAttemptRef.current = { attempts: attempts + 1, size: requestedSize };
    pendingResizeRef.current = { ...requestedSize, requestId };

    const handleFailure = (error: unknown): void => {
      const pending = pendingResizeRef.current;
      if (pending?.requestId !== requestId || !isSameTerminalSize(pending, requestedSize)) return;
      pendingResizeRef.current = null;

      const message = error instanceof Error
        ? error.message
        : typeof error === 'string' && error
          ? error
          : 'Terminal resize failed';
      const attempt = resizeAttemptRef.current?.attempts ?? attempts + 1;
      rendererLog.warn('terminal', 'Terminal resize rejected', {
        attempt,
        cols: requestedSize.cols,
        error: message,
        paneId,
        rows: requestedSize.rows,
      });

      const latestSize = queuedResizeRef.current;
      if (latestSize && !isSameTerminalSize(latestSize, requestedSize)) {
        resizeAttemptRef.current = null;
        drainResizeRef.current();
        return;
      }
      if (attempt < MAX_RESIZE_ATTEMPTS) {
        queuedResizeRef.current = requestedSize;
        drainResizeRef.current();
        return;
      }

      queuedResizeRef.current = null;
      setTerminalFailure({ kind: 'resize', message });
    };

    void terminalApi.resize({ paneId, ...requestedSize })
      .then((response) => {
        const pending = pendingResizeRef.current;
        if (pending?.requestId !== requestId || !isSameTerminalSize(pending, requestedSize)) return;
        if (!response?.success) {
          handleFailure(response?.error);
          return;
        }

        pendingResizeRef.current = null;
        lastSentSizeRef.current = requestedSize;
        resizeAttemptRef.current = null;
        setTerminalFailure((failure) => failure?.kind === 'resize' ? null : failure);
        drainResizeRef.current();
      })
      .catch(handleFailure);
  }, [paneId, preemptPendingScroll, setTerminalFailure]);

  useEffect(() => {
    drainResizeRef.current = drainResize;
  }, [drainResize]);

  const requestResize = useCallback(() => {
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(() => {
      resizeTimerRef.current = null;
      if (!readyRef.current) return;
      const terminal = termRef.current;
      if (!terminal) return;
      const size = fit();
      if (!size) {
        if (lastFitFailureRef.current === 'too-narrow') {
          setTerminalFailure({ kind: 'narrow', message: NARROW_TERMINAL_FAILURE_MESSAGE });
        }
        return;
      }
      setTerminalFailure((failure) => (
        failure?.kind === 'fit' || failure?.kind === 'narrow' ? null : failure
      ));
      const last = lastAppliedSizeRef.current;
      const fontSize = terminal.options.fontSize ?? null;
      if (!isSameTerminalSize(last, size) || lastAppliedFontSizeRef.current !== fontSize) {
        lastAppliedSizeRef.current = { cols: size.cols, rows: size.rows };
        lastAppliedFontSizeRef.current = fontSize;
        refreshTerminalRenderer(terminal);
      }
      queuedResizeRef.current = { cols: size.cols, rows: size.rows };
      drainResizeRef.current();
    }, RESIZE_DEBOUNCE_MS);
  }, [fit, readyRef, setTerminalFailure, termRef]);

  const reset = useCallback(() => {
    lastAppliedFontSizeRef.current = null;
    lastAppliedSizeRef.current = null;
    lastSentSizeRef.current = null;
    pendingAttachSizeRef.current = null;
    pendingResizeRef.current = null;
    queuedResizeRef.current = null;
    resizeAttemptRef.current = null;
    resizeRequestIdRef.current += 1;
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = null;
  }, []);

  const setAttachPending = useCallback((size: TerminalSize | null) => {
    pendingAttachSizeRef.current = size;
  }, []);

  const recordAttachedSize = useCallback((size: TerminalSize, appliedFontSize?: number | null) => {
    pendingAttachSizeRef.current = null;
    lastSentSizeRef.current = size;
    if (appliedFontSize !== undefined) {
      lastAppliedSizeRef.current = size;
      lastAppliedFontSizeRef.current = appliedFontSize;
    }
  }, []);

  useEffect(() => reset, [reset]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      requestResize();
      setTimeout(requestResize, 0);
    });
    return () => cancelAnimationFrame(frame);
  }, [paneCount, requestResize]);

  useEffect(() => {
    const onWindowResize = () => requestResize();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') requestResize();
    };
    window.addEventListener('resize', onWindowResize);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('resize', onWindowResize);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [requestResize]);

  useEffect(() => {
    const eventName = 'change';
    let mediaQuery: MediaQueryList | null = null;
    let onChange: (() => void) | null = null;

    const subscribe = (): void => {
      if (typeof window.matchMedia !== 'function') return;
      mediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      onChange = () => {
        if (termRef.current) refreshTerminalRenderer(termRef.current);
        requestResize();
        mediaQuery?.removeEventListener(eventName, onChange!);
        subscribe();
      };
      mediaQuery.addEventListener(eventName, onChange);
    };

    subscribe();
    return () => {
      if (mediaQuery && onChange) mediaQuery.removeEventListener(eventName, onChange);
    };
  }, [requestResize, termRef]);

  return {
    fit,
    getLastFitFailure,
    recordAttachedSize,
    requestResize,
    reset,
    setAttachPending,
  };
}
