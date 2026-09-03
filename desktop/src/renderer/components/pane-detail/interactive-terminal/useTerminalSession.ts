import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import type { MuxBasePane } from 'muxbase/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TERMINAL_BACKGROUND_COLORS } from '../../../../shared/app-colors';
import { IPC_EVENT } from '../../../../shared/ipc-channels';
import type { TerminalDataEvent, TerminalStreamMode, TerminalStreamModeChangedEvent } from '../../../../shared/ipc-types';
import type { PaneActivity } from '../../../../shared/pane-activity';
import {
  createTerminalTheme,
  DEFAULT_TERMINAL_FONT_FAMILY,
  TERMINAL_LETTER_SPACING,
  TERMINAL_LINE_HEIGHT,
} from '../../../../shared/terminal-profile';
import { on } from '../../../api/ipc';
import { clipboardRead, clipboardWrite, openExternal } from '../../../api/system.api';
import * as terminalApi from '../../../api/terminal.api';
import { useTerminalThemeMode } from '../../../hooks/useAppThemeMode';
import { BOOT_TERMINAL_SELECTION_INTEGRATION_ENABLED } from '../../../lib/boot-settings';
import { formatAgentLabel } from '../../../lib/formatters';
import { getEffectivePaneStatus, isPaneWaitingForUser } from '../../../lib/pane-attention';
import { IS_MAC } from '../../../lib/platform';
import { playTerminalBell } from '../../../lib/terminal-bell';
import {
  createTerminalFileLinkProvider,
  type TerminalFileLinkTarget,
} from '../../../lib/terminal-file-links';
import { loadTerminalFonts } from '../../../lib/terminal-fonts';
import { TerminalInputSuppressor } from '../../../lib/terminal-input-suppression';
import { getTerminalKeyboardInputOverride, shouldSuppressDefaultShiftEnter } from '../../../lib/terminal-keyboard';
import { TerminalMouseModeStreamFilter } from '../../../lib/terminal-mouse-mode';
import { decodeOsc52ClipboardText } from '../../../lib/terminal-osc52';
import {
  attachTerminalSelectionAutoScroll,
  type TerminalSelectionPointer,
} from '../../../lib/terminal-selection-auto-scroll';
import {
  captureRepaintObservation,
  isReviewHighlightTruthful,
  restoreActiveGestureFromObservation,
  restoreGestureFromObservation,
  shouldAcknowledgeRepaint,
  type SelectionRepaintObservation,
} from '../../../lib/terminal-selection-finalizer';
import {
  advanceTerminalSelectionGesture,
  beginTerminalSelectionGesture,
  cancelTerminalSelectionGesture,
  claimTerminalSelectionGesture,
  completeTerminalSelectionGesture,
  isSameTerminalSelectionPosition,
  isTerminalSelectionCopyEligible,
  markTerminalSelectionGestureApplicationOwned,
  shouldCoordinateTerminalSelectionScroll,
  shouldInterceptTerminalSelectionCopy,
  shouldReviewTerminalSelectionScroll,
  type TerminalSelectionGesture,
} from '../../../lib/terminal-selection-gesture';
import {
  createTerminalSelectionScrollPump,
  type TerminalSelectionScrollPump,
} from '../../../lib/terminal-selection-scroll-pump';
import { activateTmuxAlignedUnicode } from '../../../lib/terminal-unicode';
import { applyTerminalViewportStyle } from '../../../lib/terminal-viewport-style';
import { resolveTerminalWheelAction, resolveSelectionWheelAction, resetSelectionWheelResidual, type SelectionWheelState, type TerminalWheelEventState } from '../../../lib/terminal-wheel';
import { rendererLog } from '../../../lib/rendererLog';
import { selectPaneActivity, useAgentSessionStore, useElectronSettingsStore, useNotificationStore, usePaneActivityStore, usePaneStore, useProjectStore, useTerminalStore, useWorkspaceTabsStore } from '../../../stores';
import type { ContextMenuPosition } from '../TerminalContextMenu';
import {
  accumulateSelectionSnapshot,
  getTerminalSelectionCell,
  getTerminalSelectionRange,
  MAX_ACCUMULATED_SELECTION_CHARS,
  NARROW_TERMINAL_FAILURE_MESSAGE,
  resolveOverlayPalette,
  resolveTerminalFontSize,
  type ScrolledTerminalSelection,
  type TerminalFailure,
} from './terminal-model';
import { useDelayedTerminalVisibility } from './useDelayedTerminalVisibility';
import { useTerminalBoot } from './useTerminalBoot';
import { useTerminalFind } from './useTerminalFind';
import { useTerminalResize } from './useTerminalResize';

type TerminalDebug = typeof import('../../../lib/terminalDebug').terminalDebug;

const FIT_RETRY_INTERVAL_MS = 50;
const FIT_MAX_RETRIES = 100; // 5 seconds max wait
export const ATTACH_REJECTION_BACKOFF_MS = [500, 1000, 2000, 3000, 4000, 5000];
export const RECONNECTING_NOTICE_DELAY_MS = 800;
const BOOT_READY_POLL_MS = 200;
const TERMINAL_HARD_RESET = '\x1bc';
const TERMINAL_MIN_RESIZE_COLS = 2;
const TERMINAL_MIN_RESIZE_ROWS = 2;
// Grace period before a hidden terminal releases its tmux stream, so quick tab
// round-trips never pay for a teardown/re-attach cycle.
export const TERMINAL_HIDDEN_DETACH_DELAY_MS = 2_500;
let nextTerminalStreamId = 1;

function isPaneActivityIdle(activity: PaneActivity | undefined): boolean {
  return activity?.state === 'idle';
}

function needsBootOverlay(pane: MuxBasePane, activity: PaneActivity | undefined): boolean {
  return !!pane.agent
    && !isPaneActivityIdle(activity)
    && !useTerminalStore.getState().seenPaneIds.has(pane.id);
}

export interface InteractiveTerminalProps {
  pane: MuxBasePane;
  terminalVisible?: boolean;
}

interface TerminalDisposable {
  dispose: () => void;
}

interface PendingTmuxScroll {
  direction: 'down' | 'up' | null;
  lines: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface PendingAttachChunk {
  data: string;
  isReplay: boolean;
  streamId: number;
}

interface PendingAttachBuffer {
  byteLength: number;
  chunks: PendingAttachChunk[];
}

function refreshTerminalRenderer(terminal: Terminal): void {
  terminal.refresh(0, Math.max(0, terminal.rows - 1));
}

function canTransferFocusToTerminal(container: HTMLElement): boolean {
  if (container.closest('[aria-hidden="true"]')) return false;

  const activeElement = document.activeElement;
  return activeElement === null
    || activeElement === document.body
    || activeElement === document.documentElement
    || activeElement.classList.contains('xterm-helper-textarea');
}

const TMUX_SCROLL_FLUSH_MS = 40;
const FULLSCREEN_CLAUDE_SCROLL_SENSITIVITY = 1.25;
const SELECTION_REPAINT_SETTLE_MS = 32;
const ATTACH_BUFFER_MAX_BYTES = 1024 * 1024;
const ATTACH_RESPONSE_TIMEOUT_MS = 10_000;
const FIT_FAILURE_MESSAGE = 'Terminal could not measure the pane. Resize it or reconnect to try again.';
const RECONNECTING_MESSAGE = 'Terminal is not ready yet. Retrying automatically...';
const INCOMPLETE_COPY_MESSAGE = 'Copy was canceled to avoid placing incomplete text on the clipboard.';
const INCOMPLETE_COPY_DETAIL = 'Try selecting the range again or choose a smaller range.';
const INCOMPLETE_COPY_TITLE = 'Selection could not be copied completely';

export function useTerminalSession({ pane, terminalVisible = true }: InteractiveTerminalProps) {
  const selectionIntegrationEnabled = pane.agent !== 'claude'
    || BOOT_TERMINAL_SELECTION_INTEGRATION_ENABLED;
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const themeMode = useTerminalThemeMode();
  const themeModeRef = useRef(themeMode);
  const overlayPalette = useMemo(() => resolveOverlayPalette(themeMode), [themeMode]);
  const terminalBackgroundStyle = useMemo(
    () => ({ backgroundColor: overlayPalette.background }),
    [overlayPalette.background],
  );
  const readyRef = useRef(false);
  const stdinUnlockedRef = useRef(false);
  const seenOutputRef = useRef(false);
  const streamIdRef = useRef<number | null>(null);
  const streamModeRef = useRef<TerminalStreamMode | null>(null);
  const inputSuppressorRef = useRef<TerminalInputSuppressor | null>(null);
  const pendingAttachWritesRef = useRef<PendingAttachBuffer | null>(null);
  const pendingTmuxScrollRef = useRef<PendingTmuxScroll>({ direction: null, lines: 0, timer: null });
  const scrolledSelectionRef = useRef<ScrolledTerminalSelection | null>(null);
  const selectionGestureRef = useRef<TerminalSelectionGesture | null>(null);
  const selectionGenerationRef = useRef(0);
  const selectionFinalizationRef = useRef<Promise<void> | null>(null);
  const finalizeTerminalSelectionRef = useRef<(() => Promise<void>) | null>(null);
  const selectionRepaintRef = useRef(false);
  const visualSelectionUpdateRef = useRef(false);
  const selectionScrollPumpRef = useRef<TerminalSelectionScrollPump | null>(null);
  const wheelStateRef = useRef<TerminalWheelEventState>({ residualDeltaY: 0 });
  const selectionWheelStateRef = useRef<SelectionWheelState>({ selectionResidualDeltaY: 0 });
  const selectionRepaintObservationRef = useRef<SelectionRepaintObservation | null>(null);
  const cancelPendingTmuxScrollBatch = useCallback(() => {
    const pending = pendingTmuxScrollRef.current;
    pending.lines = 0;
    if (pending.timer) clearTimeout(pending.timer);
    pending.direction = null;
    pending.timer = null;
  }, []);
  const preemptPendingTmuxScroll = useCallback(() => {
    cancelPendingTmuxScrollBatch();
    wheelStateRef.current.residualDeltaY = 0;
  }, [cancelPendingTmuxScrollBatch]);
  const [contextMenu, setContextMenu] = useState<ContextMenuPosition | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const [pendingLink, setPendingLink] = useState<{ url: string; x: number; y: number } | null>(null);
  const [terminalFailure, commitTerminalFailure] = useState<TerminalFailure | null>(null);
  const terminalFailureRef = useRef<TerminalFailure | null>(null);
  const setTerminalFailure = useCallback((
    update: TerminalFailure | null | ((current: TerminalFailure | null) => TerminalFailure | null),
  ): void => {
    const current = terminalFailureRef.current;
    const next = typeof update === 'function' ? update(current) : update;
    if (current?.kind === next?.kind && current?.message === next?.message) return;
    terminalFailureRef.current = next;
    commitTerminalFailure(next);
  }, []);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const effectiveVisible = useDelayedTerminalVisibility(
    terminalVisible,
    TERMINAL_HIDDEN_DETACH_DELAY_MS,
  );

  const requestOpenLink = useCallback((event: MouseEvent, uri: string) => {
    setPendingLink({ url: uri, x: event.clientX, y: event.clientY });
  }, []);
  const closeLinkPrompt = useCallback(() => setPendingLink(null), []);
  const confirmOpenLink = useCallback(() => {
    const uri = pendingLink?.url;
    setPendingLink(null);
    if (!uri) return;
    void openExternal(uri).catch((error) => {
      rendererLog.warn('terminal', 'Failed to open terminal link', { error, uri });
    });
  }, [pendingLink]);
  const attachPane = useTerminalStore((s) => s.attachPane);
  const showSessionEmptyState = useAgentSessionStore((state) => {
    const session = state.sessions[pane.id];
    return session !== undefined && session.messages.length === 0;
  });
  const markPaneSeen = useTerminalStore((s) => s.markPaneSeen);
  const detachPane = useTerminalStore((s) => s.detachPane);
  const addToast = useNotificationStore((s) => s.addToast);
  const openFileAtLine = useWorkspaceTabsStore((s) => s.openFileAtLine);
  const sessionName = useProjectStore((s) => s.sessionName);
  const isCreatingPane = usePaneStore((s) => s.isCreating);
  const terminalFontFamily = useElectronSettingsStore((s) => s.settings?.terminalFontFamily);
  const terminalFontSize = useElectronSettingsStore((s) => s.settings?.terminalFontSize);
  const terminalTransport = useElectronSettingsStore((s) => s.settings?.terminalTransport);
  const cursorBlink = useElectronSettingsStore((s) => s.settings?.cursorBlink);
  const cursorStyle = useElectronSettingsStore((s) => s.settings?.cursorStyle);
  const scrollbackLines = useElectronSettingsStore((s) => s.settings?.scrollbackLines);
  const copyOnSelect = useElectronSettingsStore((s) => s.settings?.copyOnSelect ?? false);
  const opencodeMousePassthrough = useElectronSettingsStore((s) => s.settings?.opencodeMousePassthrough ?? false);
  const terminalOsc52Clipboard = useElectronSettingsStore((s) => s.settings?.terminalOsc52Clipboard ?? 'off');
  const terminalBell = useElectronSettingsStore((s) => s.settings?.terminalBell ?? false);
  const copyOnSelectRef = useRef(copyOnSelect);
  useEffect(() => { copyOnSelectRef.current = copyOnSelect; }, [copyOnSelect]);
  const terminalBellRef = useRef(terminalBell);
  useEffect(() => { terminalBellRef.current = terminalBell; }, [terminalBell]);

  const bootActivity = usePaneActivityStore((state) => state.activityByPaneId[pane.id]);
  const sessionWaiting = useAgentSessionStore((state) => {
    const session = state.sessions[pane.id];
    return isPaneWaitingForUser(
      pane,
      session,
      getEffectivePaneStatus(pane, session, bootActivity),
    );
  });

  const isCreatingPaneRef = useRef(isCreatingPane);
  useEffect(() => { isCreatingPaneRef.current = isCreatingPane; }, [isCreatingPane]);

  const focusTerminal = useCallback(() => {
    termRef.current?.focus();
  }, []);

  const blurTerminal = useCallback(() => {
    try { termRef.current?.blur(); } catch { /* noop */ }
  }, []);

  const {
    caseSensitive: findCaseSensitive,
    close: handleFindClose,
    onResultsChanged: handleFindResultsChanged,
    open: openFind,
    opened: findOpen,
    openedRef: findOpenRef,
    query: findQuery,
    result: findResult,
    runFind,
    setQuery: setFindQuery,
    toggleCaseSensitive: toggleFindCaseSensitive,
  } = useTerminalFind({
    activeMatchBorder: overlayPalette.foreground,
    blurTerminal,
    focusTerminal,
    searchAddonRef,
  });

  const focusSelectedTerminal = useCallback(() => {
    const container = containerRef.current;
    if (!container || isCreatingPaneRef.current || findOpenRef.current) return;
    if (usePaneStore.getState().selectedPaneId !== pane.id) return;
    if (!canTransferFocusToTerminal(container)) return;
    termRef.current?.focus();
  }, [findOpenRef, pane.id]);

  const isSelectedPane = usePaneStore((s) => s.selectedPaneId === pane.id);
  useEffect(() => {
    if (!isSelectedPane || isCreatingPane) return;
    const frame = requestAnimationFrame(focusSelectedTerminal);
    return () => cancelAnimationFrame(frame);
  }, [focusSelectedTerminal, isCreatingPane, isSelectedPane]);

  const terminalFileRoot = pane.worktreePath ?? pane.projectRoot;
  const openTerminalFileLink = useCallback((target: TerminalFileLinkTarget, event: MouseEvent) => {
    event.preventDefault();
    if (!terminalFileRoot) return;
    void openFileAtLine(pane.id, terminalFileRoot, target.relativePath, target.lineNumber, '');
  }, [openFileAtLine, pane.id, terminalFileRoot]);

  const unlockTerminalInput = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    if (isCreatingPaneRef.current) return;
    if (terminalFailureRef.current || pendingAttachWritesRef.current || streamIdRef.current === null) return;
    if (stdinUnlockedRef.current) return;
    stdinUnlockedRef.current = true;
    term.options.disableStdin = false;
    terminalApi.unlockStdin({ paneId: pane.id });
  }, [pane.id]);

  const lockTerminalInput = useCallback(() => {
    stdinUnlockedRef.current = false;
    const term = termRef.current;
    if (term) term.options.disableStdin = true;
  }, []);

  const {
    booting,
    bootingRef,
    bootPhase,
    clearMinimumUnlockTimer: clearMinBootUnlockTimer,
    onTerminalInput: handleBootTerminalInput,
    onTerminalOutput: handleBootTerminalOutput,
    outputTailRef,
    reset: resetBoot,
    startupCompleteRef,
    tryCompleteIfReady: tryCompleteBootIfReady,
  } = useTerminalBoot({
    activityIdle: isPaneActivityIdle(bootActivity),
    agent: pane.agent,
    initialBooting: needsBootOverlay(pane, selectPaneActivity(pane.id)),
    lockInput: lockTerminalInput,
    sessionWaiting,
    terminalFailure: terminalFailure !== null,
    unlockInput: unlockTerminalInput,
  });

  const resetScrolledSelection = useCallback(() => {
    scrolledSelectionRef.current = null;
    selectionScrollPumpRef.current?.cancel();
    selectionFinalizationRef.current = null;
    selectionGenerationRef.current += 1;
  }, []);

  const copyTerminalSelection = useCallback(async (selection?: string): Promise<void> => {
    const requestedRange = scrolledSelectionRef.current;
    const finalizeSelection = finalizeTerminalSelectionRef.current;
    if (requestedRange && finalizeSelection) {
      await finalizeSelection();
      if (scrolledSelectionRef.current !== requestedRange) return;
    }

    const scrolledSelection = scrolledSelectionRef.current;
    const gesture = selectionGestureRef.current;
    if (gesture?.owner === 'application') return;

    const currentText = selection ?? termRef.current?.getSelection() ?? '';

    if (!scrolledSelection) {
      if (!currentText) return;
      try {
        await clipboardWrite(currentText);
      } catch (error) {
        rendererLog.warn('terminal', 'Failed to copy terminal selection', { error, paneId: pane.id });
      }
      return;
    }

    const generation = ++selectionGenerationRef.current;

    if (gesture?.phase === 'canceled') {
      addToast(INCOMPLETE_COPY_MESSAGE, 'warning', {
        detail: INCOMPLETE_COPY_DETAIL,
        title: INCOMPLETE_COPY_TITLE,
      });
      return;
    }

    if (scrolledSelection.reversalInvalidated) {
      addToast(INCOMPLETE_COPY_MESSAGE, 'warning', {
        detail: INCOMPLETE_COPY_DETAIL,
        title: INCOMPLETE_COPY_TITLE,
      });
      return;
    }

    if (!scrolledSelection.complete) {
      accumulateSelectionSnapshot(scrolledSelection, currentText);
      scrolledSelection.complete = true;
    }

    const isPty = streamModeRef.current === 'pty';
    const hasVerifiedClientRange = scrolledSelection.rangeVerified
      && scrolledSelection.accumulatedText !== null;
    let clipboardCandidate: string | null = hasVerifiedClientRange
      ? scrolledSelection.accumulatedText
      : null;

    if (isPty && clipboardCandidate === null) {
      try {
        const response = await terminalApi.expandSelection({
          anchorText: scrolledSelection.anchorText,
          currentText,
          direction: scrolledSelection.direction,
          paneId: pane.id,
        });
        if (selectionGenerationRef.current !== generation) return;
        switch (response.status) {
          case 'expanded':
            clipboardCandidate = response.text;
            break;
          case 'history-unavailable':
            break;
          case 'range-not-found':
            break;
          default: {
            const unhandledResponse: never = response;
            throw new Error(`Unhandled terminal selection response: ${JSON.stringify(unhandledResponse)}`);
          }
        }
      } catch (error) {
        rendererLog.warn('terminal', 'Failed to expand scrolled terminal selection', {
          error,
          paneId: pane.id,
        });
      }
    }

    if (selectionGenerationRef.current !== generation) return;
    if (clipboardCandidate === null) {
      addToast(INCOMPLETE_COPY_MESSAGE, 'warning', {
        detail: INCOMPLETE_COPY_DETAIL,
        title: INCOMPLETE_COPY_TITLE,
      });
      return;
    }
    try {
      await clipboardWrite(clipboardCandidate);
    } catch (error) {
      rendererLog.warn('terminal', 'Failed to copy terminal selection', { error, paneId: pane.id });
    }
  }, [addToast, pane.id]);

  const handleCopy = useCallback(() => {
    void copyTerminalSelection();
  }, [copyTerminalSelection]);

  const handleSelectAll = useCallback(() => {
    resetScrolledSelection();
    selectionGestureRef.current = null;
    termRef.current?.selectAll();
  }, [resetScrolledSelection]);

  const fixedCols = pane.terminalFixedCols;
  const paneCount = usePaneStore((state) => state.panes.length);
  const {
    fit,
    getLastFitFailure,
    recordAttachedSize,
    requestResize,
    reset: resetResize,
    setAttachPending,
  } = useTerminalResize({
    agent: pane.agent,
    containerRef,
    fitAddonRef,
    fixedCols,
    paneCount,
    paneId: pane.id,
    preemptPendingScroll: preemptPendingTmuxScroll,
    readyRef,
    setTerminalFailure,
    terminalFontSize,
    termRef,
  });

  const handlePaste = useCallback(async () => {
    const term = termRef.current;
    const inputSuppressor = inputSuppressorRef.current;
    if (
      !term
      || term.options.disableStdin
      || !inputSuppressor?.canForwardInput()
    ) return;
    const suppressionEpoch = inputSuppressor.getSuppressionEpoch();
    const text = await clipboardRead();
    if (
      !text
      || termRef.current !== term
      || inputSuppressorRef.current !== inputSuppressor
      || term.options.disableStdin
      || !inputSuppressor.canForwardInput()
      || inputSuppressor.getSuppressionEpoch() !== suppressionEpoch
    ) return;
    preemptPendingTmuxScroll();
    terminalApi.write({ paneId: pane.id, data: text, userInitiated: true });
  }, [pane.id, preemptPendingTmuxScroll]);

  const requestOsc52ClipboardWrite = useCallback((text: string) => {
    if (terminalOsc52Clipboard !== 'allow') return;
    void clipboardWrite(text).catch((error) => {
      rendererLog.warn('terminal', 'Failed to write OSC 52 clipboard request', { error, paneId: pane.id });
    });
  }, [pane.id, terminalOsc52Clipboard]);

  // Auxiliary resize signals. ResizeObserver alone misses some cases where
  // react-resizable-panels redistributes width via flex/grid without triggering
  // an observed mutation on this pane's container (e.g. when a sibling pane is
  // added or closed). Subscribing to pane count + window resize +
  // visibilitychange + animation frames covers those gaps and keeps the
  // running shell's `cols`/`rows` in sync with what the user actually sees.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !effectiveVisible) return;

    // Reset boot overlay on pane changes/mount.
    seenOutputRef.current = false;
    const shouldShowBootOverlay = needsBootOverlay(pane, selectPaneActivity(pane.id));
    resetBoot(shouldShowBootOverlay);
    stdinUnlockedRef.current = false;
    setTerminalFailure(null);
    resetResize();

    // Readiness is otherwise re-evaluated only when a frame arrives, so a TUI
    // that paints then goes quiet could hang. Poll the current tail as a
    // level-triggered self-heal until boot completes.
    let bootReadyPoll: ReturnType<typeof setInterval> | null = shouldShowBootOverlay
      ? setInterval(() => {
        if (startupCompleteRef.current) {
          if (bootReadyPoll) clearInterval(bootReadyPoll);
          bootReadyPoll = null;
          return;
        }
        tryCompleteBootIfReady(outputTailRef.current);
      }, BOOT_READY_POLL_MS)
      : null;

    const resolvedTerminalFontFamily = terminalFontFamily || DEFAULT_TERMINAL_FONT_FAMILY;
    const resolvedTerminalFontSize = resolveTerminalFontSize(terminalFontSize, !!pane.agent);
    const usesRawTerminalStream = terminalTransport === 'pty' || !!pane.terminalTranscriptPath;
    const term = new Terminal({
      // Required by @xterm/addon-search, which paints match highlights via
      // term.registerDecoration() — that API is still flagged "proposed" in
      // xterm 6. Without this, every find call throws and `onDidChangeResults`
      // never fires, so the overlay's counter stays "No results".
      allowProposedApi: true,
      theme: createTerminalTheme(themeModeRef.current),
      fontFamily: resolvedTerminalFontFamily,
      fontSize: resolvedTerminalFontSize,
      lineHeight: TERMINAL_LINE_HEIGHT,
      letterSpacing: TERMINAL_LETTER_SPACING,
      cursorBlink: cursorBlink ?? true,
      cursorStyle: cursorStyle || 'block',
      scrollback: scrollbackLines ?? 10000,
      linkHandler: { activate: requestOpenLink },
      allowTransparency: false,
      customGlyphs: true,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 4.5,
      // OpenCode/tmux-style TUIs can enable mouse tracking, which makes xterm
      // send drags to the app instead of creating a selection. This preserves
      // the terminal-native escape hatch: Option+drag selects text on macOS.
      macOptionClickForcesSelection: true,
      // PTY and transcript-backed panes both deliver raw ANSI byte streams from
      // tmux. Converting LF -> CRLF corrupts full-screen redraw semantics and
      // can visually duplicate headers/frames in scrollback.
      convertEol: !usesRawTerminalStream,
      // Prevent stray keystrokes during agent startup (and during modal flows)
      // from being sent into tmux. (This can otherwise show up as "gibberish"
      // above the agent header.)
      disableStdin: true,
      // Apply a modest sensitivity boost only for fullscreen Claude, which
      // uses xterm mouse reporting. Small trackpad deltas otherwise have a
      // perceptible dead zone. Classic Claude, OpenCode, and shell panes stay
      // at the default (1.0) to avoid over-scrolling their viewport or tmux
      // copy-mode.
      scrollSensitivity: pane.agent === 'claude' && pane.claudeRenderer === 'fullscreen'
        ? FULLSCREEN_CLAUDE_SCROLL_SENSITIVITY
        : 1,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    const bellDisposer = term.onBell(() => {
      if (terminalBellRef.current) playTerminalBell();
    });
    let disposed = false;
    let cleanupDone = false;
    let attachFrame: number | null = null;
    let attachRejectionTimer: ReturnType<typeof setTimeout> | null = null;
    let attachResponseTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectingNoticeTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshVisualSelectionAfterWrite: (() => void) | null = null;
    let dataDisposer: TerminalDisposable | null = null;
    let inputSuppressor: TerminalInputSuppressor | null = null;
    let keyDisposer: TerminalDisposable | null = null;
    let observer: ResizeObserver | null = null;
    let onCopy: ((event: ClipboardEvent) => void) | null = null;
    let onClick: ((event: MouseEvent) => void) | null = null;
    let onContextMenu: ((event: MouseEvent) => void) | null = null;
    let onMouseDown: ((event: MouseEvent) => void) | null = null;
    let onPaste: ((event: Event) => void) | null = null;
    let onWheel: ((event: WheelEvent) => void) | null = null;
    let fileLinkDisposer: TerminalDisposable | null = null;
    let osc52Disposer: TerminalDisposable | null = null;
    let retryTimer: ReturnType<typeof setInterval> | null = null;
    let searchResultsDisposer: TerminalDisposable | null = null;
    let selectionDisposer: TerminalDisposable | null = null;
    let selectionAutoScrollDisposer: (() => void) | null = null;
    let selectionReachedScrollEdge = false;
    let selectionRepaintSettleTimer: ReturnType<typeof setTimeout> | null = null;
    let selectionScrollPump: TerminalSelectionScrollPump | null = null;
    let terminalHardResetTail = '';
    let unsubscribe: (() => void) | null = null;
    let unsubscribeRendererReset: (() => void) | null = null;
    let unsubscribeStreamMode: (() => void) | null = null;
    let webglAddon: WebglAddon | null = null;
    let webglContextLossDisposer: TerminalDisposable | null = null;
    const wheelListenerOptions: AddEventListenerOptions = { capture: true, passive: false };
    const terminalDebugPromise = (
      (window as typeof window & { __MUXBASE_E2E?: boolean }).__MUXBASE_E2E === true
      || (
        (import.meta as ImportMeta & { env: { DEV: boolean } }).env.DEV
        && window.location.search.includes('e2e=1')
      )
    ) && import('../../../lib/terminalDebug');
    let terminalDebug: TerminalDebug | undefined;
    const clearReconnectingNoticeTimer = (): void => {
      if (reconnectingNoticeTimer === null) return;
      clearTimeout(reconnectingNoticeTimer);
      reconnectingNoticeTimer = null;
    };

    const cleanupTerminal = () => {
      if (cleanupDone) return;
      cleanupDone = true;
      resetScrolledSelection();
      selectionScrollPump?.cancel();
      if (selectionScrollPumpRef.current === selectionScrollPump) {
        selectionScrollPumpRef.current = null;
      }
      if (onPaste) container.removeEventListener('paste', onPaste);
      if (onCopy) container.removeEventListener('copy', onCopy, true);
      if (onWheel) container.removeEventListener('wheel', onWheel, wheelListenerOptions);
      if (onClick) container.removeEventListener('click', onClick);
      if (onContextMenu) container.removeEventListener('contextmenu', onContextMenu);
      if (onMouseDown) container.removeEventListener('mousedown', onMouseDown);
      if (attachFrame !== null) cancelAnimationFrame(attachFrame);
      if (attachRejectionTimer !== null) clearTimeout(attachRejectionTimer);
      if (attachResponseTimer !== null) clearTimeout(attachResponseTimer);
      if (selectionRepaintSettleTimer !== null) clearTimeout(selectionRepaintSettleTimer);
      clearReconnectingNoticeTimer();
      pendingAttachWritesRef.current = null;
      terminalHardResetTail = '';
      refreshVisualSelectionAfterWrite = null;
      if (retryTimer) clearInterval(retryTimer);
      if (bootReadyPoll) clearInterval(bootReadyPoll);
      observer?.disconnect();
      bellDisposer.dispose();
      dataDisposer?.dispose();
      fileLinkDisposer?.dispose();
      keyDisposer?.dispose();
      osc52Disposer?.dispose();
      selectionDisposer?.dispose();
      selectionAutoScrollDisposer?.();
      searchResultsDisposer?.dispose();
      webglContextLossDisposer?.dispose();
      webglAddon?.dispose();
      unsubscribe?.();
      unsubscribeRendererReset?.();
      unsubscribeStreamMode?.();
      clearMinBootUnlockTimer();
      if (streamIdRef.current !== null) {
        terminalApi.detach({ paneId: pane.id });
        detachPane(pane.id);
      }
      inputSuppressor?.dispose();
      if (inputSuppressorRef.current === inputSuppressor) {
        inputSuppressorRef.current = null;
      }
      term.dispose();
      terminalDebug?.attach(pane.id, streamIdRef.current, 'detach');
      terminalDebug?.unregister(pane.id);
      preemptPendingTmuxScroll();
      termRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      resetResize();
      streamIdRef.current = null;
      streamModeRef.current = null;
      selectionGestureRef.current = null;
      finalizeTerminalSelectionRef.current = null;
      selectionRepaintRef.current = false;
      visualSelectionUpdateRef.current = false;
      readyRef.current = false;
    };

    void (async () => {
      try {
        if (terminalDebugPromise) terminalDebug = (await terminalDebugPromise).terminalDebug;
        if (disposed) return;
        await loadTerminalFonts(resolvedTerminalFontFamily, resolvedTerminalFontSize);
        if (disposed) return;

        term.open(container);

        try {
          const addon = new WebglAddon();
          webglAddon = addon;
          const fallbackFromWebgl = (reason: 'context-loss' | 'gpu-process-reset'): void => {
            if (webglAddon !== addon) return;
            webglContextLossDisposer?.dispose();
            webglContextLossDisposer = null;
            webglAddon = null;
            addon.dispose();
            term.refresh(0, Math.max(0, term.rows - 1));
            rendererLog.info('terminal', 'WebGL renderer reset; restored built-in renderer', {
              paneId: pane.id,
              reason,
            });
          };
          webglContextLossDisposer = addon.onContextLoss(() => fallbackFromWebgl('context-loss'));
          term.loadAddon(addon);
          unsubscribeRendererReset = on(
            IPC_EVENT.TERMINAL_RENDERER_RESET,
            () => fallbackFromWebgl('gpu-process-reset'),
          );
        } catch (error) {
          webglContextLossDisposer?.dispose();
          webglContextLossDisposer = null;
          webglAddon?.dispose();
          webglAddon = null;
          rendererLog.info('terminal', 'WebGL unavailable; using built-in renderer', {
            error,
            paneId: pane.id,
          });
        }
        applyTerminalViewportStyle(term, TERMINAL_BACKGROUND_COLORS[themeModeRef.current]);
        // xterm core ships Unicode 6 width tables, but tmux and modern TUIs
        // (go-runewidth, Ink) measure emoji, flags, and ZWJ clusters with
        // current Unicode widths — every emoji-decorated line would render
        // one cell short and break box borders. Match tmux exactly.
        activateTmuxAlignedUnicode(term);
        term.loadAddon(new WebLinksAddon(requestOpenLink));
        osc52Disposer = term.parser.registerOscHandler(52, (data) => {
          const text = decodeOsc52ClipboardText(data);
          if (text !== null) {
            requestOsc52ClipboardWrite(text);
          }
          return true;
        });
        if (terminalFileRoot) {
          fileLinkDisposer = term.registerLinkProvider(createTerminalFileLinkProvider({
            onOpen: openTerminalFileLink,
            rootPath: terminalFileRoot,
            terminal: term,
          }));
        }
        const searchAddon = new SearchAddon();
        term.loadAddon(searchAddon);
        searchAddonRef.current = searchAddon;
        searchResultsDisposer = searchAddon.onDidChangeResults((e) => {
          handleFindResultsChanged(e);
        });

        const activeInputSuppressor = new TerminalInputSuppressor();
        const openCodeMouseModeFilter = new TerminalMouseModeStreamFilter();
        let pendingUserKey = false;
        let pendingUserKeyGeneration = 0;
        const markPendingUserKey = () => {
          pendingUserKey = true;
          const generation = ++pendingUserKeyGeneration;
          queueMicrotask(() => {
            if (pendingUserKeyGeneration === generation) {
              pendingUserKey = false;
            }
          });
        };
        const consumePendingUserKey = () => {
          const userInitiated = pendingUserKey;
          pendingUserKey = false;
          return userInitiated;
        };
        inputSuppressor = activeInputSuppressor;
        inputSuppressorRef.current = activeInputSuppressor;
        // Unlike onData, onKey is emitted only for keyboard input and fires
        // immediately before the matching data event. Protocol replies such as
        // DA/DSR still use onData but deliberately bypass this marker.
        keyDisposer = term.onKey(markPendingUserKey);
        term.attachCustomKeyEventHandler((event) => {
          const meta = event.metaKey || event.ctrlKey;
          const isCopyShortcut = IS_MAC ? event.metaKey : event.ctrlKey;
          if (
            event.type === 'keydown'
            && isCopyShortcut
            && event.key.toLowerCase() === 'c'
            && shouldInterceptTerminalSelectionCopy(
              selectionGestureRef.current,
              scrolledSelectionRef.current !== null,
            )
          ) {
            event.preventDefault();
            event.stopPropagation();
            void copyTerminalSelection();
            return false;
          }
          // Cmd/Ctrl+F → open the find overlay. Plain F (or Cmd+Shift+F, which is
          // the diff filter shortcut) is left for xterm / global handlers.
          if (event.type === 'keydown' && meta && !event.shiftKey && event.key === 'f') {
            event.preventDefault();
            event.stopPropagation();
            openFind();
            return false;
          }
          if (event.type === 'keydown' && event.key === 'Escape' && findOpenRef.current) {
            // Allow the overlay's own Esc handler to close it; just don't let
            // xterm forward the keystroke to tmux.
            return false;
          }
          const inputOverride = getTerminalKeyboardInputOverride(event, pane.agent);
          const suppressDefault = shouldSuppressDefaultShiftEnter(event, pane.agent);
          if (event.type === 'keydown') {
            usePaneActivityStore.getState().acknowledgeFinished(pane.id);
            if (inputOverride && !term.options.disableStdin && activeInputSuppressor.canForwardInput()) {
              preemptPendingTmuxScroll();
              terminalApi.write({ paneId: pane.id, data: inputOverride, userInitiated: true });
            }
          }
          if (!event.metaKey) {
            // DOM propagation is separate from xterm's handler gate: returning
            // true below still lets xterm encode macOS Control+C as ETX.
            event.stopPropagation();
          }
          return !suppressDefault;
        });
        // The re-theme effect skips a terminal that is not registered yet, so a
        // theme switch during the font load above would never reach this grid.
        term.options.theme = createTerminalTheme(themeModeRef.current);
        termRef.current = term;
        fitAddonRef.current = fitAddon;
        terminalDebug?.register(pane.id, term);
        requestAnimationFrame(focusSelectedTerminal);
        let failPendingAttach: ((message: string) => void) | null = null;
        const prepareTerminalData = (data: string): string => {
          const shouldStripOpenCodeMouseControls = pane.agent === 'opencode'
            && !(opencodeMousePassthrough && streamModeRef.current === 'pty');
          return shouldStripOpenCodeMouseControls
            ? openCodeMouseModeFilter.push(data)
            : data;
        };

        unsubscribe = on(IPC_EVENT.TERMINAL_DATA, (event: unknown) => {
          const e = event as TerminalDataEvent;
          if (e.paneId !== pane.id || !readyRef.current) return;
          if (e.streamId !== streamIdRef.current) {
            terminalDebug?.drop(pane.id, e.streamId, streamIdRef.current);
            return;
          }

          const isReplay = e.source === 'replay';
          // Until the attach response delivers the pane's authoritative grid,
          // hold RAW output: transport mode also decides whether OpenCode mouse
          // controls must be filtered. Transforming before the attach response
          // could split one control sequence across two different policies.
          const pendingWrites = pendingAttachWritesRef.current;
          if (pendingWrites) {
            const nextByteLength = pendingWrites.byteLength + new TextEncoder().encode(e.data).byteLength;
            if (nextByteLength > ATTACH_BUFFER_MAX_BYTES) {
              failPendingAttach?.('Terminal attach output exceeded the safe buffer before geometry was confirmed.');
              return;
            }
            pendingWrites.byteLength = nextByteLength;
            pendingWrites.chunks.push({ data: e.data, isReplay, streamId: e.streamId });
            return;
          }
          const terminalData = prepareTerminalData(e.data);
          if (terminalData.length === 0) return;
          commitStreamData(terminalData, isReplay, e.streamId);
        });

        unsubscribeStreamMode = on(IPC_EVENT.TERMINAL_STREAM_MODE_CHANGED, (event: unknown) => {
          const e = event as TerminalStreamModeChangedEvent;
          if (e.paneId !== pane.id || e.streamId !== streamIdRef.current) return;
          streamModeRef.current = e.mode;
          terminalHardResetTail = '';
          resetScrolledSelection();
          selectionGestureRef.current = null;
          selectionRepaintObservationRef.current = null;
          resetSelectionWheelResidual(selectionWheelStateRef.current);
          visualSelectionUpdateRef.current = true;
          try {
            term.clearSelection();
          } finally {
            visualSelectionUpdateRef.current = false;
          }
        });

      const settleReviewStep = (observation: SelectionRepaintObservation): void => {
        if (!selectionScrollPump) return;
        selectionRepaintObservationRef.current = null;
        if (!renderAndVerifyFrozenHighlight()) {
          const currentGesture = selectionGestureRef.current;
          if (currentGesture) {
            selectionGestureRef.current = restoreGestureFromObservation(currentGesture, observation);
          }
          renderAndVerifyFrozenHighlight();
          selectionScrollPump.cancel();
          return;
        }
        selectionScrollPump.acknowledgeRepaint();
      };

      const scheduleSelectionRepaintSettlement = (): void => {
        if (selectionRepaintSettleTimer !== null) clearTimeout(selectionRepaintSettleTimer);
        selectionRepaintSettleTimer = setTimeout(() => {
          selectionRepaintSettleTimer = null;
          if (!selectionScrollPump || selectionScrollPump.pendingUnits() === 0) return;
          const observation = selectionRepaintObservationRef.current;
          if (observation?.purpose === 'review') {
            settleReviewStep(observation);
            return;
          }
          const scrolledSelection = scrolledSelectionRef.current;
          if (!scrolledSelection || scrolledSelection.complete) return;
          if (observation && !term.hasSelection()) updateVisualSelection();
          const mergeResult = accumulateSelectionSnapshot(
            scrolledSelection,
            term.getSelection(),
          );
          if (!observation) {
            if (mergeResult !== 'unchanged') selectionScrollPump.acknowledgeRepaint();
            return;
          }
          if (mergeResult === 'unverified') observation.sawUnverifiedFrame = true;
          if (shouldAcknowledgeRepaint(mergeResult)) {
            selectionRepaintObservationRef.current = null;
            selectionScrollPump.acknowledgeRepaint();
          }
        }, SELECTION_REPAINT_SETTLE_MS);
      };

      const writeStreamData = (terminalData: string, isReplay: boolean, streamId: number) => {
        let hasHardReset = false;
        let preservesVisualSelection = false;
        let savedViewport = 0;
        let wasAtBottom = false;
        const beforeWriteSnapshot = terminalDebug?.capture(term);
        activeInputSuppressor.write(term, terminalData, isReplay, {
          beforeWrite: () => {
            const buf = term.buffer.active;
            // Alternate-screen clear/redraw sequences briefly empty xterm's
            // selection before updateVisualSelection restores the viewport.
            preservesVisualSelection = !!scrolledSelectionRef.current
              && !!selectionGestureRef.current?.ownsVisualSelection;
            selectionRepaintRef.current = preservesVisualSelection;
            hasHardReset = terminalData.includes(TERMINAL_HARD_RESET)
              || (terminalHardResetTail === '\x1b' && terminalData.startsWith('c'));
            terminalHardResetTail = terminalData.endsWith('\x1b') ? '\x1b' : '';
            if (hasHardReset) {
              resetScrolledSelection();
              selectionGestureRef.current = null;
              selectionRepaintObservationRef.current = null;
              resetSelectionWheelResidual(selectionWheelStateRef.current);
              preservesVisualSelection = false;
              selectionRepaintRef.current = false;
              term.clear();
            }
            wasAtBottom = !hasHardReset && buf.viewportY >= buf.baseY;
            savedViewport = buf.viewportY;
          },
          afterWrite: () => {
            const recordDataEvent = () => {
              try {
                if (beforeWriteSnapshot) {
                  terminalDebug!.data(pane.id, {
                    after: terminalDebug!.capture(term),
                    before: beforeWriteSnapshot,
                    data: terminalData,
                    dataLength: terminalData.length,
                    hardReset: hasHardReset,
                    source: isReplay ? 'replay' : 'live',
                    streamId,
                  });
                }
                if (!hasHardReset) {
                  refreshVisualSelectionAfterWrite?.();
                }
                const observation = selectionRepaintObservationRef.current;
                const scrolledSelection = scrolledSelectionRef.current;
                const hasPendingStep = observation?.purpose === 'review'
                  ? true
                  : !!scrolledSelection && !scrolledSelection.complete;
                if (
                  selectionScrollPump
                  && selectionScrollPump.pendingUnits() > 0
                  && hasPendingStep
                ) {
                  scheduleSelectionRepaintSettlement();
                }
              } finally {
                if (preservesVisualSelection) selectionRepaintRef.current = false;
              }
            };
            if (hasHardReset) {
              term.scrollToBottom();
              term.refresh(0, Math.max(0, term.rows - 1));
              recordDataEvent();
              return;
            }
            const currentBuffer = term.buffer.active;
            if (isReplay && wasAtBottom) {
              term.scrollToBottom();
              term.refresh(0, Math.max(0, term.rows - 1));
              recordDataEvent();
              return;
            }
            const forcedToBottom = currentBuffer.viewportY >= currentBuffer.baseY;
            if (!wasAtBottom && forcedToBottom) {
              term.scrollToLine(savedViewport);
            }
            recordDataEvent();
          },
        });
      };

      const commitStreamData = (terminalData: string, isReplay: boolean, streamId: number) => {
        handleBootTerminalOutput(terminalData);

        if (!seenOutputRef.current && terminalData.length > 0) {
          seenOutputRef.current = true;
          markPaneSeen(pane.id);
        }

        writeStreamData(terminalData, isReplay, streamId);
      };

      const flushPendingAttachWrites = () => {
        if (attachResponseTimer !== null) {
          clearTimeout(attachResponseTimer);
          attachResponseTimer = null;
        }
        const buffered = pendingAttachWritesRef.current;
        pendingAttachWritesRef.current = null;
        if (!buffered) return;
        for (const chunk of buffered.chunks) {
          if (chunk.streamId !== streamIdRef.current) continue;
          const terminalData = prepareTerminalData(chunk.data);
          if (terminalData.length > 0) {
            commitStreamData(terminalData, chunk.isReplay, chunk.streamId);
          }
        }
      };

      const discardPendingAttachWrites = () => {
        if (attachResponseTimer !== null) {
          clearTimeout(attachResponseTimer);
          attachResponseTimer = null;
        }
        pendingAttachWritesRef.current = null;
      };

      dataDisposer = term.onData((data) => {
        if (term.options.disableStdin || !activeInputSuppressor.canForwardInput()) return;
        preemptPendingTmuxScroll();
        handleBootTerminalInput(data);
        terminalApi.write({
          paneId: pane.id,
          data,
          userInitiated: consumePendingUserKey(),
        });
      });
      selectionDisposer = term.onSelectionChange(() => {
        if (visualSelectionUpdateRef.current || selectionRepaintRef.current) return;
        const selection = term.getSelection();
        if (!selection) {
          const gesture = selectionGestureRef.current;
          const coordinatedRange = scrolledSelectionRef.current;
          const preservesCompletedRange = gesture?.owner === 'terminal'
            && gesture.phase === 'completed'
            && coordinatedRange?.complete === true;
          if (gesture?.phase !== 'active' && !preservesCompletedRange) {
            selectionGestureRef.current = null;
            resetScrolledSelection();
          }
          return;
        }
        const gesture = selectionGestureRef.current;
        if (gesture?.phase === 'active') {
          selectionGestureRef.current = observeAndClaimGesture(gesture);
          return;
        }
        if (gesture?.owner !== 'application' && copyOnSelectRef.current) {
          void copyTerminalSelection(selection);
        }
      });

      let attachStarted = false;
      let attachRejections = 0;

      const abandonPendingAttach = (): void => {
        discardPendingAttachWrites();
        setAttachPending(null);
        readyRef.current = false;
        streamIdRef.current = null;
        streamModeRef.current = null;
      };

      const failAttach = (message: string, expectedStreamId: number): void => {
        if (streamIdRef.current !== expectedStreamId) return;
        clearReconnectingNoticeTimer();
        abandonPendingAttach();
        void terminalApi.detach({ paneId: pane.id });
        detachPane(pane.id);
        setTerminalFailure({ kind: 'attach', message });
      };

      failPendingAttach = (message) => {
        const streamId = streamIdRef.current;
        if (streamId !== null) failAttach(message, streamId);
      };

      const doAttach = (cols: number, rows: number) => {
        if (disposed) return;
        attachStarted = true;
        // A retry keeps the reconnecting notice up; only success or a terminal
        // failure replaces it, otherwise the card blinks once per backoff step.
        setTerminalFailure((failure) => failure?.kind === 'reconnecting' ? failure : null);
        const streamId = nextTerminalStreamId;
        nextTerminalStreamId += 1;
        streamIdRef.current = streamId;
        terminalDebug?.attach(pane.id, streamId, 'attach-start');
        setAttachPending({ cols, rows });
        // Quarantine a bounded amount of output until the authoritative grid
        // arrives. A timeout fails closed; output is never painted at a guessed
        // geometry because that permanently corrupts full-screen redraws.
        pendingAttachWritesRef.current = { byteLength: 0, chunks: [] };
        if (attachResponseTimer !== null) clearTimeout(attachResponseTimer);
        attachResponseTimer = setTimeout(() => {
          failAttach('Terminal attach timed out before geometry was confirmed.', streamId);
        }, ATTACH_RESPONSE_TIMEOUT_MS);
        terminalApi.attach({
          cols,
          fixedCols,
          paneId: pane.id,
          rows,
          sessionName,
          skipScrollbackReplay: !!pane.agent,
          streamId,
          transcriptPath: pane.terminalTranscriptPath,
        }).then((resp) => {
          if (disposed || streamIdRef.current !== streamId) return;
          if (!resp?.success) {
            retryAttachAfterRejection(resp?.error || 'Terminal attach failed', streamId);
            return;
          }
          const authoritativeCols = resp.cols;
          const authoritativeRows = resp.rows;
          if (typeof authoritativeCols !== 'number' || typeof authoritativeRows !== 'number'
            || !Number.isInteger(authoritativeCols) || !Number.isInteger(authoritativeRows)
            || authoritativeCols < TERMINAL_MIN_RESIZE_COLS
            || authoritativeRows < TERMINAL_MIN_RESIZE_ROWS) {
            failAttach('Terminal attach returned invalid authoritative geometry.', streamId);
            return;
          }
          if (fixedCols !== undefined && authoritativeCols !== fixedCols) {
            failAttach(
              `Terminal attach did not preserve the fixed ${fixedCols}-column profile.`,
              streamId,
            );
            return;
          }
          setAttachPending(null);
          streamModeRef.current = resp.mode ?? null;
          clearReconnectingNoticeTimer();
          setTerminalFailure(null);
          terminalDebug?.attach(pane.id, streamId, 'attach-success');
          attachPane(pane.id);
          recordAttachedSize({ cols: authoritativeCols, rows: authoritativeRows });
          if (authoritativeCols !== cols || authoritativeRows !== rows) {
            // Mirror tmux's current grid BEFORE releasing any held output so
            // its repaint renders un-clamped; the follow-up requestResize then
            // brings tmux to this container's size, 1:1 like a real terminal.
            term.resize(authoritativeCols, authoritativeRows);
            recordAttachedSize(
              { cols: authoritativeCols, rows: authoritativeRows },
              term.options.fontSize ?? null,
            );
            term.refresh(0, Math.max(0, term.rows - 1));
          }
          flushPendingAttachWrites();
          requestResize();
          if (!bootingRef.current) {
            unlockTerminalInput();
          }
        }).catch((error) => {
          // Attach failed (pane may have been destroyed): discard quarantined
          // output because it has no authoritative geometry.
          if (!disposed && streamIdRef.current === streamId) {
            failAttach(error instanceof Error ? error.message : 'Terminal attach failed', streamId);
          }
        });
      };

      const tryAttach = () => {
        if (disposed || attachStarted) return true;
        // A scheduled rejection backoff owns the next attempt. Attaching now
        // would burn a backoff slot per ResizeObserver/fit-retry tick.
        if (attachRejectionTimer !== null) return true;
        const size = fit();
        if (!size) {
          if (getLastFitFailure() === 'too-narrow') {
            clearReconnectingNoticeTimer();
            setTerminalFailure({ kind: 'narrow', message: NARROW_TERMINAL_FAILURE_MESSAGE });
          }
          return false;
        }
        readyRef.current = true;
        doAttach(size.cols, size.rows);
        return true;
      };

      const startAttachRetry = () => {
        if (retryTimer) return;
        let retries = 0;
        retryTimer = setInterval(() => {
          if (disposed) {
            if (retryTimer) clearInterval(retryTimer);
            retryTimer = null;
            return;
          }
          retries += 1;
          if (retries >= FIT_MAX_RETRIES) {
            if (retryTimer) clearInterval(retryTimer);
            retryTimer = null;
            if (getLastFitFailure() !== 'too-narrow') {
              clearReconnectingNoticeTimer();
              setTerminalFailure({ kind: 'fit', message: FIT_FAILURE_MESSAGE });
            }
            return;
          }
          if (tryAttach()) {
            if (retryTimer) clearInterval(retryTimer);
            retryTimer = null;
          }
        }, FIT_RETRY_INTERVAL_MS);
      };

      const retryAttachAfterRejection = (message: string, expectedStreamId: number): void => {
        if (streamIdRef.current !== expectedStreamId) return;
        const delay = ATTACH_REJECTION_BACKOFF_MS[attachRejections];
        if (delay === undefined) {
          failAttach(message, expectedStreamId);
          return;
        }
        attachRejections += 1;
        abandonPendingAttach();
        attachStarted = false;
        // Panes without a boot overlay would show nothing at all during the
        // backoff. Keep routine sub-second recovery silent, then show a quiet
        // status only if reconnecting is sustained. The agent boot overlay
        // remains the sole status surface while it is active.
        if (
          !bootingRef.current
          && reconnectingNoticeTimer === null
          && terminalFailureRef.current?.kind !== 'reconnecting'
        ) {
          reconnectingNoticeTimer = setTimeout(() => {
            reconnectingNoticeTimer = null;
            if (disposed) return;
            setTerminalFailure({ kind: 'reconnecting', message: RECONNECTING_MESSAGE });
          }, RECONNECTING_NOTICE_DELAY_MS);
        }
        if (attachRejectionTimer !== null) clearTimeout(attachRejectionTimer);
        attachRejectionTimer = setTimeout(() => {
          attachRejectionTimer = null;
          if (disposed || attachStarted) return;
          if (!tryAttach()) startAttachRetry();
        }, delay);
      };

      attachFrame = requestAnimationFrame(() => {
        if (!tryAttach()) startAttachRetry();
      });

      observer = new ResizeObserver(() => {
        if (!attachStarted) {
          if (!tryAttach()) startAttachRetry();
          return;
        }
        requestResize();
      });
      observer.observe(container);

      onPaste = (e: Event) => {
        e.preventDefault();
        void handlePaste();
      };
      const terminalElement = term.element;
      const updateVisualSelection = (
        pointer?: TerminalSelectionPointer,
        scrollDirection?: 'down' | 'up',
        scrollLines: number = 0,
      ): void => {
        if (!terminalElement) return;
        let gesture = selectionGestureRef.current;
        if (scrollDirection) {
          gesture = advanceTerminalSelectionGesture(
            gesture,
            () => term.getSelectionPosition(),
            scrollDirection,
            scrollLines,
          );
          selectionGestureRef.current = gesture;
        }
        if (!gesture?.ownsVisualSelection) return;

        const viewportY = term.buffer.active.viewportY;
        if (pointer && Number.isFinite(pointer.clientX) && Number.isFinite(pointer.clientY)) {
          gesture = {
            ...gesture,
            pointer: getTerminalSelectionCell(
              terminalElement,
              term.cols,
              term.rows,
              viewportY,
              pointer,
            ),
          };
          selectionGestureRef.current = gesture;
        }
        const range = getTerminalSelectionRange(
          gesture.anchor,
          gesture.pointer,
          term.cols,
          term.rows,
          viewportY,
        );
        if (!range) return;

        visualSelectionUpdateRef.current = true;
        try {
          term.select(range.column, range.row, range.length);
        } finally {
          visualSelectionUpdateRef.current = false;
        }
      };
      function renderReviewHighlight(): boolean {
        const gesture = selectionGestureRef.current;
        if (!terminalElement || !gesture?.ownsVisualSelection) return false;
        const range = getTerminalSelectionRange(
          gesture.anchor,
          gesture.pointer,
          term.cols,
          term.rows,
          term.buffer.active.viewportY,
        );
        visualSelectionUpdateRef.current = true;
        try {
          if (range) term.select(range.column, range.row, range.length);
          else term.clearSelection();
        } finally {
          visualSelectionUpdateRef.current = false;
        }
        return range !== null;
      }
      function clearVisualSelection(): void {
        visualSelectionUpdateRef.current = true;
        try {
          term.clearSelection();
        } finally {
          visualSelectionUpdateRef.current = false;
        }
      }
      function renderAndVerifyFrozenHighlight(): boolean {
        const expectedOnscreen = renderReviewHighlight();
        const frozen = scrolledSelectionRef.current;
        if (
          frozen?.complete
          && frozen.rangeVerified
          && !frozen.reversalInvalidated
          && frozen.accumulatedText !== null
          && isReviewHighlightTruthful(
            expectedOnscreen,
            term.getSelection(),
            frozen.accumulatedText,
          )
        ) return true;

        clearVisualSelection();
        return false;
      }
      const freezeReviewRange = (): ScrolledTerminalSelection | null => {
        const existing = scrolledSelectionRef.current;
        if (existing) return existing;
        const selection = term.getSelection();
        if (!selection) return null;
        const rangeVerified = selection.length <= MAX_ACCUMULATED_SELECTION_CHARS;
        const frozen: ScrolledTerminalSelection = {
          accumulatedText: rangeVerified ? selection : null,
          anchorText: selection,
          complete: true,
          direction: 'down',
          rangeVerified,
          reversalInvalidated: false,
        };
        scrolledSelectionRef.current = frozen;
        return frozen;
      };
      refreshVisualSelectionAfterWrite = () => {
        if (scrolledSelectionRef.current?.complete) {
          renderAndVerifyFrozenHighlight();
          return;
        }
        updateVisualSelection();
      };
      const observeAndClaimGesture = (gesture: TerminalSelectionGesture): TerminalSelectionGesture =>
        claimTerminalSelectionGesture(gesture, term.getSelectionPosition());
      const forwardedSelectionWheelEvents = new WeakSet<WheelEvent>();
      const ensureScrolledSelection = (direction: 'down' | 'up'): ScrolledTerminalSelection | null => {
        const selection = term.getSelection();
        if (!selection) return null;
        let gesture = selectionGestureRef.current;
        if (!gesture) {
          const position = term.getSelectionPosition() ?? {
            end: { x: 1, y: term.buffer.active.viewportY },
            start: { x: 0, y: term.buffer.active.viewportY },
          };
          gesture = completeTerminalSelectionGesture(
            claimTerminalSelectionGesture(
              beginTerminalSelectionGesture(position.start),
              position,
            ),
          );
          selectionGestureRef.current = gesture;
        }
        if (gesture?.owner === 'pending') {
          const observedPosition = term.getSelectionPosition() ?? {
            end: { x: gesture.anchor.x + 1, y: gesture.anchor.y },
            start: gesture.anchor,
          };
          selectionGestureRef.current = claimTerminalSelectionGesture(
            gesture,
            observedPosition,
          );
        }
        const current = scrolledSelectionRef.current;
        if (current) {
          if (current.reversalInvalidated) return null;
          if (!current.complete && current.direction !== direction) {
            const hasAcknowledgedGrowth = current.accumulatedText !== null
              && current.accumulatedText !== current.anchorText;
            if (hasAcknowledgedGrowth) {
              current.reversalInvalidated = true;
              current.rangeVerified = false;
              selectionScrollPump?.cancel();
              return null;
            }
          }
          return current;
        }
        const rangeVerified = selection.length <= MAX_ACCUMULATED_SELECTION_CHARS;
        const created: ScrolledTerminalSelection = {
          accumulatedText: rangeVerified ? selection : null,
          anchorText: selection,
          complete: false,
          direction,
          rangeVerified,
          reversalInvalidated: false,
        };
        scrolledSelectionRef.current = created;
        selectionGenerationRef.current += 1;
        return created;
      };
      if (terminalElement) {
        const forwardScrollUnit = (
          direction: 'down' | 'up',
          pointer: TerminalSelectionPointer,
          onFailure: () => void,
        ): void => {
          if (term.modes.mouseTrackingMode !== 'none') {
            const WheelEventConstructor = terminalElement.ownerDocument.defaultView?.WheelEvent;
            if (!WheelEventConstructor) {
              onFailure();
              return;
            }
            const forwardedEvent = new WheelEventConstructor('wheel', {
              bubbles: true,
              cancelable: true,
              clientX: pointer.clientX,
              clientY: pointer.clientY,
              deltaMode: WheelEventConstructor.DOM_DELTA_LINE,
              deltaY: direction === 'up' ? -1 : 1,
            });
            forwardedSelectionWheelEvents.add(forwardedEvent);
            terminalElement.dispatchEvent(forwardedEvent);
            return;
          }
          const capturedObservation = selectionRepaintObservationRef.current;
          void terminalApi.scroll({
            alternateScreenMode: pane.agent === 'opencode' ? 'opencode' : 'arrow-keys',
            direction,
            lines: 1,
            paneId: pane.id,
          }).then((res) => {
            if (!res.success && selectionRepaintObservationRef.current === capturedObservation) {
              onFailure();
            }
          }).catch(() => {
            if (selectionRepaintObservationRef.current !== capturedObservation) return;
            onFailure();
          });
        };
        const dispatchReviewStep = (
          direction: 'down' | 'up',
          pointer: TerminalSelectionPointer,
        ): void => {
          const frozen = freezeReviewRange();
          const gesture = selectionGestureRef.current;
          if (!frozen || !gesture) {
            selectionScrollPump?.cancel();
            return;
          }
          selectionRepaintObservationRef.current = captureRepaintObservation(
            gesture,
            'review',
          );
          updateVisualSelection(undefined, direction, 1);
          renderReviewHighlight();
          forwardScrollUnit(direction, pointer, () => {
            const observation = selectionRepaintObservationRef.current;
            const currentGesture = selectionGestureRef.current;
            if (observation && currentGesture) {
              selectionGestureRef.current = restoreGestureFromObservation(currentGesture, observation);
              renderAndVerifyFrozenHighlight();
            }
            selectionRepaintObservationRef.current = null;
            selectionScrollPump?.cancel();
          });
        };
        const dispatchLogicalStep = (
          direction: 'down' | 'up',
          pointer: TerminalSelectionPointer,
        ): void => {
          const scrolledSelection = ensureScrolledSelection(direction);
          if (!scrolledSelection || scrolledSelection.complete) {
            selectionScrollPump?.cancel();
            return;
          }
          const gesture = selectionGestureRef.current;
          if (gesture) {
            const preStepGesture = gesture.ownsVisualSelection ? gesture : (() => {
              const position = term.getSelectionPosition();
              if (!position) return gesture;
              return {
                ...gesture,
                anchor: direction === 'up' ? { ...position.end } : { ...position.start },
                pointer: direction === 'up' ? { ...position.start } : { ...position.end },
              };
            })();
            selectionRepaintObservationRef.current = captureRepaintObservation(
              preStepGesture,
              'logical',
              scrolledSelection.rangeVerified,
            );
          }
          updateVisualSelection(pointer, direction, 1);
          forwardScrollUnit(direction, pointer, () => {
            const observation = selectionRepaintObservationRef.current;
            const currentGesture = selectionGestureRef.current;
            if (observation && currentGesture) {
              selectionGestureRef.current = restoreGestureFromObservation(currentGesture, observation);
            }
            const sel = scrolledSelectionRef.current;
            if (sel) {
              sel.rangeVerified = false;
              sel.reversalInvalidated = true;
            }
            renderAndVerifyFrozenHighlight();
            selectionRepaintObservationRef.current = null;
            selectionScrollPump?.cancel();
          });
        };
        selectionScrollPump = createTerminalSelectionScrollPump({
          maxQueuedUnits: 2,
          dispatch: (direction, pointer) => {
            if (shouldReviewTerminalSelectionScroll(selectionGestureRef.current)) {
              dispatchReviewStep(direction, pointer);
              return;
            }
            dispatchLogicalStep(direction, pointer);
          },
          onStall: () => {
            const observation = selectionRepaintObservationRef.current;
            const currentGesture = selectionGestureRef.current;
            const isReview = observation?.purpose === 'review';
            if (observation && currentGesture) {
              const restored = isReview
                ? restoreGestureFromObservation(currentGesture, observation)
                : restoreActiveGestureFromObservation(currentGesture, observation);
              selectionGestureRef.current = restored;
            }
            const scrolledSelection = scrolledSelectionRef.current;
            if (scrolledSelection && !scrolledSelection.complete && !isReview && observation) {
              const remainsVerified = observation.rangeVerifiedBeforeStep
                && !observation.sawUnverifiedFrame;
              scrolledSelection.complete = true;
              scrolledSelection.rangeVerified = remainsVerified;
              if (!remainsVerified) {
                const restoredGesture = selectionGestureRef.current;
                if (restoredGesture) {
                  selectionGestureRef.current = cancelTerminalSelectionGesture(restoredGesture);
                }
              }
            }
            if (observation) renderAndVerifyFrozenHighlight();
            selectionRepaintObservationRef.current = null;
            selectionReachedScrollEdge = true;
            rendererLog.info('terminal', 'Selection scroll stopped without a repaint', {
              paneId: pane.id,
            });
          },
        });
        selectionScrollPumpRef.current = selectionScrollPump;

        finalizeTerminalSelectionRef.current = (): Promise<void> => {
          const existingFinalization = selectionFinalizationRef.current;
          if (existingFinalization) return existingFinalization;

          const generation = selectionGenerationRef.current;
          const owner = selectionGestureRef.current?.owner;
          const coordinatedRange = scrolledSelectionRef.current
            ?? (owner === 'terminal' && streamModeRef.current === 'pty'
              ? freezeReviewRange()
              : null);
          const completedSelectionPosition = coordinatedRange
            ? term.getSelectionPosition()
            : undefined;
          const finalization = (async () => {
            await selectionScrollPump?.waitForIdle();
            if (
              selectionGenerationRef.current !== generation
              || scrolledSelectionRef.current !== coordinatedRange
            ) return;

            const latestGesture = selectionGestureRef.current;
            if (latestGesture?.owner !== owner || latestGesture?.phase === 'canceled') return;
            if (latestGesture) {
              const visualGesture = completedSelectionPosition && !latestGesture.ownsVisualSelection
                ? {
                    ...latestGesture,
                    anchor: { ...completedSelectionPosition.start },
                    ownsVisualSelection: true,
                    pointer: { ...completedSelectionPosition.end },
                  }
                : latestGesture;
              selectionGestureRef.current = completeTerminalSelectionGesture(visualGesture);
            }
            if (coordinatedRange && !coordinatedRange.complete) {
              accumulateSelectionSnapshot(coordinatedRange, term.getSelection());
              coordinatedRange.complete = true;
            }
          })();
          selectionFinalizationRef.current = finalization;
          void finalization.finally(() => {
            if (selectionFinalizationRef.current === finalization) {
              selectionFinalizationRef.current = null;
            }
          });
          return finalization;
        };
      }
      const flushTmuxScroll = (): boolean => {
        const pending = pendingTmuxScrollRef.current;
        const queuedLines = pending.lines;
        if (queuedLines === 0) return false;
        if (term.options.disableStdin || !activeInputSuppressor.canForwardInput()) {
          preemptPendingTmuxScroll();
          return false;
        }
        pending.lines = 0;
        const direction = queuedLines < 0 ? 'up' : 'down';
        if (term.hasSelection()) {
          updateVisualSelection(undefined, direction, Math.abs(queuedLines));
        }
        void terminalApi.scroll({
          alternateScreenMode: pane.agent === 'opencode' ? 'opencode' : 'arrow-keys',
          direction,
          lines: Math.abs(queuedLines),
          paneId: pane.id,
        }).then((res) => {
          if (!res.success) preemptPendingTmuxScroll();
        }).catch(() => {
          preemptPendingTmuxScroll();
        });
        return true;
      };
      const scheduleTmuxScrollWindow = () => {
        const pending = pendingTmuxScrollRef.current;
        pending.timer = setTimeout(() => {
          pending.timer = null;
          if (pending.lines === 0) {
            pending.direction = null;
            return;
          }
          if (flushTmuxScroll()) scheduleTmuxScrollWindow();
        }, TMUX_SCROLL_FLUSH_MS);
      };
      const queueTmuxScroll = (direction: 'down' | 'up', lines: number) => {
        const pending = pendingTmuxScrollRef.current;
        if (pending.timer && pending.direction && pending.direction !== direction) {
          clearTimeout(pending.timer);
          pending.direction = null;
          pending.lines = 0;
          pending.timer = null;
        }
        pending.lines += direction === 'up' ? -lines : lines;
        if (pending.timer) return;
        pending.direction = direction;
        if (flushTmuxScroll()) scheduleTmuxScrollWindow();
      };
      const getWheelBufferSnapshot = () => ({
        baseY: term.buffer.active.baseY,
        type: term.buffer.active.type,
        viewportY: term.buffer.active.viewportY,
      });
      const recordWheelEvent = terminalDebug && ((
          e: WheelEvent,
          consumedBy: 'agent-input' | 'native-scroll' | 'none' | 'suppress' | 'tmux-scroll',
          before: ReturnType<typeof getWheelBufferSnapshot>,
        ) => {
          terminalDebug!.wheel(pane.id, {
            after: getWheelBufferSnapshot(),
            before,
            consumedBy,
            defaultPrevented: e.defaultPrevented,
            deltaMode: e.deltaMode,
            deltaX: e.deltaX,
            deltaY: e.deltaY,
            selectionOwner: selectionGestureRef.current?.owner,
            selectionAccumulatedLength: scrolledSelectionRef.current?.accumulatedText?.length,
            selectionAnchorLength: scrolledSelectionRef.current?.anchorText.length,
            selectionRangeComplete: scrolledSelectionRef.current?.complete,
            selectionRangeVerified: scrolledSelectionRef.current?.rangeVerified,
            selectionTextLength: term.getSelection().length,
          });
        });
      onWheel = (e: WheelEvent) => {
        const before = terminalDebug ? getWheelBufferSnapshot() : null;
        const recordWheel = (consumedBy: 'agent-input' | 'native-scroll' | 'none' | 'suppress' | 'tmux-scroll') => {
          if (recordWheelEvent && before) recordWheelEvent(e, consumedBy, before);
        };
        if (forwardedSelectionWheelEvents.delete(e)) {
          recordWheel('agent-input');
          return;
        }
        let selectionGesture = selectionGestureRef.current;
        const mouseTrackingMode = term.modes.mouseTrackingMode;
        if (selectionGesture?.owner === 'pending' && term.hasSelection()) {
          selectionGesture = observeAndClaimGesture(selectionGesture);
          selectionGestureRef.current = selectionGesture;
        }
        if (
          streamModeRef.current === 'pty'
          && shouldCoordinateTerminalSelectionScroll(selectionGesture)
          && term.hasSelection()
        ) {
          const selAction = resolveSelectionWheelAction(e, selectionWheelStateRef.current);
          if (selAction.type === 'selection-scroll') {
            e.preventDefault();
            e.stopPropagation();
            if (!selectionFinalizationRef.current) {
              selectionScrollPump?.enqueue(
                selAction.direction,
                selAction.units,
                { clientX: e.clientX, clientY: e.clientY },
              );
            }
            recordWheel(mouseTrackingMode === 'none' ? 'tmux-scroll' : 'agent-input');
            return;
          }
        }
        const coordinatedRange = scrolledSelectionRef.current;
        const canReviewScroll = coordinatedRange
          ? coordinatedRange.complete
            && coordinatedRange.rangeVerified
            && !coordinatedRange.reversalInvalidated
          : term.hasSelection();
        if (
          streamModeRef.current === 'pty'
          && shouldReviewTerminalSelectionScroll(selectionGesture)
          && canReviewScroll
        ) {
          const selAction = resolveSelectionWheelAction(e, selectionWheelStateRef.current);
          if (selAction.type === 'selection-scroll') {
            e.preventDefault();
            e.stopPropagation();
            selectionScrollPump?.enqueue(
              selAction.direction,
              selAction.units,
              { clientX: e.clientX, clientY: e.clientY },
            );
            recordWheel(mouseTrackingMode === 'none' ? 'tmux-scroll' : 'agent-input');
            return;
          }
        }
        if (streamModeRef.current === 'pty' && mouseTrackingMode !== 'none') {
          preemptPendingTmuxScroll();
          recordWheel('none');
          return;
        }
        const action = resolveTerminalWheelAction(pane.agent, term.buffer.active, e, wheelStateRef.current, {
          preferTmuxScroll: streamModeRef.current === 'pty',
        });
        if (action.type === 'none') {
          recordWheel('none');
          return;
        }

        e.preventDefault();
        e.stopPropagation();
        if (action.type === 'native-scroll') {
          term.scrollLines(action.lines);
          recordWheel('native-scroll');
          return;
        }
        if (action.type === 'suppress') {
          recordWheel('suppress');
          return;
        }
        if (
          (action.type === 'tmux-scroll' || action.type === 'agent-input')
          && (term.options.disableStdin || !activeInputSuppressor.canForwardInput())
        ) {
          recordWheel('suppress');
          return;
        }
        const selection = action.type === 'tmux-scroll' || action.type === 'agent-input'
          ? term.getSelection()
          : '';
        if (selection) ensureScrolledSelection(e.deltaY < 0 ? 'up' : 'down');
        if (action.type === 'tmux-scroll') {
          queueTmuxScroll(action.direction, action.lines);
          recordWheel('tmux-scroll');
          return;
        }
        cancelPendingTmuxScrollBatch();
        const fallbackRange = scrolledSelectionRef.current;
        if (streamModeRef.current !== 'pty' && fallbackRange) {
          fallbackRange.accumulatedText = null;
          fallbackRange.rangeVerified = false;
        }
        terminalApi.write({ paneId: pane.id, data: action.input, userInitiated: true });
        recordWheel('agent-input');
      };
      if (terminalElement) {
        selectionAutoScrollDisposer = attachTerminalSelectionAutoScroll({
          canStartSelection: () => selectionIntegrationEnabled,
          element: terminalElement,
          getRowHeight: () => terminalElement.getBoundingClientRect().height / Math.max(1, term.rows),
          getSelection: () => term.getSelection(),
          needsCustomScroll: () => {
            let gesture = selectionGestureRef.current;
            if (gesture?.owner === 'pending' && term.hasSelection()) {
              gesture = observeAndClaimGesture(gesture);
              selectionGestureRef.current = gesture;
            }
            return (streamModeRef.current === 'pty' || term.buffer.active.type === 'alternate')
              && shouldCoordinateTerminalSelectionScroll(gesture);
          },
          onScroll: (direction, lines, pointer) => {
            if (selectionReachedScrollEdge) return;
            const WheelEventConstructor = terminalElement.ownerDocument.defaultView?.WheelEvent;
            if (!WheelEventConstructor) return;
            terminalElement.dispatchEvent(new WheelEventConstructor('wheel', {
              bubbles: true,
              cancelable: true,
              clientX: pointer.clientX,
              clientY: pointer.clientY,
              deltaMode: WheelEventConstructor.DOM_DELTA_PIXEL,
              deltaY: direction === 'up' ? -24 * lines : 24 * lines,
            }));
          },
          onSelectionEnd: (completed) => {
            cancelPendingTmuxScrollBatch();
            let gesture = selectionGestureRef.current;
            if (completed && gesture?.owner === 'pending' && term.hasSelection()) {
              gesture = observeAndClaimGesture(gesture);
              selectionGestureRef.current = gesture;
            }
            const scrolledSelection = scrolledSelectionRef.current;
            resetSelectionWheelResidual(selectionWheelStateRef.current);
            if (!completed) {
              selectionRepaintObservationRef.current = null;
              const canceledGesture = gesture ? cancelTerminalSelectionGesture(gesture) : null;
              selectionGestureRef.current = canceledGesture;
              selectionScrollPump?.cancel();
              if (scrolledSelection) scrolledSelection.rangeVerified = false;
              selectionFinalizationRef.current = null;
              return;
            }

            const generation = selectionGenerationRef.current;
            const finalization = finalizeTerminalSelectionRef.current?.() ?? Promise.resolve();
            void finalization.then(() => {
              if (
                selectionGenerationRef.current !== generation
                || (scrolledSelection !== null && scrolledSelectionRef.current !== scrolledSelection)
              ) return;
              const completedGesture = selectionGestureRef.current;
              if (completedGesture?.owner === 'terminal' && copyOnSelectRef.current) {
                void copyTerminalSelection();
              }
            });
          },
          onSelectionMove: (pointer) => {
            selectionReachedScrollEdge = false;
            updateVisualSelection(pointer);
          },
          onSelectionStart: (event) => {
            resetScrolledSelection();
            selectionReachedScrollEdge = false;
            resetSelectionWheelResidual(selectionWheelStateRef.current);
            selectionRepaintObservationRef.current = null;
            const viewportY = term.buffer.active.viewportY;
            const anchor = getTerminalSelectionCell(
              terminalElement,
              term.cols,
              term.rows,
              viewportY,
              event,
            );
            const gesture = beginTerminalSelectionGesture(anchor, term.getSelectionPosition());
            selectionGestureRef.current = gesture;
            // xterm's forced-selection modifier is platform dependent
            // (Option on macOS, Shift elsewhere). Treat either as a pending
            // terminal claim and let the observed xterm selection decide.
            const expectsTerminalSelection = event.altKey || event.shiftKey;
            if (term.modes.mouseTrackingMode !== 'none' && !expectsTerminalSelection) {
              queueMicrotask(() => {
                if (selectionGestureRef.current !== gesture) return;
                selectionGestureRef.current = markTerminalSelectionGestureApplicationOwned(gesture);
                const currentSelection = term.getSelectionPosition();
                if (
                  currentSelection
                  && isSameTerminalSelectionPosition(currentSelection, gesture.initialSelection)
                ) {
                  visualSelectionUpdateRef.current = true;
                  try {
                    term.clearSelection();
                  } finally {
                    visualSelectionUpdateRef.current = false;
                  }
                }
              });
            }
          },
        });
      }
      onClick = (e: MouseEvent) => {
        if (e.button !== 0) return;
        requestAnimationFrame(focusTerminal);
      };
      onMouseDown = (e: MouseEvent) => {
        if (e.button === 0 && !e.shiftKey) resetScrolledSelection();
      };
      onCopy = (e: ClipboardEvent) => {
        if (
          !shouldInterceptTerminalSelectionCopy(
            selectionGestureRef.current,
            scrolledSelectionRef.current !== null,
          )
        ) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        void copyTerminalSelection();
      };
      onContextMenu = (e: MouseEvent) => {
        e.preventDefault();
        const coordinatedRange = scrolledSelectionRef.current;
        const hasVerifiedCompletedRange = !!coordinatedRange?.complete
          && !!coordinatedRange?.rangeVerified
          && !coordinatedRange?.reversalInvalidated;
        const hasSelection = isTerminalSelectionCopyEligible(
          selectionGestureRef.current,
          coordinatedRange ? false : term.hasSelection(),
          hasVerifiedCompletedRange,
        );
        setContextMenu({ x: e.clientX, y: e.clientY, hasSelection });
      };
      container.addEventListener('paste', onPaste);
      container.addEventListener('copy', onCopy, true);
      container.addEventListener('wheel', onWheel, wheelListenerOptions);
      container.addEventListener('click', onClick);
      container.addEventListener('contextmenu', onContextMenu);
      container.addEventListener('mousedown', onMouseDown);
      } catch (error) {
        rendererLog.warn('terminal', 'Terminal initialization failed', { error, paneId: pane.id });
        cleanupTerminal();
        if (!disposed) {
          setTerminalFailure({
            kind: 'initialization',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    return () => {
      disposed = true;
      cleanupTerminal();
    };
    // This effect owns the terminal connection lifecycle. The explicit pane fields below are the
    // reconnect contract; depending on the whole pane object would reconnect on unrelated store
    // updates and drop terminal continuity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pane.id,
    pane.paneId,
    pane.agent,
    pane.terminalTranscriptPath,
    sessionName,
    attachPane,
    markPaneSeen,
    detachPane,
    fit,
    getLastFitFailure,
    recordAttachedSize,
    requestResize,
    resetResize,
    setAttachPending,
    terminalFontFamily,
    terminalFontSize,
    terminalTransport,
    cursorBlink,
    cursorStyle,
    scrollbackLines,
    focusTerminal,
    focusSelectedTerminal,
    cancelPendingTmuxScrollBatch,
    preemptPendingTmuxScroll,
    unlockTerminalInput,
    clearMinBootUnlockTimer,
    handleBootTerminalInput,
    handleBootTerminalOutput,
    resetBoot,
    tryCompleteBootIfReady,
    handlePaste,
    handleFindResultsChanged,
    copyTerminalSelection,
    resetScrolledSelection,
    requestOpenLink,
    openTerminalFileLink,
    terminalFileRoot,
    requestOsc52ClipboardWrite,
    opencodeMousePassthrough,
    openFind,
    reconnectNonce,
    setTerminalFailure,
    effectiveVisible,
    selectionIntegrationEnabled,
  ]);

  // Re-theme the live terminal in place. xterm's ThemeService fires
  // onChangeColors when options.theme is assigned, and the WebGL renderer
  // re-acquires its texture atlas from that event, so no atlas reset is needed.
  useEffect(() => {
    themeModeRef.current = themeMode;
    const term = termRef.current;
    if (!term) return;
    term.options.theme = createTerminalTheme(themeMode);
    applyTerminalViewportStyle(term, TERMINAL_BACKGROUND_COLORS[themeMode]);
    refreshTerminalRenderer(term);
  }, [themeMode]);

  // If a "New Pane" modal is open, force-disable stdin so typing into the modal
  // can't accidentally reach the tmux pane (focus bugs / key repeat).
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (isCreatingPane) {
      term.options.disableStdin = true;
      // Clear the unlocked flag too: unlockTerminalInput() early-returns while
      // this is set, so leaving it true would leave stdin (and wheel-driven
      // scrolling, which is gated on disableStdin) locked after the modal closes.
      stdinUnlockedRef.current = false;
      term.blur();
      return;
    }

    // Input remains fail-closed until the authoritative attach response has
    // established the stream and geometry. unlockTerminalInput owns the only
    // transition back to writable stdin.
    unlockTerminalInput();
  }, [isCreatingPane, pane.id, pane.agent, unlockTerminalInput]);

  const agentLabel = formatAgentLabel(pane.agent);

  const reconnectTerminal = useCallback(() => {
    resetResize();
    setTerminalFailure(null);
    setReconnectNonce((value) => value + 1);
  }, [resetResize, setTerminalFailure]);

  const showBootOverlay = booting && terminalFailure === null;

  return {
    agentLabel,
    bootPhase,
    caseSensitive: findCaseSensitive,
    closeContextMenu,
    closeFind: handleFindClose,
    closeLinkPrompt,
    confirmOpenLink,
    containerRef,
    contextMenu,
    failure: terminalFailure,
    findOpen,
    findQuery,
    findResult,
    handleCopy,
    handlePaste,
    handleSelectAll,
    overlayPalette,
    pendingLink,
    reconnectTerminal,
    runFind,
    setFindQuery,
    showBootOverlay,
    showEmptyState: !!pane.agent
      && pane.claudeRenderer === 'fullscreen'
      && showSessionEmptyState
      && !booting,
    terminalBackgroundStyle,
    toggleFindCaseSensitive,
  };
}
