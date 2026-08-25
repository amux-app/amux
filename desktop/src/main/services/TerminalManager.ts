import { execAsync, execFileAsync, getStatusDetector, shQuote } from 'muxbase/core';
import { BrowserWindow } from 'electron';
import { existsSync } from 'fs';
import type {
  TerminalDataSource,
  TerminalScrollResponse,
  TerminalSelectionExpandResponse,
  TerminalStreamMode,
  TerminalTransportMode,
} from '../../shared/ipc-types.js';
import { expandScrolledTerminalSelection } from '../../shared/terminal-selection.js';
import {
  OPENCODE_LINE_DOWN_INPUT,
  OPENCODE_LINE_UP_INPUT,
  type TerminalAlternateScreenMode,
} from '../../shared/terminal-scroll-protocol.js';
import { formatError } from '../utils/formatError.js';
import { ElectronSettingsService } from './ElectronSettingsService.js';
import { log } from './Logger.js';
import { RuntimeActivityMetrics } from './RuntimeActivityMetrics.js';
import { TerminalControlClients } from './terminal-control-clients.js';
import { submitTerminalCommand, writeTerminalInput } from './terminal-input.js';
import { type PaneDimensions, readPaneDimensions } from './terminal-pane-dimensions.js';
import {
  compactAgentScrollbackForReplay,
  type CapturedPaneCursor,
  formatScrollbackInsert,
  formatScrollbackReplay,
  renderCapturedPaneFrame,
} from './terminal-render.js';
import { sendTerminalData, sendTerminalStreamModeChanged } from './terminal-renderer-events.js';
import {
  capturePane,
  capturePaneText,
  cursorStateEquals,
  displayPaneFormat,
  NO_CONTENT,
  type PaneStream,
  stripAnsiForLog,
} from './terminal-stream-state.js';
import {
  TerminalPtyOsc52Follower,
  type TerminalPtyOsc52FollowerHandle,
} from './terminal-pty-osc52-follower.js';
import { TerminalPtyService, type TerminalPtyHandle } from './terminal-pty-service.js';
import { TerminalTranscriptStream } from './terminal-transcript-stream.js';
import { TmuxControlModeClient } from './tmux-control-mode.js';

const ALTERNATE_ON_FORMAT = '#{alternate_on}';
const CURSOR_STATE_FORMAT = '#{cursor_x}:#{cursor_y}:#{cursor_flag}';
const HISTORY_SIZE_FORMAT = '#{history_size}';
const PANE_IN_MODE_FORMAT = '#{pane_in_mode}';
const MAX_CONSECUTIVE_FAILURES = 10;
const WRITE_CAPTURE_DELAY_MS = 8;
const RESIZE_REPAINT_DELAY_MS = 80;
const ALTERNATE_CHECK_INTERVAL_MS = 2000;
const TERMINAL_REPLAY_CHUNK_CHARS = 512 * 1024;
const PTY_EXIT_RECOVERY_DELAY_MS = 250;
const PTY_EXIT_RETRY_RESET_MS = 30_000;
const PTY_SCROLL_MAX_LINES = 200;
const PTY_ALT_SCROLL_MAX_KEYS = 40;
const PTY_OPENCODE_SCROLL_MAX_STEPS = 10;
const PTY_COPY_MODE_COMMAND_TIMEOUT_MS = 1500;
const PTY_INPUT_RETRY_DELAY_MS = 40;
const PTY_SCROLL_ALT_MARKER = 'ALT';
const PTY_SCROLL_NORMAL_MARKER = 'NORMAL';
const PTY_SCROLL_ALT_MARKER_COMMAND = `display-message -p ${PTY_SCROLL_ALT_MARKER}`;
const PTY_SCROLL_NORMAL_MARKER_COMMAND = `display-message -p ${PTY_SCROLL_NORMAL_MARKER}`;

interface TerminalManagerOptions {
  createControlClient?: () => TmuxControlModeClient;
  createPtyOsc52Follower?: () => TerminalPtyOsc52Follower;
  createPtyService?: () => TerminalPtyService;
  onTerminalData?: (paneId: string, data: string, source: TerminalDataSource) => void;
  pollIntervalMs?: number;
  transportMode?: TerminalTransportMode;
}

interface TerminalAttachSize {
  cols: number;
  rows: number;
}

interface TerminalAttachResult extends PaneDimensions {
  streamId: number;
  mode?: TerminalStreamMode;
}

interface PendingAttach {
  promise: Promise<TerminalAttachResult>;
  streamId: number;
  token: number;
}

interface AttachGeometryPreparation {
  canPreSizeGeometryLockedStream: boolean;
  dims: PaneDimensions;
  geometryLockedAgentStream: boolean;
  requestedSizeMatches: boolean;
  useControl: boolean;
  usePty: boolean;
  useTranscript: boolean;
}

function isNotInModeError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'message' in error
    && String((error as { message: unknown }).message).includes('not in a mode');
}

function isUsableTerminalSize(size: TerminalAttachSize | undefined): size is TerminalAttachSize {
  return !!size
    && Number.isFinite(size.cols)
    && Number.isFinite(size.rows)
    && size.cols > 1
    && size.rows > 1;
}

function isNonShrinkingResize(current: PaneDimensions, requested: TerminalAttachSize): boolean {
  return requested.cols >= current.cols && requested.rows >= current.rows;
}

function resolveFixedCols(cols: number, fixedCols: number): number {
  return fixedCols > 0 ? fixedCols : cols;
}

/**
 * Owns terminal transport lifecycles for tmux panes: PTY clients for live
 * terminal fidelity, with transcript/capture fallbacks for compatibility.
 */
export class TerminalManager {
  private streams = new Map<string, PaneStream>();
  private capturePromises = new WeakMap<PaneStream, Promise<void>>();
  private ptyHandles = new Map<string, TerminalPtyHandle>();
  private ptyOsc52FollowerHandles = new Map<string, TerminalPtyOsc52FollowerHandle>();
  private ptyCopyModePanes = new Set<string>();
  private screenReaderPaneIds = new Set<string>();
  private paneInteractionQueues = new Map<string, Promise<void>>();
  private ptyScrollGenerations = new Map<string, number>();
  private pendingPtyDrains = new WeakMap<PaneStream, Promise<void>>();
  private pendingPtyWriteRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingAttaches = new Map<string, PendingAttach>();
  private attachTokens = new Map<string, number>();
  private lastAttachToken = 0;
  private pendingUnlocks = new Set<string>();
  private pendingWrites = new Map<string, string>();
  private ptyExitRetries = new Map<string, number>();
  private ptyExitRetryResetTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private preferredLaunchSize: TerminalAttachSize | null;
  private readonly controlClients: TerminalControlClients;
  private readonly ptyService: TerminalPtyService;
  private readonly ptyOsc52Follower: TerminalPtyOsc52Follower;
  private readonly transcriptStream: TerminalTranscriptStream;
  private rendererDeliverySuspended = false;
  private rendererDesiredVisible = true;
  private restoringPaneId: string | null = null;
  private resumedPaneIds = new Set<string>();
  private resumeDeliveryPromise: Promise<void> | null = null;
  private suspendedDirtyPaneIds = new Set<string>();
  private window: BrowserWindow | null;
  private pollIntervalMs: number;
  private transportMode: TerminalTransportMode;
  private readonly onTerminalData?: TerminalManagerOptions['onTerminalData'];

  constructor(window: BrowserWindow | null, opts?: TerminalManagerOptions) {
    this.window = window;
    this.pollIntervalMs = Math.max(50, Math.min(opts?.pollIntervalMs ?? 200, 5000));
    this.transportMode = opts?.transportMode ?? 'classic';
    this.onTerminalData = opts?.onTerminalData;
    this.controlClients = new TerminalControlClients(
      opts?.createControlClient ?? (() => new TmuxControlModeClient()),
    );
    this.ptyService = opts?.createPtyService?.() ?? new TerminalPtyService();
    this.ptyOsc52Follower = opts?.createPtyOsc52Follower?.() ?? new TerminalPtyOsc52Follower();
    this.preferredLaunchSize = this.readPreferredLaunchSizeFromSettings();
    this.transcriptStream = new TerminalTranscriptStream({
      isCurrentStream: (stream) => this.isCurrentStream(stream),
      onTranscriptActivity: (stream) => this.scheduleTranscriptSnapshotCapture(stream),
      sendToRenderer: (paneId, data, source, streamId) => this.sendToRenderer(paneId, data, source, streamId),
    });
  }

  setWindow(win: BrowserWindow | null): void {
    this.window = win;
  }

  setOptions(opts: TerminalManagerOptions): void {
    if (opts.pollIntervalMs !== undefined) {
      this.pollIntervalMs = Math.max(50, Math.min(opts.pollIntervalMs, 5000));
      for (const stream of this.streams.values()) {
        if (stream.mode === 'capture' && stream.timer) {
          clearInterval(stream.timer);
          stream.timer = null;
          this.startCapturePolling(stream);
        }
      }
    }

    if (opts.transportMode) {
      this.transportMode = opts.transportMode;
    }
  }

  getPreferredLaunchSize(): TerminalAttachSize | null {
    return this.preferredLaunchSize ? { ...this.preferredLaunchSize } : null;
  }

  suspendRendererDelivery(): void {
    if (!this.rendererDesiredVisible) return;
    const interruptedRestorePaneId = this.restoringPaneId;
    this.rendererDesiredVisible = false;
    this.rendererDeliverySuspended = true;
    this.restoringPaneId = null;
    this.resumedPaneIds.clear();
    if (interruptedRestorePaneId) {
      this.suspendedDirtyPaneIds.add(interruptedRestorePaneId);
    }

    for (const stream of this.streams.values()) {
      // A source pane can change without the auxiliary PTY/control client
      // emitting bytes while the application is hidden. Restore every stream
      // once so the renderer always receives an authoritative current frame.
      this.suspendedDirtyPaneIds.add(stream.paneId);
      if (stream.timer) {
        clearInterval(stream.timer);
        stream.timer = null;
      }
      if (stream.writeCaptureTimer) {
        clearTimeout(stream.writeCaptureTimer);
        stream.writeCaptureTimer = null;
      }
      if (stream.resizeRepaintTimer) {
        clearTimeout(stream.resizeRepaintTimer);
        stream.resizeRepaintTimer = null;
      }
      this.transcriptStream.pauseFollowing(stream);
      this.stopPtyOsc52Follower(stream.paneId);
    }
    log.debug('terminal', 'Renderer delivery suspended', { streams: this.streams.size });
  }

  resumeRendererDelivery(): Promise<void> {
    // A show can arrive while a previous restore is still running (for
    // example show → hide → show in quick succession). Update the desired
    // state before reusing the in-flight promise so that restore work can
    // continue, then let its stability loop consume anything dirtied by the
    // intervening hide.
    this.rendererDesiredVisible = true;
    if (this.resumeDeliveryPromise) return this.resumeDeliveryPromise;
    if (!this.rendererDeliverySuspended) {
      return Promise.resolve();
    }

    const resume = this.restoreDirtyStreamsUntilStable()
      .finally(() => {
        if (this.resumeDeliveryPromise === resume) {
          this.resumeDeliveryPromise = null;
        }
      });
    this.resumeDeliveryPromise = resume;
    return resume;
  }

  private async restoreDirtyStreamsUntilStable(): Promise<void> {
    while (this.rendererDesiredVisible && this.suspendedDirtyPaneIds.size > 0) {
      const dirtyPaneIds = [...this.suspendedDirtyPaneIds];
      this.suspendedDirtyPaneIds.clear();
      await this.restoreSuspendedStreams(dirtyPaneIds);
    }
    if (!this.rendererDesiredVisible) return;

    await Promise.all(
      [...this.streams.values()]
        .filter((stream) => stream.mode === 'pty')
        .map((stream) => this.startPtyOsc52Follower(stream)),
    );
    if (!this.rendererDesiredVisible || this.suspendedDirtyPaneIds.size > 0) {
      await this.restoreDirtyStreamsUntilStable();
      return;
    }

    this.rendererDeliverySuspended = false;
    this.restoringPaneId = null;
    this.resumedPaneIds.clear();
  }

  async attach(
    paneId: string,
    sessionName: string,
    tmuxPaneId: string,
    transcriptPath?: string,
    requestedSize?: TerminalAttachSize,
    skipScrollbackReplay = false,
    requestedStreamId?: number,
    fixedCols?: number,
    enableMouse?: boolean,
  ): Promise<TerminalAttachResult> {
    const normalizedFixedCols = fixedCols ?? 0;
    if (normalizedFixedCols === 0) {
      this.rememberPreferredLaunchSize(requestedSize);
    }

    if (this.streams.has(paneId)) {
      log.debug('terminal', 'Already attached', { paneId });
      const existing = this.streams.get(paneId)!;
      if (requestedStreamId !== undefined) {
        existing.streamId = requestedStreamId;
      }
      existing.fixedCols = normalizedFixedCols;
      const nextEnableMouse = existing.screenReaderDetected ? false : enableMouse;
      if (existing.enableMouse !== nextEnableMouse) {
        existing.enableMouse = nextEnableMouse;
        if (nextEnableMouse !== undefined) {
          await this.ptyHandles.get(paneId)?.setMouse(nextEnableMouse);
        }
      }
      const token = this.bumpAttachToken(paneId);
      const rehydrated = await this.rehydrateExistingStream(existing, requestedSize, token);
      if (!rehydrated) {
        throw new Error(`Terminal attach lost ownership before completion: ${paneId}`);
      }
      return {
        cols: existing.cols,
        mode: existing.mode,
        rows: existing.rows,
        streamId: existing.streamId,
        windowCols: existing.cols,
        windowId: existing.windowId,
        windowPanes: 1,
        windowRows: existing.rows,
      };
    }

    const existingPending = this.pendingAttaches.get(paneId);
    if (existingPending) {
      if (requestedStreamId !== undefined && existingPending.streamId !== requestedStreamId) {
        this.bumpAttachToken(paneId);
        this.pendingAttaches.delete(paneId);
      } else {
        log.debug('terminal', 'Attach already in progress', { paneId });
        return existingPending.promise;
      }
    }

    const token = this.bumpAttachToken(paneId);
    const streamId = requestedStreamId ?? token;
    let registeredStream: PaneStream | null = null;
    const promise = this.attachInternal(
      paneId,
      sessionName,
      tmuxPaneId,
      transcriptPath,
      token,
      streamId,
      requestedSize,
      skipScrollbackReplay,
      normalizedFixedCols,
      enableMouse,
      (stream) => {
        registeredStream = stream;
      },
    )
      .catch((error: unknown) => {
        if (registeredStream) {
          try {
            this.disposeFailedRegisteredStream(registeredStream, token);
          } catch (cleanupError) {
            log.error('terminal', 'Failed to clean up rejected terminal attach', {
              cleanupError: formatError(cleanupError),
              paneId,
              token,
            });
          }
        }
        throw error;
      })
      .finally(() => {
        const pending = this.pendingAttaches.get(paneId);
        if (pending?.token === token) {
          this.pendingAttaches.delete(paneId);
        }
      });

    this.pendingAttaches.set(paneId, { promise, streamId, token });
    return promise;
  }

  detach(paneId: string): void {
    this.bumpAttachToken(paneId);
    this.invalidateQueuedPtyScrolls(paneId);
    this.clearPendingPtyWriteRetry(paneId);
    this.suspendedDirtyPaneIds.delete(paneId);
    this.resumedPaneIds.delete(paneId);
    if (this.restoringPaneId === paneId) this.restoringPaneId = null;
    this.pendingAttaches.delete(paneId);
    this.pendingWrites.delete(paneId);
    const stream = this.streams.get(paneId);
    if (!stream) {
      this.attachTokens.delete(paneId);
      this.pendingUnlocks.delete(paneId);
      if (!this.paneInteractionQueues.has(paneId)) {
        this.ptyScrollGenerations.delete(paneId);
      }
      return;
    }
    log.info('terminal', 'Detaching pane stream', { paneId });
    this.disposeStreamResources(stream);
    this.streams.delete(paneId);
    this.controlClients.stopIfIdle(stream.sessionName, this.streams.values());
    this.attachTokens.delete(paneId);
    this.pendingUnlocks.delete(paneId);
    this.ptyCopyModePanes.delete(paneId);
    this.ptyExitRetries.delete(paneId);
    this.clearPtyExitRetryResetTimer(paneId);
    if (!this.paneInteractionQueues.has(paneId)) {
      this.ptyScrollGenerations.delete(paneId);
    }
  }

  removePane(paneId: string): void {
    this.detach(paneId);
    this.screenReaderPaneIds.delete(paneId);
  }

  async resize(paneId: string, cols: number, rows: number): Promise<void> {
    const stream = this.streams.get(paneId);
    if (!stream) return;

    const resolvedCols = resolveFixedCols(cols, stream.fixedCols);
    if (resolvedCols !== cols) {
      log.debug('terminal', 'Applied exact fixed terminal width', {
        fixedCols: stream.fixedCols, paneId, requestedCols: cols,
      });
      cols = resolvedCols;
    }

    if (stream.mode === 'pty') {
      this.invalidateQueuedPtyScrolls(paneId);
    }
    await this.enqueuePaneInteraction(paneId, async () => {
      if (!this.isCurrentStream(stream)) return;
      if (stream.mode === 'pty') {
        await this.resizePtyStream(stream, cols, rows);
        return;
      }
      await this.resizeClassicStream(stream, cols, rows);
    });
  }

  private async resizeClassicStream(stream: PaneStream, cols: number, rows: number): Promise<void> {
    const paneId = stream.paneId;
    log.infoThrottled('terminal', 'Resizing tmux pane', { paneId, cols, rows });
    try {
      // Transcript-backed TUIs can emit SIGWINCH redraw bytes through
      // pipe-pane. Suppress those bytes and repaint from a fresh tmux capture
      // so live resizing does not pollute visible scrollback.
      await this.refreshAlternateState(stream);
      if (!this.isCurrentStream(stream)) return;
      if (stream.mode === 'transcript') {
        this.suppressTranscriptResizeOutput(stream);
      }
      const dimensions = await this.synchronizeTmuxGeometry(
        stream.tmuxPaneId,
        { cols, rows },
      );
      if (!this.isCurrentStream(stream)) return;
      stream.windowId = dimensions.windowId;
      await this.resetStreamAfterResize(stream, cols, rows);
      if (!this.isCurrentStream(stream)) return;
      if (stream.fixedCols === 0) {
        this.rememberPreferredLaunchSize({ cols, rows });
      }
      if (stream.mode === 'transcript') {
        this.suppressTranscriptResizeOutput(stream);
      }
      await this.capturePaneContent(stream, 'replay');
      if (!this.isCurrentStream(stream)) return;
      this.scheduleResizeRepaint(stream);
    } catch (error) {
      log.warn('terminal', 'resize-pane failed', { paneId, error });
      throw error;
    }
  }

  async write(paneId: string, data: string, userInitiated = true): Promise<void> {
    const stream = this.streams.get(paneId);
    if (!stream) {
      if (this.pendingAttaches.has(paneId)) {
        this.queuePendingWrite(paneId, data);
      }
      return;
    }

    if (stream.stdinLocked) {
      log.debug('terminal', 'write blocked (stdin locked)', {
        paneId, dataLen: data.length,
        hex: Buffer.from(data, 'utf-8').toString('hex').slice(0, 20),
      });
      return;
    }

    // PTY input never passes through the status worker. Re-arm its fast cadence
    // for actual interaction, but not for xterm's automatic protocol replies
    // (for example DA/DSR responses), which can otherwise look like perpetual
    // activity while a terminal is completely idle.
    if (userInitiated) {
      getStatusDetector().notePaneActivity(paneId);
    }

    try {
      await this.writeToAttachedStream(stream, data);
    } catch (error) {
      log.debug('terminal', 'terminal input write failed', { paneId, error });
    }
  }

  /**
   * Submit a complete shell/TUI command as one serialized interaction.
   * Returns false only when this manager does not own the exact tmux pane at
   * call time, allowing the caller to use its unmanaged fallback safely. Once
   * accepted, delivery failures reject instead of falling back and risking a
   * duplicate command.
   */
  async submitCommand(
    paneId: string,
    expectedTmuxPaneId: string,
    command: string,
  ): Promise<boolean> {
    const stream = this.streams.get(paneId);
    if (!stream || stream.tmuxPaneId !== expectedTmuxPaneId) return false;
    if (stream.stdinLocked) {
      throw new Error('Terminal input is locked while the pane is starting');
    }
    getStatusDetector().notePaneActivity(paneId);

    // Claim input that was already queued before this command. Removing it
    // synchronously establishes a strict ordering boundary: later keystrokes
    // remain queued behind the complete command operation.
    const precedingInput = stream.mode === 'pty'
      ? this.pendingWrites.get(paneId) ?? ''
      : '';
    if (precedingInput) {
      this.pendingWrites.delete(paneId);
    }
    this.clearPendingPtyWriteRetry(paneId);
    if (stream.mode === 'pty') {
      this.invalidateQueuedPtyScrolls(paneId);
    }

    await this.enqueuePaneInteraction(paneId, async () => {
      let deliveryAttempted = false;
      try {
        this.assertCommandStreamCurrent(stream, expectedTmuxPaneId);

        if (stream.mode === 'pty') {
          const copyModeExited = await this.exitPtyCopyMode(stream, 'command submission');
          this.assertCommandStreamCurrent(stream, expectedTmuxPaneId);
          if (!copyModeExited) {
            throw new Error('Unable to exit terminal copy-mode before command delivery');
          }
        } else {
          await execAsync(
            `tmux copy-mode -q -t ${shQuote(expectedTmuxPaneId)}`,
            { timeout: PTY_COPY_MODE_COMMAND_TIMEOUT_MS },
          );
          this.assertCommandStreamCurrent(stream, expectedTmuxPaneId);
        }

        // The tmux command list pastes the raw command text and sends a real
        // Enter consecutively. Mark delivery as attempted before awaiting it:
        // a failed command list may already have pasted bytes, so replaying
        // claimed input would risk a duplicate command.
        deliveryAttempted = true;
        await submitTerminalCommand(expectedTmuxPaneId, `${precedingInput}${command}`);
        if (stream.mode === 'capture') {
          this.scheduleWriteCapture(stream);
        }
      } catch (error) {
        if (
          !deliveryAttempted
          && precedingInput
          && this.isExpectedCommandStream(stream, expectedTmuxPaneId)
        ) {
          this.restorePendingWrite(paneId, precedingInput);
          if (stream.mode === 'pty') {
            this.schedulePendingPtyWriteRetry(paneId, stream);
          }
        }
        throw error;
      }
    });
    return true;
  }

  private assertCommandStreamCurrent(stream: PaneStream, expectedTmuxPaneId: string): void {
    if (!this.isExpectedCommandStream(stream, expectedTmuxPaneId)) {
      throw new Error('Terminal command target changed before delivery');
    }
    if (stream.stdinLocked) {
      throw new Error('Terminal input is locked while the pane is starting');
    }
  }

  private isExpectedCommandStream(stream: PaneStream, expectedTmuxPaneId: string): boolean {
    return this.isCurrentStream(stream) && stream.tmuxPaneId === expectedTmuxPaneId;
  }

  private async writeToAttachedStream(stream: PaneStream, data: string): Promise<void> {
    if (!data) return;
    const paneId = stream.paneId;
    if (stream.mode === 'pty') {
      this.invalidateQueuedPtyScrolls(paneId);
      this.queuePendingWrite(paneId, data);
      await this.flushPendingWrites(paneId, stream);
      return;
    }

    await this.enqueuePaneInteraction(paneId, async () => {
      if (!this.isCurrentStream(stream) || stream.stdinLocked || stream.mode === 'pty') return;
      await writeTerminalInput(stream.tmuxPaneId, data);
      if (stream.mode === 'capture') {
        this.scheduleWriteCapture(stream);
      }
    });
  }

  private queuePendingWrite(paneId: string, data: string): void {
    if (!data) return;
    this.pendingWrites.set(paneId, (this.pendingWrites.get(paneId) ?? '') + data);
  }

  private restorePendingWrite(paneId: string, data: string): void {
    if (!data) return;
    this.pendingWrites.set(paneId, data + (this.pendingWrites.get(paneId) ?? ''));
  }

  private clearPendingPtyWriteRetry(paneId: string): void {
    const timer = this.pendingPtyWriteRetryTimers.get(paneId);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingPtyWriteRetryTimers.delete(paneId);
  }

  private schedulePendingPtyWriteRetry(paneId: string, stream: PaneStream): void {
    if (this.pendingPtyWriteRetryTimers.has(paneId)) return;
    const timer = setTimeout(() => {
      if (this.pendingPtyWriteRetryTimers.get(paneId) !== timer) return;
      this.pendingPtyWriteRetryTimers.delete(paneId);
      if (!this.isCurrentStream(stream) || stream.mode !== 'pty' || stream.stdinLocked) return;
      void this.flushPendingWrites(paneId, stream).catch((error) => {
        log.warn('terminal', 'PTY pending input retry failed', {
          error: formatError(error),
          paneId,
        });
      });
    }, PTY_INPUT_RETRY_DELAY_MS);
    this.pendingPtyWriteRetryTimers.set(paneId, timer);
  }

  private async flushPendingWrites(paneId: string, stream: PaneStream): Promise<void> {
    if (stream.stdinLocked) return;
    if (stream.mode === 'pty') {
      if (!this.pendingWrites.has(paneId)) return;
      const activeDrain = this.pendingPtyDrains.get(stream);
      if (activeDrain) return activeDrain;

      // Claim the current byte batch before awaiting copy-mode cancellation.
      // Later keystrokes then remain pending behind any complete command that
      // is queued while this drain is in flight.
      const claimedInput = this.pendingWrites.get(paneId);
      if (!claimedInput) return;
      this.pendingWrites.delete(paneId);
      this.invalidateQueuedPtyScrolls(paneId);
      this.clearPendingPtyWriteRetry(paneId);
      const drain = this.enqueuePaneInteraction(paneId, async () => {
        const restoreClaimedInput = () => {
          if (this.isCurrentStream(stream)) {
            this.restorePendingWrite(paneId, claimedInput);
          }
        };
        if (!this.isCurrentStream(stream)) return;
        if (stream.mode !== 'pty' || stream.stdinLocked) {
          restoreClaimedInput();
          return;
        }
        const handle = this.ptyHandles.get(paneId);
        if (!handle) {
          restoreClaimedInput();
          this.schedulePendingPtyWriteRetry(paneId, stream);
          return;
        }
        if (!await this.cancelPtyCopyModeBeforeInput(stream)) {
          if (this.isCurrentStream(stream)) {
            restoreClaimedInput();
            this.schedulePendingPtyWriteRetry(paneId, stream);
          }
          return;
        }
        if (
          !this.isCurrentStream(stream)
          || stream.mode !== 'pty'
          || stream.stdinLocked
          || this.ptyHandles.get(paneId) !== handle
        ) {
          restoreClaimedInput();
          if (this.isCurrentStream(stream) && stream.mode === 'pty') {
            this.schedulePendingPtyWriteRetry(paneId, stream);
          }
          return;
        }
        try {
          handle.write(claimedInput);
        } catch (error) {
          log.debug('terminal', 'queued PTY terminal input write failed', { paneId, error });
          restoreClaimedInput();
          this.schedulePendingPtyWriteRetry(paneId, stream);
          return;
        }
        log.debug('terminal', 'flushed pending PTY input', {
          bytes: Buffer.byteLength(claimedInput, 'utf8'),
          paneId,
        });
      });
      this.pendingPtyDrains.set(stream, drain);
      void drain.finally(() => {
        if (this.pendingPtyDrains.get(stream) === drain) {
          this.pendingPtyDrains.delete(stream);
          if (
            this.isCurrentStream(stream)
            && !stream.stdinLocked
            && this.pendingWrites.has(paneId)
            && !this.pendingPtyWriteRetryTimers.has(paneId)
            && (stream.mode !== 'pty' || this.ptyHandles.has(paneId))
          ) {
            void this.flushPendingWrites(paneId, stream).catch((error) => {
              log.warn('terminal', 'Failed to continue draining PTY input', {
                error: formatError(error),
                paneId,
              });
            });
          }
        }
      }).catch(() => undefined);
      return drain;
    }

    const pendingInput = this.pendingWrites.get(paneId);
    if (!pendingInput) return;
    this.pendingWrites.delete(paneId);
    await this.enqueuePaneInteraction(paneId, async () => {
      if (!this.isCurrentStream(stream) || stream.stdinLocked || stream.mode === 'pty') return;
      try {
        await writeTerminalInput(stream.tmuxPaneId, pendingInput);
      } catch (error) {
        log.debug('terminal', 'queued terminal input write failed', { paneId, error });
        return;
      }
      if (stream.mode === 'capture') {
        this.scheduleWriteCapture(stream);
      }
      log.debug('terminal', 'flushed pending input after attach', {
        bytes: Buffer.byteLength(pendingInput, 'utf8'),
        paneId,
      });
    });
  }

  unlockStdin(paneId: string): void {
    const stream = this.streams.get(paneId);
    if (!stream) {
      this.pendingUnlocks.add(paneId);
      log.debug('terminal', 'stdin unlock queued (stream not attached yet)', { paneId });
      return;
    }
    if (!stream.stdinLocked) return;
    stream.stdinLocked = false;
    this.pendingUnlocks.delete(paneId);
    log.info('terminal', 'stdin unlocked', { paneId });
    if (this.pendingWrites.has(paneId)) {
      void this.flushPendingWrites(paneId, stream).catch((error) => {
        log.warn('terminal', 'Failed to flush terminal input after stdin unlock', {
          error: formatError(error),
          paneId,
        });
      });
    }
  }

  async scroll(
    paneId: string,
    direction: 'down' | 'up',
    lines: number,
    alternateScreenMode: TerminalAlternateScreenMode = 'arrow-keys',
  ): Promise<TerminalScrollResponse> {
    const stream = this.streams.get(paneId);
    if (!stream || stream.mode !== 'pty' || stream.stdinLocked) return { success: true };

    const scrollGeneration = this.ptyScrollGenerations.get(paneId) ?? 0;
    let response: TerminalScrollResponse = { success: true };
    await this.enqueuePaneInteraction(paneId, async () => {
      if (!this.isCurrentStream(stream) || stream.mode !== 'pty' || stream.stdinLocked) return;
      if ((this.ptyScrollGenerations.get(paneId) ?? 0) !== scrollGeneration) return;
      response = await this.scrollPtyPane(stream, direction, lines, alternateScreenMode);
    });
    return response;
  }

  async expandSelection(
    paneId: string,
    anchorText: string,
    currentText: string,
    direction: 'down' | 'up',
  ): Promise<TerminalSelectionExpandResponse> {
    const stream = this.streams.get(paneId);
    if (!stream || stream.mode !== 'pty') return { status: 'history-unavailable' };
    if (await this.isAlternateScreenPane(stream.tmuxPaneId)) {
      return { status: 'history-unavailable' };
    }
    if (!this.isCurrentStream(stream)) return { status: 'history-unavailable' };
    const capturedText = await capturePaneText(stream.tmuxPaneId);
    if (!this.isCurrentStream(stream)) return { status: 'history-unavailable' };
    const text = expandScrolledTerminalSelection(capturedText, anchorText, currentText, direction);
    return text === null
      ? { status: 'range-not-found' }
      : { status: 'expanded', text };
  }

  private async resizePtyStream(stream: PaneStream, cols: number, rows: number): Promise<void> {
    const paneId = stream.paneId;
    log.infoThrottled('terminal', 'Resizing PTY terminal client', { paneId, cols, rows });
    try {
      const dims = await this.synchronizeTmuxGeometry(
        stream.tmuxPaneId,
        { cols, rows },
      );
      if (!this.isCurrentStream(stream) || stream.mode !== 'pty') return;
      stream.windowId = dims.windowId;
    } catch (error) {
      log.warn('terminal', 'PTY resize failed', { paneId, error });
      throw error;
    }

    stream.cols = cols;
    stream.rows = rows;
    if (stream.fixedCols === 0) {
      this.rememberPreferredLaunchSize({ cols, rows });
    }
    try {
      // The client resize is best-effort: mid-exit-recovery the handle is
      // gone or dead, and reattachPtyStream re-attaches at stream.cols/rows,
      // so recording the size above is what must never be skipped.
      this.ptyHandles.get(paneId)?.resize(cols, rows);
    } catch (error) {
      log.debug('terminal', 'PTY client resize failed after tmux resize; recorded size for next attach', {
        error: formatError(error),
        paneId,
      });
    }
  }

  private async scrollPtyPane(
    stream: PaneStream,
    direction: 'down' | 'up',
    lines: number,
    alternateScreenMode: TerminalAlternateScreenMode,
  ): Promise<TerminalScrollResponse> {
    const paneId = stream.paneId;
    const tmuxPaneId = stream.tmuxPaneId;
    const lineCount = Math.max(1, Math.min(Math.floor(lines), PTY_SCROLL_MAX_LINES));

    const altCommand = this.buildAltScrollCommand(tmuxPaneId, direction, lineCount, alternateScreenMode, paneId);
    const normalCommand = this.buildNormalScrollCommand(tmuxPaneId, direction, lineCount, paneId);

    if (direction === 'up') {
      this.ptyCopyModePanes.add(paneId);
    }

    try {
      const stdout = await execFileAsync('tmux', [
        'if-shell', '-F', '-t', tmuxPaneId,
        '#{alternate_on}',
        altCommand,
        normalCommand,
      ]);

      if (!this.isCurrentStream(stream)) {
        await this.cleanupStalePtyCopyMode(stream);
        return { success: true };
      }

      return this.applyScrollOwnership(stdout, paneId);
    } catch (error) {
      if (!this.isCurrentStream(stream)) {
        await this.cleanupStalePtyCopyMode(stream);
        return { success: true };
      }
      if (direction === 'down' && isNotInModeError(error)) {
        this.ptyCopyModePanes.delete(paneId);
        return { success: true };
      }
      if (direction === 'down') {
        this.ptyCopyModePanes.delete(paneId);
      }
      log.debug('terminal', 'PTY tmux scroll failed', {
        direction,
        error: formatError(error),
        lines: lineCount,
        paneId,
        tmuxPaneId,
      });
      return { success: false, error: formatError(error) };
    }
  }

  private buildAltScrollCommand(
    tmuxPaneId: string,
    direction: 'down' | 'up',
    lineCount: number,
    alternateScreenMode: TerminalAlternateScreenMode,
    paneId: string,
  ): string {
    const target = shQuote(tmuxPaneId);
    const hasCopyMode = this.ptyCopyModePanes.has(paneId);
    const exitCopyMode = hasCopyMode ? `copy-mode -q -t ${target} ; ` : '';

    if (alternateScreenMode === 'opencode') {
      const input = direction === 'up' ? OPENCODE_LINE_UP_INPUT : OPENCODE_LINE_DOWN_INPUT;
      const repeatedInput = input.repeat(Math.min(lineCount, PTY_OPENCODE_SCROLL_MAX_STEPS));
      return `${PTY_SCROLL_ALT_MARKER_COMMAND} ; ${exitCopyMode}send-keys -l -t ${target} ${shQuote(repeatedInput)}`;
    }

    const key = direction === 'up' ? 'Up' : 'Down';
    const repeat = Math.min(lineCount, PTY_ALT_SCROLL_MAX_KEYS);
    return `${PTY_SCROLL_ALT_MARKER_COMMAND} ; ${exitCopyMode}send-keys -t ${target} -N ${repeat} ${key}`;
  }

  private buildNormalScrollCommand(
    tmuxPaneId: string,
    direction: 'down' | 'up',
    lineCount: number,
    paneId: string,
  ): string {
    const target = shQuote(tmuxPaneId);

    if (direction === 'up') {
      return [
        PTY_SCROLL_NORMAL_MARKER_COMMAND,
        `copy-mode -e -t ${target}`,
        `send-keys -t ${target} -X -N ${lineCount} scroll-up`,
      ].join(' ; ');
    }

    if (!this.ptyCopyModePanes.has(paneId)) {
      return PTY_SCROLL_NORMAL_MARKER_COMMAND;
    }
    return `${PTY_SCROLL_NORMAL_MARKER_COMMAND} ; send-keys -t ${target} -X -N ${lineCount} scroll-down`;
  }

  private applyScrollOwnership(stdout: string, paneId: string): TerminalScrollResponse {
    const marker = stdout.trim();
    if (marker === PTY_SCROLL_ALT_MARKER) {
      this.ptyCopyModePanes.delete(paneId);
      return { success: true };
    }
    if (marker === PTY_SCROLL_NORMAL_MARKER) {
      return { success: true };
    }
    log.debug('terminal', 'PTY scroll marker unexpected; treating as failure', { paneId, stdout });
    return { success: false, error: `unexpected scroll marker: ${marker || '(empty)'}` };
  }

  private async cleanupStalePtyCopyMode(stream: PaneStream): Promise<void> {
    try {
      await execAsync(
        `tmux copy-mode -q -t ${shQuote(stream.tmuxPaneId)}`,
        { timeout: PTY_COPY_MODE_COMMAND_TIMEOUT_MS },
      );
      this.ptyCopyModePanes.delete(stream.paneId);
    } catch (error) {
      log.debug('terminal', 'Stale PTY copy-mode cleanup failed', {
        error: formatError(error),
        paneId: stream.paneId,
        tmuxPaneId: stream.tmuxPaneId,
      });
    }
  }

  private enqueuePaneInteraction(paneId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.paneInteractionQueues.get(paneId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(task);
    this.paneInteractionQueues.set(paneId, operation);
    void operation.finally(() => {
      if (this.paneInteractionQueues.get(paneId) === operation) {
        this.paneInteractionQueues.delete(paneId);
        if (!this.streams.has(paneId)) {
          this.ptyScrollGenerations.delete(paneId);
        }
      }
    }).catch(() => undefined);
    return operation;
  }

  private invalidateQueuedPtyScrolls(paneId: string): void {
    const generation = this.ptyScrollGenerations.get(paneId) ?? 0;
    this.ptyScrollGenerations.set(paneId, generation + 1);
  }

  private async isAlternateScreenPane(tmuxPaneId: string): Promise<boolean> {
    const state = await displayPaneFormat(tmuxPaneId, ALTERNATE_ON_FORMAT);
    return state.trim() === '1';
  }

  private scheduleWriteCapture(stream: PaneStream): void {
    if (stream.writeCaptureTimer) clearTimeout(stream.writeCaptureTimer);
    stream.writeCaptureTimer = setTimeout(() => {
      stream.writeCaptureTimer = null;
      this.capturePaneContent(stream);
    }, WRITE_CAPTURE_DELAY_MS);
  }

  private scheduleTranscriptSnapshotCapture(stream: PaneStream): void {
    if (!stream.skipScrollbackReplay) return;
    if (stream.writeCaptureTimer) clearTimeout(stream.writeCaptureTimer);
    stream.writeCaptureTimer = setTimeout(() => {
      stream.writeCaptureTimer = null;
      void this.capturePaneContent(stream, 'live');
    }, WRITE_CAPTURE_DELAY_MS);
  }

  private scheduleResizeRepaint(stream: PaneStream): void {
    if (stream.mode !== 'transcript') return;
    if (stream.resizeRepaintTimer) clearTimeout(stream.resizeRepaintTimer);
    stream.resizeRepaintTimer = setTimeout(() => {
      stream.resizeRepaintTimer = null;
      void this.repaintTranscriptAfterResize(stream);
    }, RESIZE_REPAINT_DELAY_MS);
  }

  private clearResizeRepaint(stream: PaneStream): void {
    if (!stream.resizeRepaintTimer) return;
    clearTimeout(stream.resizeRepaintTimer);
    stream.resizeRepaintTimer = null;
  }

  private async repaintTranscriptAfterResize(stream: PaneStream): Promise<void> {
    if (!this.isCurrentStream(stream)) return;
    if (stream.mode !== 'transcript') return;

    this.transcriptStream.discardBufferedDataAndSeekToEnd(stream);
    stream.lastContent = NO_CONTENT;
    stream.lastCursor = null;
    await this.capturePaneContent(stream, 'replay');
    stream.transcriptSuppressedUntil = 0;
  }

  private suppressTranscriptResizeOutput(stream: PaneStream): void {
    stream.transcriptSuppressedUntil = Date.now() + RESIZE_REPAINT_DELAY_MS;
    this.transcriptStream.discardBufferedDataAndSeekToEnd(stream);
  }

  private async refreshAlternateState(stream: PaneStream, token?: number): Promise<void> {
    const isCurrent = (): boolean => this.isStreamGenerationCurrent(stream, token);
    if (!isCurrent()) return;
    const now = Date.now();
    // During the first ~10 seconds (50 captures at 200ms), check every cycle
    // to catch alternate-screen transitions quickly. After that, throttle.
    const interval = stream.alternateCheckCount < 50 ? 0 : ALTERNATE_CHECK_INTERVAL_MS;
    if (now - stream.alternateCheckedAt < interval) return;
    stream.alternateCheckedAt = now;
    stream.alternateCheckCount++;
    try {
      const raw = await displayPaneFormat(stream.tmuxPaneId, ALTERNATE_ON_FORMAT);
      if (!isCurrent()) return;
      const wasAlternate = stream.alternateOn;
      const alternateOn = raw.trim() === '1';
      let historySize = stream.historySize;
      if (wasAlternate !== alternateOn) {
        historySize = alternateOn ? -1 : await this.getHistorySize(stream.tmuxPaneId);
        if (!isCurrent()) return;
      }
      stream.alternateOn = alternateOn;
      if (wasAlternate !== alternateOn) {
        stream.lastContent = NO_CONTENT;
        stream.lastCursor = null;
        // Alternate screen has no accessible history in tmux. When leaving it,
        // seed immediately so lines cannot scroll away before the next poll.
        stream.historySize = historySize;
        log.debug('terminal', 'Scrollback tracking reset (alternate toggled)', {
          paneId: stream.paneId,
          tmuxPaneId: stream.tmuxPaneId,
          from: wasAlternate,
          to: stream.alternateOn,
          historySize: stream.historySize,
        });
      }
    } catch {
      if (isCurrent()) stream.alternateOn = false;
    }
  }

  private async resetStreamAfterResize(stream: PaneStream, cols: number, rows: number): Promise<void> {
    stream.cols = cols;
    stream.rows = rows;
    stream.lastContent = NO_CONTENT;
    stream.lastCursor = null;
    stream.historySize = stream.alternateOn ? -1 : await this.getHistorySize(stream.tmuxPaneId);

    if (stream.mode === 'control') {
      this.controlClients.refreshSize(stream);
    }

    log.debug('terminal', 'Scrollback baseline reset (resize)', {
      paneId: stream.paneId,
      cols,
      rows,
      alternateOn: stream.alternateOn,
      historySize: stream.historySize,
    });
  }

  private async getHistorySize(tmuxPaneId: string): Promise<number> {
    try {
      const raw = await displayPaneFormat(tmuxPaneId, HISTORY_SIZE_FORMAT);
      const n = parseInt(raw.trim(), 10);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  private async getCursorState(tmuxPaneId: string): Promise<CapturedPaneCursor | null> {
    try {
      const raw = await displayPaneFormat(tmuxPaneId, CURSOR_STATE_FORMAT);
      const match = raw.trim().match(/^(\d+):(\d+):(\d+)$/);
      if (!match) return null;

      return {
        x: parseInt(match[1], 10),
        y: parseInt(match[2], 10),
        visible: match[3] === '1',
      };
    } catch {
      return null;
    }
  }

  private async exitPtyCopyMode(stream: PaneStream, reason: string): Promise<boolean> {
    try {
      await execAsync(
        `tmux copy-mode -q -t ${shQuote(stream.tmuxPaneId)}`,
        { timeout: PTY_COPY_MODE_COMMAND_TIMEOUT_MS },
      );
      if (!this.isCurrentStream(stream)) return false;
      this.ptyCopyModePanes.delete(stream.paneId);
      return true;
    } catch (error) {
      if (this.isCurrentStream(stream)) {
        this.ptyCopyModePanes.add(stream.paneId);
      }
      log.warn('terminal', 'PTY copy-mode exit failed', {
        error: formatError(error),
        paneId: stream.paneId,
        reason,
        tmuxPaneId: stream.tmuxPaneId,
      });
      return false;
    }
  }

  private async cancelPtyCopyModeBeforeInput(stream: PaneStream): Promise<boolean> {
    if (!this.ptyCopyModePanes.has(stream.paneId)) return true;
    return this.exitPtyCopyMode(stream, 'input');
  }

  private capturePaneContent(
    stream: PaneStream,
    source: TerminalDataSource = 'live',
  ): Promise<void> {
    if (!this.canDeliverTerminalData(stream.paneId, source)) {
      this.markDirtyUnlessRestoring(stream.paneId);
      return Promise.resolve();
    }
    const token = this.attachTokens.get(stream.paneId);
    if (token === undefined || !this.isStreamStillCurrent(stream.paneId, stream, token)) {
      return Promise.resolve();
    }
    const activeCapture = this.capturePromises.get(stream);
    if (activeCapture) return activeCapture;

    let completion: Promise<void>;
    completion = this.performCapturePaneContent(stream, source, token)
      .catch((error: unknown) => {
        log.warn('terminal', 'Unexpected terminal capture failure', {
          error: formatError(error),
          paneId: stream.paneId,
          tmuxPaneId: stream.tmuxPaneId,
        });
      })
      .finally(() => {
        if (this.capturePromises.get(stream) === completion) {
          this.capturePromises.delete(stream);
        }
      });
    this.capturePromises.set(stream, completion);
    return completion;
  }

  private async performCapturePaneContent(
    stream: PaneStream,
    source: TerminalDataSource,
    token: number,
  ): Promise<void> {
    if (stream.capturing) return;
    if (!this.isStreamStillCurrent(stream.paneId, stream, token)) return;
    stream.capturing = true;

    try {
      await this.refreshAlternateState(stream, token);
      if (!this.isStreamStillCurrent(stream.paneId, stream, token)) return;

      const [content, cursor] = await Promise.all([
        capturePane(stream.tmuxPaneId),
        this.getCursorState(stream.tmuxPaneId),
      ]);
      if (!this.isStreamStillCurrent(stream.paneId, stream, token)) return;
      stream.consecutiveFailures = 0;
      const isFirst = stream.lastContent === NO_CONTENT;
      const contentChanged = content !== stream.lastContent;
      const cursorChanged = !cursorStateEquals(cursor, stream.lastCursor);

      if (contentChanged || cursorChanged) {
        if (!this.isStreamStillCurrent(stream.paneId, stream, token)) return;
        stream.lastContent = content;
        stream.lastCursor = cursor;
        let scrollbackPrefix = '';

        // Preserve tmux scrollback in xterm by appending any newly-scrolled
        // history lines as real linefeeds, then repaint the visible frame.
        //
        // Without this, our frame-based rendering keeps xterm's baseY at 0,
        // making it appear like prior questions/answers "disappear" as the
        // pane scrolls.
        if (stream.alternateOn) {
          stream.historySize = -1;
        } else {
          const currentHistorySize = await this.getHistorySize(stream.tmuxPaneId);
          if (!this.isStreamStillCurrent(stream.paneId, stream, token)) return;
          if (stream.historySize < 0) {
            stream.historySize = currentHistorySize;
            log.debug('terminal', 'Scrollback baseline set (late)', {
              paneId: stream.paneId,
              tmuxPaneId: stream.tmuxPaneId,
              historySize: currentHistorySize,
            });
          } else if (currentHistorySize > stream.historySize) {
            const delta = currentHistorySize - stream.historySize;
            const historyTail = await capturePane(stream.tmuxPaneId, {
              startLine: -delta,
              endLine: -1,
            });
            if (!this.isStreamStillCurrent(stream.paneId, stream, token)) return;
            const replaySource = stream.skipScrollbackReplay
              ? compactAgentScrollbackForReplay(historyTail, { dropStartupBeforePrompt: true })
              : { content: historyTail, droppedLines: 0, duplicateNumberedLines: 0, duplicateStartupFrames: 0 };
            if (replaySource.droppedLines > 0) {
              log.debug('terminal', 'Compacted duplicate agent startup scrollback delta', {
                droppedLines: replaySource.droppedLines,
                duplicateNumberedLines: replaySource.duplicateNumberedLines,
                duplicateStartupFrames: replaySource.duplicateStartupFrames,
                paneId: stream.paneId,
                tmuxPaneId: stream.tmuxPaneId,
              });
            }
            scrollbackPrefix = formatScrollbackInsert(replaySource.content, stream.rows, stream.cols);
            stream.historySize = currentHistorySize;
            log.debug('terminal', 'Scrollback sync', {
              paneId: stream.paneId,
              tmuxPaneId: stream.tmuxPaneId,
              delta,
              bytes: historyTail.length,
            });
          } else if (currentHistorySize < stream.historySize) {
            // History was cleared or reflowed; reset baseline.
            stream.historySize = currentHistorySize;
            log.debug('terminal', 'Scrollback baseline reset (history shrank)', {
              paneId: stream.paneId,
              tmuxPaneId: stream.tmuxPaneId,
              historySize: currentHistorySize,
            });
          }
        }

        if (isFirst) {
          const lines = content.split('\n');
          const l0 = stripAnsiForLog(lines[0] ?? '').slice(0, 140);
          const l1 = stripAnsiForLog(lines[1] ?? '').slice(0, 140);
          const l2 = stripAnsiForLog(lines[2] ?? '').slice(0, 140);
          log.debug('terminal', 'First capture sample', {
            paneId: stream.paneId,
            tmuxPaneId: stream.tmuxPaneId,
            alternateOn: stream.alternateOn,
            line0: l0,
            line1: l1,
            line2: l2,
          });
        }
        if (content.includes('MUXBASE_PROMPT_FILE=') || content.includes('MUXBASE_PROMPT_CONTENT=')) {
          log.debug('terminal', 'Startup signature in capture — blanking frame', {
            paneId: stream.paneId,
            alternateOn: stream.alternateOn,
            snippet: stripAnsiForLog(content.slice(0, 200)),
          });
        }
        this.sendToRenderer(
          stream.paneId,
          scrollbackPrefix + renderCapturedPaneFrame({
            alternateOn: stream.alternateOn,
            content,
            cols: stream.cols,
            rows: stream.rows,
            cursor,
            isFirst,
          }),
          source,
          stream.streamId,
        );
        if (isFirst) {
          log.info('terminal', 'First content delivered', { paneId: stream.paneId, bytes: content.length });
        }
      }
    } catch (error) {
      if (!this.isStreamStillCurrent(stream.paneId, stream, token)) return;
      const msg = String(error);
      const paneGone = msg.includes("can't find pane") || msg.includes('no such pane');

      if (paneGone) {
        log.info('terminal', 'Pane no longer exists, auto-detaching', { paneId: stream.paneId, tmuxPaneId: stream.tmuxPaneId });
        stream.capturing = false;
        this.removePane(stream.paneId);
        return;
      }

      stream.consecutiveFailures++;
      if (stream.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        log.warn('terminal', `${MAX_CONSECUTIVE_FAILURES} consecutive failures, auto-detaching`, { paneId: stream.paneId });
        stream.capturing = false;
        this.detach(stream.paneId);
        return;
      }

      log.debug('terminal', 'capture-pane failed', { paneId: stream.paneId, failures: stream.consecutiveFailures, error: msg });
    } finally {
      stream.capturing = false;
    }
  }

  private sendToRenderer(
    paneId: string,
    data: string,
    source: TerminalDataSource = 'live',
    streamId: number,
  ): void {
    this.onTerminalData?.(paneId, data, source);
    if (!this.canDeliverTerminalData(paneId, source)) {
      this.markDirtyUnlessRestoring(paneId);
      return;
    }
    if (source === 'live') {
      RuntimeActivityMetrics.getInstance().recordTerminalOutput(data);
    }
    if (source === 'replay' || data.includes('\x1bc')) {
      const sample = stripAnsiForLog(data.slice(0, 240)).replace(/\s+/g, ' ').trim().slice(0, 160);
      log.debug('terminal', 'Sending terminal data to renderer', {
        bytes: data.length,
        hardReset: data.includes('\x1bc'),
        paneId,
        sample,
        source,
        streamId,
      });
    }
    sendTerminalData(this.window, paneId, data, source, streamId);
  }

  private canDeliverTerminalData(
    paneId: string,
    source: TerminalDataSource,
  ): boolean {
    if (!this.rendererDeliverySuspended) return true;
    if (!this.rendererDesiredVisible) return false;
    if (this.resumedPaneIds.has(paneId)) return true;
    if (this.restoringPaneId !== paneId) return false;

    // A replacement PTY paints its authoritative frame as live bytes while
    // attach is still pending. Classic/control transports restore from an
    // explicit replay snapshot, so admitting their live bytes here would
    // interleave output with the reset/replay transaction.
    return source === 'replay' || this.streams.get(paneId)?.mode === 'pty';
  }

  private markDirtyUnlessRestoring(paneId: string): void {
    if (this.restoringPaneId !== paneId) {
      this.suspendedDirtyPaneIds.add(paneId);
    }
  }

  private isCurrentStream(stream: PaneStream): boolean {
    return this.streams.get(stream.paneId) === stream;
  }

  private isStreamGenerationCurrent(stream: PaneStream, token?: number): boolean {
    return token === undefined
      ? this.isCurrentStream(stream)
      : this.isStreamStillCurrent(stream.paneId, stream, token);
  }

  destroyAll(): void {
    this.pendingAttaches.clear();
    this.pendingWrites.clear();
    for (const [id] of this.streams) {
      this.detach(id);
    }
    this.controlClients.stopAll();
    this.attachTokens.clear();
    this.pendingUnlocks.clear();
    this.ptyCopyModePanes.clear();
    this.ptyScrollGenerations.clear();
    this.screenReaderPaneIds.clear();
    for (const timer of this.pendingPtyWriteRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingPtyWriteRetryTimers.clear();
    for (const paneId of this.ptyExitRetryResetTimers.keys()) {
      this.clearPtyExitRetryResetTimer(paneId);
    }
    this.suspendedDirtyPaneIds.clear();
    this.resumedPaneIds.clear();
    this.restoringPaneId = null;
    this.rendererDesiredVisible = true;
    this.rendererDeliverySuspended = false;
    this.resumeDeliveryPromise = null;
  }

  private async restoreSuspendedStreams(paneIds: string[]): Promise<void> {
    for (const paneId of paneIds) {
      if (!this.rendererDesiredVisible) return;
      const stream = this.streams.get(paneId);
      if (!stream) continue;

      this.restoringPaneId = paneId;
      try {
        await this.restoreStreamSnapshot(stream);
      } catch (error) {
        log.warn('terminal', 'Failed to restore terminal after renderer resumed', {
          error: formatError(error),
          paneId,
        });
      } finally {
        if (this.rendererDesiredVisible && this.isCurrentStream(stream)) {
          this.resumedPaneIds.add(paneId);
          this.transcriptStream.resumeFollowing(stream);
          this.startCapturePolling(stream);
        }
        if (this.restoringPaneId === paneId) this.restoringPaneId = null;
      }
    }
    log.debug('terminal', 'Renderer delivery resumed', { streams: paneIds.length });
  }

  private async restoreStreamSnapshot(stream: PaneStream): Promise<void> {
    if (!this.rendererDesiredVisible || !this.isCurrentStream(stream)) return;

    if (stream.mode === 'pty') {
      // The renderer already holds the authoritative frozen frame while tmux
      // copy-mode is active. Replacing this PTY would exit copy-mode and jump
      // the user back to live output merely because the window was restored.
      if (this.ptyCopyModePanes.has(stream.paneId)) {
        const paneInMode = await displayPaneFormat(stream.tmuxPaneId, PANE_IN_MODE_FORMAT);
        if (!this.rendererDesiredVisible || !this.isCurrentStream(stream)) return;
        if (paneInMode.trim() === '1') return;
        this.ptyCopyModePanes.delete(stream.paneId);
      }
      const token = this.attachTokens.get(stream.paneId);
      if (token === undefined) return;
      await this.reattachPtyStream(stream, undefined, token);
      return;
    }

    await this.enqueuePaneInteraction(stream.paneId, async () => {
      const activeCapture = this.capturePromises.get(stream);
      if (activeCapture) await activeCapture;
      if (!this.rendererDesiredVisible || !this.isCurrentStream(stream)) return;

      this.transcriptStream.discardBufferedDataAndSeekToEnd(stream);
      this.sendToRenderer(stream.paneId, '\x1bc', 'replay', stream.streamId);

      if (stream.skipScrollbackReplay) {
        await this.replayAgentPaneSnapshot(stream);
        return;
      }

      await this.refreshAlternateState(stream);
      if (!this.rendererDesiredVisible || !this.isCurrentStream(stream)) return;
      stream.historySize = stream.alternateOn ? -1 : await this.getHistorySize(stream.tmuxPaneId);
      if (!this.rendererDesiredVisible || !this.isCurrentStream(stream)) return;
      if (!stream.alternateOn && stream.historySize > 0) {
        await this.replayInitialScrollback(stream, stream.historySize);
      }
      if (!this.rendererDesiredVisible || !this.isCurrentStream(stream)) return;
      stream.lastContent = NO_CONTENT;
      stream.lastCursor = null;
      await this.capturePaneContent(stream, 'replay');
    });
  }

  private startCapturePolling(stream: PaneStream): void {
    if (
      (this.rendererDeliverySuspended && !this.resumedPaneIds.has(stream.paneId))
      || stream.mode !== 'capture'
      || stream.timer
      || !this.isCurrentStream(stream)
    ) {
      return;
    }
    stream.timer = setInterval(() => this.capturePaneContent(stream), this.pollIntervalMs);
  }

  private async prepareAttachGeometry(
    paneId: string,
    sessionName: string,
    tmuxPaneId: string,
    token: number,
    requestedSize: TerminalAttachSize | undefined,
    fixedCols: number,
    skipScrollbackReplay: boolean,
    transcriptAvailable: boolean,
    transcriptPath: string | undefined,
  ): Promise<AttachGeometryPreparation> {
    const hasUsableRequestedSize = isUsableTerminalSize(requestedSize);
    let preparation: AttachGeometryPreparation | undefined;

    await this.enqueuePaneInteraction(paneId, async () => {
      let dims = await readPaneDimensions(tmuxPaneId);
      const usePty = this.shouldUsePtyMode(sessionName, dims.windowId);
      const useTranscript = !usePty && transcriptAvailable;
      const useControl = !usePty && this.shouldUseControlMode(sessionName);
      const geometryLockedAgentStream = skipScrollbackReplay && (useTranscript || useControl);
      const requestedSizeMatches = hasUsableRequestedSize
        && dims.cols === requestedSize.cols
        && dims.rows === requestedSize.rows;
      const canPreSizeGeometryLockedStream = hasUsableRequestedSize
        && isNonShrinkingResize(dims, requestedSize);
      const savePreparation = (): void => {
        preparation = {
          canPreSizeGeometryLockedStream,
          dims,
          geometryLockedAgentStream,
          requestedSizeMatches,
          useControl,
          usePty,
          useTranscript,
        };
      };

      if (!this.isAttachTokenCurrent(paneId, token)) {
        savePreparation();
        return;
      }

      if (fixedCols > 0 || usePty) {
        const targetSize = hasUsableRequestedSize
          ? requestedSize
          : { cols: resolveFixedCols(dims.cols, fixedCols), rows: dims.rows };
        dims = await this.synchronizeTmuxGeometry(tmuxPaneId, targetSize, dims);
      } else if (
        hasUsableRequestedSize
        && !requestedSizeMatches
        && (!geometryLockedAgentStream || canPreSizeGeometryLockedStream)
      ) {
        log.info('terminal', 'Pre-sizing tmux pane before attach replay', {
          fromCols: dims.cols,
          fromRows: dims.rows,
          paneId,
          toCols: requestedSize.cols,
          toRows: requestedSize.rows,
          tmuxPaneId,
        });
        dims = await this.synchronizeTmuxGeometry(tmuxPaneId, requestedSize, dims);
      }

      if (
        hasUsableRequestedSize
        && fixedCols === 0
        && geometryLockedAgentStream
        && !requestedSizeMatches
        && !canPreSizeGeometryLockedStream
      ) {
        log.debug('terminal', 'Deferring agent transcript geometry until after snapshot replay', {
          paneId,
          requestedCols: requestedSize.cols,
          requestedRows: requestedSize.rows,
          tmuxCols: dims.cols,
          tmuxRows: dims.rows,
          tmuxPaneId,
          transcriptPath,
          useControl,
          useTranscript,
        });
      }
      savePreparation();
    });

    if (!preparation) {
      throw new Error(`Terminal attach geometry transaction produced no result: ${paneId}`);
    }
    return preparation;
  }

  private async attachInternal(
    paneId: string,
    sessionName: string,
    tmuxPaneId: string,
    transcriptPath: string | undefined,
    token: number,
    streamId: number,
    rawRequestedSize?: TerminalAttachSize,
    skipScrollbackReplay = false,
    fixedCols = 0,
    enableMouse?: boolean,
    onRegistered?: (stream: PaneStream) => void,
  ): Promise<TerminalAttachResult> {
    const requestedSize = rawRequestedSize && fixedCols > 0
      ? { cols: fixedCols, rows: rawRequestedSize.rows }
      : rawRequestedSize;
    log.info('terminal', 'Attaching pane stream', {
      fixedCols,
      enableMouse,
      paneId,
      requestedCols: requestedSize?.cols,
      requestedRows: requestedSize?.rows,
      sessionName,
      skipScrollbackReplay,
      tmuxPaneId,
      transcriptPath,
    });

    const transcriptAvailable = !!(transcriptPath && existsSync(transcriptPath));
    if (transcriptPath && !transcriptAvailable) {
      log.warn('terminal', 'Transcript path provided but missing on disk; falling back to capture-pane', { paneId, tmuxPaneId, transcriptPath });
    }
    // Geometry discovery and mutation share the pane interaction queue with
    // resize/input work. Superseding attaches therefore run in generation
    // order, and the newest attach is always the final geometry owner.
    const {
      dims,
      useControl,
      usePty,
      useTranscript,
    } = await this.prepareAttachGeometry(
      paneId,
      sessionName,
      tmuxPaneId,
      token,
      requestedSize,
      fixedCols,
      skipScrollbackReplay,
      transcriptAvailable,
      transcriptPath,
    );
    if (!this.isAttachTokenCurrent(paneId, token)) {
      log.debug('terminal', 'Attach canceled after geometry transaction', {
        paneId,
        phase: 'geometry',
        token,
      });
      return { ...dims, streamId };
    }

    const classicFallbackMode: 'capture' | 'transcript' = transcriptAvailable ? 'transcript' : 'capture';
    if (this.streams.has(paneId)) {
      const existing = this.streams.get(paneId)!;
      log.debug('terminal', 'Attach race resolved to existing stream', { paneId });
      return {
        cols: existing.cols,
        mode: existing.mode,
        rows: existing.rows,
        streamId: existing.streamId,
        windowCols: existing.cols,
        windowId: existing.windowId,
        windowPanes: 1,
        windowRows: existing.rows,
      };
    }

    const initialHistorySize = usePty ? 0 : await this.getHistorySize(tmuxPaneId);
    if (!this.isAttachTokenCurrent(paneId, token)) {
      log.debug('terminal', 'Attach canceled before stream start', { paneId, token, phase: 'history' });
      return { ...dims, streamId };
    }

    const screenReaderDetected = this.screenReaderPaneIds.has(paneId);
    const stream: PaneStream = {
      paneId,
      sessionName,
      skipScrollbackReplay: skipScrollbackReplay && (useTranscript || useControl),
      streamId,
      tmuxPaneId,
      windowId: dims.windowId,
      mode: usePty ? 'pty' : useControl ? 'control' : useTranscript ? 'transcript' : 'capture',
      timer: null,
      lastContent: NO_CONTENT,
      attachedAt: Date.now(),
      initialized: false,
      cols: dims.cols,
      rows: dims.rows,
      capturing: false,
      fixedCols,
      enableMouse: screenReaderDetected ? false : enableMouse,
      screenReaderDetected,
      consecutiveFailures: 0,
      writeCaptureTimer: null,
      resizeRepaintTimer: null,
      alternateOn: false,
      alternateCheckedAt: 0,
      alternateCheckCount: 0,
      stdinLocked: true,
      historySize: initialHistorySize,
      lastCursor: null,

      transcriptPath: transcriptAvailable ? transcriptPath! : null,
      transcriptFd: null,
      transcriptDev: null,
      transcriptIno: null,
      transcriptOffset: 0,
      transcriptDecoder: null,
      transcriptWatcher: null,
      transcriptPollTimer: null,
      transcriptPending: '',
      transcriptPendingSource: null,
      transcriptFlushTimer: null,
      transcriptReplayInFlight: false,
      transcriptSuppressedUntil: 0,
      controlLiveBuffer: '',
      controlUnsubscribe: null,
    };

    this.streams.set(paneId, stream);
    if (this.rendererDeliverySuspended) {
      this.suspendedDirtyPaneIds.add(paneId);
    }
    onRegistered?.(stream);
    log.info('terminal', 'Terminal transport resolved', {
      configuredTransport: this.transportMode,
      historySize: initialHistorySize,
      mode: stream.mode,
      paneId,
      ptyFallback: this.transportMode === 'pty' && stream.mode !== 'pty',
      skipScrollbackReplay: stream.skipScrollbackReplay,
      streamId,
      tmuxCols: dims.cols,
      tmuxRows: dims.rows,
      tmuxPaneId,
      transcriptAvailable,
      transcriptPath: stream.transcriptPath,
    });
    if (this.pendingUnlocks.has(paneId)) {
      stream.stdinLocked = false;
      this.pendingUnlocks.delete(paneId);
      log.info('terminal', 'stdin unlocked (applied queued request)', { paneId });
    }
    if (!usePty) {
      void this.flushPendingWrites(paneId, stream);
    }
    if (!useTranscript) {
      log.debug('terminal', 'Scrollback baseline set (attach)', { paneId, tmuxPaneId, historySize: initialHistorySize });
    }

    if (usePty) {
      await this.startPtyOsc52Follower(stream);
      if (!this.isStreamStillCurrent(paneId, stream, token)) {
        this.disposeStaleAttachStream(paneId, stream, token, 'pty-policy');
        return { ...dims, streamId };
      }
      // The client always attaches at the pane's actual tmux geometry (dims
      // reflect any fresh-pane pre-size above); the renderer adopts this size
      // from the attach response instead of forcing its container size.
      const attachedPty = await this.attachPty(
        stream,
        { cols: dims.cols, rows: dims.rows },
        token,
      );
      if (!this.isStreamStillCurrent(paneId, stream, token)) {
        this.disposeStaleAttachStream(paneId, stream, token, 'pty');
        return { ...dims, streamId };
      }
      if (attachedPty) {
        stream.initialized = true;
        void this.flushPendingWrites(paneId, stream);
        log.info('terminal', 'Pane stream started (pty)', {
          activeCount: this.streams.size,
          cols: stream.cols,
          paneId,
          rows: stream.rows,
        });
        return { ...dims, cols: stream.cols, mode: stream.mode, rows: stream.rows, streamId };
      }
      stream.skipScrollbackReplay = skipScrollbackReplay && classicFallbackMode === 'transcript';
      this.stopPtyOsc52Follower(stream.paneId);
      this.prepareClassicFallback(stream, classicFallbackMode);
      void this.flushPendingWrites(paneId, stream);
      if (classicFallbackMode === 'transcript' && stream.transcriptPath) {
        await this.startTranscriptStream(stream, stream.transcriptPath, token);
        if (!this.isStreamStillCurrent(paneId, stream, token)) {
          this.disposeStaleAttachStream(paneId, stream, token, 'pty-transcript-fallback');
          return { ...dims, streamId };
        }
        stream.initialized = true;
        log.info('terminal', 'Pane stream started (pty transcript fallback)', {
          activeCount: this.streams.size,
          cols: stream.cols,
          paneId,
          rows: stream.rows,
        });
        return { ...dims, mode: stream.mode, streamId };
      }
    }

    if (useControl) {
      const attachedControl = await this.attachControl(stream, sessionName, token);
      if (!this.isStreamStillCurrent(paneId, stream, token)) {
        this.disposeStaleAttachStream(paneId, stream, token, 'control');
        return { ...dims, streamId };
      }
      if (attachedControl) {
        stream.initialized = true;
        this.flushControlLiveBuffer(stream);
        log.info('terminal', 'Pane stream started (control)', { paneId, activeCount: this.streams.size, cols: dims.cols, rows: dims.rows });
        return { ...dims, mode: stream.mode, streamId };
      }
      this.prepareClassicFallback(stream, useTranscript ? 'transcript' : 'capture');
      this.controlClients.stopIfIdle(sessionName, this.streams.values());
    }

    if (useTranscript) {
      await this.startTranscriptStream(stream, transcriptPath!, token);
      if (!this.isStreamStillCurrent(paneId, stream, token)) {
        this.disposeStaleAttachStream(paneId, stream, token, 'transcript');
        return { ...dims, streamId };
      }
      stream.initialized = true;
      log.info('terminal', 'Pane stream started (transcript)', { paneId, activeCount: this.streams.size, cols: dims.cols, rows: dims.rows });
      return { ...dims, mode: stream.mode, streamId };
    }

    // capture-pane mode: replay existing scrollback so the user can scroll up
    // to the full history, then start polling for live updates.
    if (!stream.skipScrollbackReplay && initialHistorySize > 0) {
      await this.replayInitialScrollback(stream, initialHistorySize);
      if (!this.isStreamStillCurrent(paneId, stream, token)) {
        this.disposeStaleAttachStream(paneId, stream, token, 'scrollback-replay');
        return { ...dims, streamId };
      }
    }

    this.startCapturePolling(stream);
    this.capturePaneContent(stream);
    if (!this.isStreamStillCurrent(paneId, stream, token)) {
      this.disposeStaleAttachStream(paneId, stream, token, 'capture');
      return { ...dims, streamId };
    }

    stream.initialized = true;
    log.info('terminal', 'Pane stream started', { paneId, activeCount: this.streams.size, cols: dims.cols, rows: dims.rows });
    return { ...dims, mode: stream.mode, streamId };
  }

  private async attachPty(
    stream: PaneStream,
    size: TerminalAttachSize,
    token: number,
  ): Promise<boolean> {
    // Handle replacement and copy-mode cleanup are one lifecycle barrier.
    // This waits for an active scroll, drops queued pre-attach scrolls, and
    // prevents input from observing a half-replaced PTY client.
    this.invalidateQueuedPtyScrolls(stream.paneId);
    let attached = false;
    await this.enqueuePaneInteraction(stream.paneId, async () => {
      attached = await this.attachPtyWithinInteraction(stream, size, token);
    });
    return attached;
  }

  /** Must run inside the pane interaction queue. */
  private async attachPtyWithinInteraction(
    stream: PaneStream,
    size: TerminalAttachSize,
    token: number,
  ): Promise<boolean> {
    const windowId = stream.windowId;
    if (!windowId || !this.isStreamStillCurrent(stream.paneId, stream, token)) return false;

    this.disposePtyResources(stream);
    this.sendToRenderer(stream.paneId, '\x1bc', 'replay', stream.streamId);
    let handle: TerminalPtyHandle | null = null;
    let exitedBeforeAttach = false;
    try {
      handle = await this.ptyService.attach({
        cols: size.cols,
        enableMouse: stream.enableMouse,
        onData: (paneId, data, source) => {
          if (!this.isStreamStillCurrent(paneId, stream, token)) return;
          if (handle !== null && this.ptyHandles.get(paneId) !== handle) return;
          if (!this.canDeliverTerminalData(paneId, source)) {
            this.markDirtyUnlessRestoring(paneId);
            return;
          }
          this.transcriptStream.queue(stream, data, source);
        },
        onExit: (paneId, event) => {
          if (!this.isStreamStillCurrent(paneId, stream, token)) return;
          if (handle === null) {
            exitedBeforeAttach = true;
            return;
          }
          if (this.ptyHandles.get(paneId) !== handle) return;

          // Invalidate the dead client synchronously. node-pty write() can
          // accept bytes for an exited file descriptor and report failure
          // only later, after the caller has already discarded its buffer.
          const exitedHandle = handle;
          this.ptyHandles.delete(paneId);
          try {
            exitedHandle.dispose();
          } catch (error) {
            log.debug('terminal', 'Exited PTY handle disposal failed', {
              error: formatError(error),
              paneId,
            });
          }
          log.info('terminal', 'PTY terminal stream exited', {
            event,
            paneId,
            sessionName: stream.sessionName,
            tmuxPaneId: stream.tmuxPaneId,
          });
          void this.recoverPtyStreamExit(stream, event);
        },
        onScreenReaderDetected: (paneId) => {
          if (!this.isStreamStillCurrent(paneId, stream, token)) return;
          this.screenReaderPaneIds.add(paneId);
          stream.screenReaderDetected = true;
          stream.enableMouse = false;
        },
        paneId: stream.paneId,
        rows: size.rows,
        sessionName: stream.sessionName,
        streamId: stream.streamId,
        tmuxPaneId: stream.tmuxPaneId,
        windowId,
      });
    } catch (error) {
      log.warn('terminal', 'PTY attach failed; falling back to classic terminal transport', {
        error: formatError(error),
        paneId: stream.paneId,
        sessionName: stream.sessionName,
        tmuxPaneId: stream.tmuxPaneId,
      });
      return false;
    }

    if (!this.isStreamStillCurrent(stream.paneId, stream, token)) {
      handle.dispose();
      return false;
    }
    if (exitedBeforeAttach) {
      handle.dispose();
      log.warn('terminal', 'PTY terminal stream exited before attach completed; using classic fallback', {
        paneId: stream.paneId,
        sessionName: stream.sessionName,
        tmuxPaneId: stream.tmuxPaneId,
      });
      return false;
    }
    this.ptyHandles.set(stream.paneId, handle);
    stream.cols = size.cols;
    stream.rows = size.rows;

    // Copy-mode belongs to the source tmux pane and survives PTY teardown.
    // Await its authoritative exit before exposing the replacement handle.
    await this.exitPtyCopyMode(stream, 'pty attach');
    if (
      !this.isStreamStillCurrent(stream.paneId, stream, token)
      || this.ptyHandles.get(stream.paneId) !== handle
    ) return false;
    return true;
  }

  private async startPtyOsc52Follower(stream: PaneStream): Promise<void> {
    if (
      !this.rendererDesiredVisible
      || !stream.transcriptPath
      || this.ptyOsc52FollowerHandles.has(stream.paneId)
    ) return;

    try {
      const clipboardPolicy = (await execAsync(
        'tmux show-options -sv set-clipboard',
        { silent: true },
      )).trim();
      // Only known non-forwarding policies need the app-local path. `on`
      // already forwards application OSC 52; unknown values fail closed so a
      // lookup anomaly cannot duplicate renderer prompts or clipboard writes.
      if (clipboardPolicy !== 'external' && clipboardPolicy !== 'off') {
        log.debug('terminal', 'PTY OSC 52 transcript follower skipped for unknown policy', {
          clipboardPolicy,
          paneId: stream.paneId,
        });
        return;
      }
      if (
        !this.rendererDesiredVisible
        || !this.isCurrentStream(stream)
        || stream.mode !== 'pty'
      ) return;

      const handle = this.ptyOsc52Follower.attach(stream.transcriptPath, (sequence) => {
        if (!this.isCurrentStream(stream) || stream.mode !== 'pty') return;
        this.sendToRenderer(stream.paneId, sequence, 'live', stream.streamId);
      });
      if (
        !this.rendererDesiredVisible
        || !this.isCurrentStream(stream)
        || stream.mode !== 'pty'
      ) {
        handle.dispose();
        return;
      }
      this.ptyOsc52FollowerHandles.set(stream.paneId, handle);
      log.debug('terminal', 'PTY OSC 52 transcript follower attached', {
        clipboardPolicy,
        paneId: stream.paneId,
        transcriptPath: stream.transcriptPath,
      });
    } catch (error) {
      // Fail closed: an unknown policy could already be `on`, where starting
      // the follower would duplicate clipboard prompts/writes.
      log.warn('terminal', 'PTY OSC 52 transcript follower unavailable', {
        error: formatError(error),
        paneId: stream.paneId,
        transcriptPath: stream.transcriptPath,
      });
    }
  }

  private stopPtyOsc52Follower(paneId: string): void {
    const handle = this.ptyOsc52FollowerHandles.get(paneId);
    if (!handle) return;
    this.ptyOsc52FollowerHandles.delete(paneId);
    handle.dispose();
  }

  private async attachControl(stream: PaneStream, sessionName: string, token: number): Promise<boolean> {
    try {
      const client = this.controlClients.get(sessionName);
      await client.ensureStarted(sessionName);
      if (!this.isStreamStillCurrent(stream.paneId, stream, token)) return true;
      this.controlClients.refreshSize(stream);

      stream.controlUnsubscribe = client.subscribePane(stream.tmuxPaneId, {
        onOutput: (data) => this.handleControlOutput(stream, data),
        onUnavailable: (reason) => {
          void this.fallbackControlStream(stream, reason);
        },
      });

      this.sendToRenderer(stream.paneId, '\x1bc', 'replay', stream.streamId);
      if (stream.skipScrollbackReplay) {
        await this.replayAgentPaneSnapshot(stream);
      } else if (!stream.skipScrollbackReplay && stream.historySize > 0) {
        await this.replayInitialScrollback(stream, stream.historySize);
      }
      if (!this.isStreamStillCurrent(stream.paneId, stream, token)) return true;
      if (!stream.skipScrollbackReplay) {
        await this.capturePaneContent(stream, 'replay');
      }

      return true;
    } catch (error) {
      stream.controlUnsubscribe?.();
      stream.controlUnsubscribe = null;
      stream.controlLiveBuffer = '';
      log.warn('terminal', 'Control mode attach failed; falling back to classic terminal transport', {
        paneId: stream.paneId,
        sessionName,
        tmuxPaneId: stream.tmuxPaneId,
        error,
      });
      return false;
    }
  }

  private async fallbackControlStream(stream: PaneStream, reason: string): Promise<void> {
    if (!this.isCurrentStream(stream) || stream.mode !== 'control') return;

    log.warn('terminal', 'Control mode became unavailable; falling back to classic terminal transport', {
      paneId: stream.paneId,
      sessionName: stream.sessionName,
      tmuxPaneId: stream.tmuxPaneId,
      reason,
    });

    const fallbackMode = stream.transcriptPath && existsSync(stream.transcriptPath) ? 'transcript' : 'capture';
    this.disposeStreamResources(stream);
    this.prepareClassicFallback(stream, fallbackMode);
    sendTerminalStreamModeChanged(this.window, stream.paneId, stream.streamId, fallbackMode);
    this.controlClients.stopIfIdle(stream.sessionName, this.streams.values());

    try {
      if (fallbackMode === 'transcript' && stream.transcriptPath) {
        await this.startTranscriptStream(stream, stream.transcriptPath);
      } else {
        stream.historySize = await this.getHistorySize(stream.tmuxPaneId);
        if (!stream.skipScrollbackReplay && stream.historySize > 0) {
          await this.replayInitialScrollback(stream, stream.historySize);
        }
        this.startCapturePolling(stream);
        await this.capturePaneContent(stream);
      }

      if (this.isCurrentStream(stream)) {
        stream.initialized = true;
        log.info('terminal', 'Classic terminal fallback started', {
          paneId: stream.paneId,
          mode: fallbackMode,
        });
      }
    } catch (error) {
      log.warn('terminal', 'Classic terminal fallback failed', { paneId: stream.paneId, error });
    }
  }

  private async startTranscriptStream(stream: PaneStream, transcriptPath: string, token?: number): Promise<void> {
    log.debug('terminal', 'Starting transcript stream replay', {
      historySize: stream.historySize,
      paneId: stream.paneId,
      skipScrollbackReplay: stream.skipScrollbackReplay,
      streamId: stream.streamId,
      token,
      transcriptPath,
    });
    this.sendToRenderer(stream.paneId, '\x1bc', 'replay', stream.streamId);
    if (stream.skipScrollbackReplay) {
      await this.replayAgentPaneSnapshot(stream);
      if (!this.isTranscriptStreamCurrent(stream, token)) return;
      await this.transcriptStream.attach(stream, transcriptPath);
      if (!this.isTranscriptStreamCurrent(stream, token)) return;
      if (!this.rendererDesiredVisible) this.transcriptStream.pauseFollowing(stream);
      await this.captureAgentTranscriptFollowSnapshot(stream);
      return;
    } else {
      if (stream.historySize > 0) {
        await this.replayInitialScrollback(stream, stream.historySize);
        if (!this.isTranscriptStreamCurrent(stream, token)) return;
      }
      await this.capturePaneContent(stream, 'replay');
      if (!this.isTranscriptStreamCurrent(stream, token)) return;
    }
    await this.transcriptStream.attach(stream, transcriptPath);
    if (!this.rendererDesiredVisible) this.transcriptStream.pauseFollowing(stream);
  }

  private async captureAgentTranscriptFollowSnapshot(stream: PaneStream): Promise<void> {
    if (!stream.skipScrollbackReplay) return;
    await this.capturePaneContent(stream, 'live');
  }

  private isTranscriptStreamCurrent(stream: PaneStream, token?: number): boolean {
    return token === undefined
      ? this.isCurrentStream(stream)
      : this.isStreamStillCurrent(stream.paneId, stream, token);
  }

  private async replayAgentPaneSnapshot(stream: PaneStream): Promise<void> {
    await this.refreshAlternateState(stream);
    stream.historySize = stream.alternateOn ? -1 : await this.getHistorySize(stream.tmuxPaneId);
    log.debug('terminal', 'Replaying agent pane snapshot', {
      alternateOn: stream.alternateOn,
      historySize: stream.historySize,
      paneId: stream.paneId,
      streamId: stream.streamId,
      tmuxPaneId: stream.tmuxPaneId,
    });
    if (!stream.alternateOn && stream.historySize > 0) {
      await this.replayInitialScrollback(stream, stream.historySize);
    }
    stream.lastContent = NO_CONTENT;
    stream.lastCursor = null;
    await this.capturePaneContent(stream, 'replay');
  }

  private flushControlLiveBuffer(stream: PaneStream): void {
    const buffered = stream.controlLiveBuffer;
    if (!buffered) return;
    stream.controlLiveBuffer = '';
    this.transcriptStream.queue(stream, buffered, 'live');
  }

  private handleControlOutput(stream: PaneStream, data: string): void {
    if (!this.isCurrentStream(stream) || stream.mode !== 'control') return;

    if (!stream.initialized) {
      stream.controlLiveBuffer += data;
      return;
    }

    if (!this.canDeliverTerminalData(stream.paneId, 'live')) {
      this.markDirtyUnlessRestoring(stream.paneId);
      return;
    }
    this.transcriptStream.queue(stream, data, 'live');
  }

  private prepareClassicFallback(stream: PaneStream, mode: 'capture' | 'transcript'): void {
    this.clearPendingPtyWriteRetry(stream.paneId);
    stream.mode = mode;
    stream.initialized = false;
    stream.capturing = false;
    stream.consecutiveFailures = 0;
    stream.lastContent = NO_CONTENT;
    stream.lastCursor = null;
    stream.controlLiveBuffer = '';
    if (mode === 'capture') {
      stream.skipScrollbackReplay = false;
    }
  }

  private async rehydrateExistingStream(
    stream: PaneStream,
    requestedSize: TerminalAttachSize | undefined,
    token: number,
  ): Promise<boolean> {
    if (!await this.awaitCaptureCompletion(stream, token)) return false;

    const rehydrateSize = isUsableTerminalSize(requestedSize)
      ? {
          cols: resolveFixedCols(requestedSize.cols, stream.fixedCols),
          rows: requestedSize.rows,
        }
      : stream.fixedCols > 0
        ? { cols: stream.fixedCols, rows: stream.rows }
        : undefined;
    if (stream.mode !== 'pty' && rehydrateSize) {
      // Reattach is an ownership boundary: verify the live source even when
      // the cached grid already matches. Another tmux client may have resized
      // the shared window while the renderer was gone.
      await this.resize(stream.paneId, rehydrateSize.cols, rehydrateSize.rows);
      if (!this.isRehydrateCurrent(stream, token)) return false;
    }

    if (!this.isRehydrateCurrent(stream, token)) return false;
    if (stream.mode === 'transcript' && !stream.skipScrollbackReplay) {
      this.suppressTranscriptResizeOutput(stream);
    }

    if (stream.mode === 'pty') {
      await this.reattachPtyStream(stream, requestedSize, token);
      return this.isRehydrateCurrent(stream, token);
    }

    await this.refreshAlternateState(stream);
    if (!this.isRehydrateCurrent(stream, token)) return false;
    if (stream.alternateOn) {
      stream.historySize = -1;
    } else {
      const historySize = await this.getHistorySize(stream.tmuxPaneId);
      if (!this.isRehydrateCurrent(stream, token)) return false;
      stream.historySize = historySize;
    }
    this.sendToRenderer(stream.paneId, '\x1bc', 'replay', stream.streamId);
    if (stream.skipScrollbackReplay && stream.transcriptPath) {
      await this.replayAgentPaneSnapshot(stream);
    } else if (!stream.skipScrollbackReplay && stream.historySize > 0) {
      await this.replayInitialScrollback(stream, stream.historySize);
    }
    if (!this.isRehydrateCurrent(stream, token)) return false;

    stream.lastContent = NO_CONTENT;
    stream.lastCursor = null;
    if (!stream.skipScrollbackReplay) {
      await this.capturePaneContent(stream, 'replay');
    }
    if (!this.isRehydrateCurrent(stream, token)) return false;

    if (stream.mode === 'transcript') {
      this.transcriptStream.discardBufferedDataAndSeekToEnd(stream);
      stream.transcriptSuppressedUntil = 0;
      this.transcriptStream.readNewData(stream);
      await this.captureAgentTranscriptFollowSnapshot(stream);
      if (!this.isRehydrateCurrent(stream, token)) return false;
    }
    return true;
  }

  private isRehydrateCurrent(stream: PaneStream, token: number): boolean {
    return this.isStreamStillCurrent(stream.paneId, stream, token);
  }

  private async awaitCaptureCompletion(
    stream: PaneStream,
    token: number,
  ): Promise<boolean> {
    while (true) {
      const current = this.isRehydrateCurrent(stream, token);
      if (!current) return false;

      const activeCapture = this.capturePromises.get(stream);
      if (!activeCapture) return true;
      await activeCapture;
    }
  }

  private async reattachPtyStream(
    stream: PaneStream,
    requestedSize: TerminalAttachSize | undefined,
    token: number,
  ): Promise<void> {
    if (!this.isStreamStillCurrent(stream.paneId, stream, token)) return;

    // Geometry discovery, source synchronization, and PTY replacement form
    // one transaction. A splitter resize queues wholly before or after it, so
    // the newly exposed handle always converges to the source pane's final grid.
    this.invalidateQueuedPtyScrolls(stream.paneId);
    let attached = false;
    let geometryError: unknown;
    let geometryFailed = false;
    await this.enqueuePaneInteraction(stream.paneId, async () => {
      if (!this.isStreamStillCurrent(stream.paneId, stream, token)) return;

      let size: TerminalAttachSize;
      try {
        const liveDimensions = await readPaneDimensions(stream.tmuxPaneId);
        if (!this.isStreamStillCurrent(stream.paneId, stream, token)) return;
        const requestedOrLiveSize = isUsableTerminalSize(requestedSize)
          ? requestedSize
          : { cols: liveDimensions.cols, rows: liveDimensions.rows };
        size = {
          cols: resolveFixedCols(requestedOrLiveSize.cols, stream.fixedCols),
          rows: requestedOrLiveSize.rows,
        };
        const verifiedDimensions = await this.synchronizeTmuxGeometry(
          stream.tmuxPaneId,
          size,
          liveDimensions,
        );
        if (!this.isStreamStillCurrent(stream.paneId, stream, token)) return;
        stream.windowId = verifiedDimensions.windowId;
      } catch (error) {
        geometryError = error;
        geometryFailed = true;
        return;
      }

      this.transcriptStream.dispose(stream);
      stream.initialized = false;
      stream.capturing = false;
      stream.consecutiveFailures = 0;
      stream.lastContent = NO_CONTENT;
      stream.lastCursor = null;
      attached = await this.attachPtyWithinInteraction(stream, size, token);
    });

    if (geometryFailed) {
      log.warn('terminal', 'PTY source geometry synchronization failed', {
        error: formatError(geometryError),
        paneId: stream.paneId,
        tmuxPaneId: stream.tmuxPaneId,
      });
      if (this.isStreamStillCurrent(stream.paneId, stream, token)) {
        this.detach(stream.paneId);
      }
      return;
    }
    if (!this.isStreamStillCurrent(stream.paneId, stream, token)) return;

    if (attached) {
      stream.initialized = true;
      void this.flushPendingWrites(stream.paneId, stream);
      log.info('terminal', 'Pane stream reattached (pty)', {
        cols: stream.cols,
        paneId: stream.paneId,
        rows: stream.rows,
      });
      return;
    }

    await this.startClassicFallbackAfterPtyFailure(stream, token);
  }

  private async recoverPtyStreamExit(
    stream: PaneStream,
    event: { exitCode: number; signal?: number },
  ): Promise<void> {
    if (!this.isCurrentStream(stream) || stream.mode !== 'pty') return;
    const previousAttempts = this.ptyExitRetries.get(stream.paneId) ?? 0;
    if (previousAttempts >= 1) {
      log.warn('terminal', 'PTY terminal stream exited again after recovery; detaching', {
        event,
        paneId: stream.paneId,
        tmuxPaneId: stream.tmuxPaneId,
      });
      this.detach(stream.paneId);
      return;
    }

    this.ptyExitRetries.set(stream.paneId, previousAttempts + 1);
    await new Promise((resolve) => setTimeout(resolve, PTY_EXIT_RECOVERY_DELAY_MS));
    let token: number | null = null;
    await this.enqueuePaneInteraction(stream.paneId, async () => {
      if (!this.isCurrentStream(stream) || stream.mode !== 'pty') return;
      if (this.ptyHandles.has(stream.paneId)) {
        // A renderer reattach installed a healthy replacement while the
        // recovery delay was running. Let that client own the stream and only
        // reset the retry budget after the normal stability window.
        this.schedulePtyExitRetryReset(stream);
        return;
      }
      // Claim recovery ownership while still inside the pane lifecycle queue.
      // A concurrent renderer attach either finishes before this check or
      // supersedes this token afterward; neither path can lose a healthy client.
      token = this.bumpAttachToken(stream.paneId);
    });
    if (token === null) return;

    // Recover at the pane's live geometry (a renderer resize may have landed
    // while the client was down and already updated tmux).
    await this.reattachPtyStream(stream, undefined, token);
    if (this.isCurrentStream(stream) && stream.mode === 'pty') {
      this.schedulePtyExitRetryReset(stream);
    }
  }

  private async startClassicFallbackAfterPtyFailure(
    stream: PaneStream,
    token: number,
  ): Promise<void> {
    const isCurrent = (): boolean => this.isStreamStillCurrent(stream.paneId, stream, token);
    if (!isCurrent()) return;

    this.stopPtyOsc52Follower(stream.paneId);
    const fallbackMode = stream.transcriptPath && existsSync(stream.transcriptPath)
      ? 'transcript'
      : 'capture';
    this.prepareClassicFallback(stream, fallbackMode);
    sendTerminalStreamModeChanged(this.window, stream.paneId, stream.streamId, fallbackMode);
    void this.flushPendingWrites(stream.paneId, stream);

    try {
      if (fallbackMode === 'transcript' && stream.transcriptPath) {
        await this.startTranscriptStream(stream, stream.transcriptPath, token);
      } else {
        const historySize = await this.getHistorySize(stream.tmuxPaneId);
        if (!isCurrent()) return;
        stream.historySize = historySize;
        if (historySize > 0) {
          await this.replayInitialScrollback(stream, historySize);
          if (!isCurrent()) return;
        }
        this.startCapturePolling(stream);
        await this.capturePaneContent(stream);
      }

      if (isCurrent()) {
        stream.initialized = true;
        log.info('terminal', 'Classic terminal fallback started after PTY failure', {
          mode: fallbackMode,
          paneId: stream.paneId,
        });
      }
    } catch (error) {
      if (!isCurrent()) return;
      log.warn('terminal', 'Classic terminal fallback after PTY failure failed', {
        error: formatError(error),
        paneId: stream.paneId,
      });
      this.detach(stream.paneId);
    }
  }

  private shouldUseControlMode(sessionName: string): boolean {
    return this.transportMode === 'control' && sessionName.trim().length > 0;
  }

  private shouldUsePtyMode(sessionName: string, windowId: string | null): boolean {
    return this.transportMode === 'pty' && sessionName.trim().length > 0 && !!windowId;
  }

  private async synchronizeTmuxGeometry(
    tmuxPaneId: string,
    target: TerminalAttachSize,
    current?: PaneDimensions,
  ): Promise<PaneDimensions> {
    let dimensions = current ?? await readPaneDimensions(tmuxPaneId);
    if (
      dimensions.cols !== target.cols
      || dimensions.rows !== target.rows
      || (
        dimensions.windowPanes === 1
        && (dimensions.windowCols !== target.cols || dimensions.windowRows !== target.rows)
      )
    ) {
      log.infoThrottled('terminal', 'Synchronizing terminal source geometry', {
        fromCols: dimensions.cols,
        fromRows: dimensions.rows,
        tmuxPaneId,
        toCols: target.cols,
        toRows: target.rows,
      });
      await this.resizeTmuxPane(tmuxPaneId, target.cols, target.rows);
      dimensions = await readPaneDimensions(tmuxPaneId);
    }

    if (
      !dimensions.windowId
      || dimensions.cols !== target.cols
      || dimensions.rows !== target.rows
    ) {
      throw new Error(
        `tmux pane ${tmuxPaneId} did not reach requested geometry `
        + `${target.cols}x${target.rows} (reported ${dimensions.cols}x${dimensions.rows})`,
      );
    }

    return dimensions;
  }

  private async resizeTmuxPane(tmuxPaneId: string, cols: number, rows: number): Promise<void> {
    const target = shQuote(tmuxPaneId);
    await execAsync(
      `tmux resize-window -t ${target} -x ${cols} -y ${rows}`,
      { silent: true },
    );
    await execAsync(
      `tmux resize-pane -t ${target} -x ${cols} -y ${rows}`,
      { silent: true },
    );
  }

  private rememberPreferredLaunchSize(size?: TerminalAttachSize): void {
    if (!isUsableTerminalSize(size)) return;
    if (this.preferredLaunchSize?.cols === size.cols && this.preferredLaunchSize.rows === size.rows) return;

    this.preferredLaunchSize = { cols: size.cols, rows: size.rows };
    try {
      const settings = ElectronSettingsService.getInstance();
      settings.update('terminalPreferredLaunchCols', size.cols);
      settings.update('terminalPreferredLaunchRows', size.rows);
    } catch (error) {
      log.debug('terminal', 'Failed to persist preferred terminal launch size', {
        error: formatError(error),
      });
    }
  }

  private readPreferredLaunchSizeFromSettings(): TerminalAttachSize | null {
    try {
      const settings = ElectronSettingsService.getInstance().getAll();
      const size = {
        cols: settings.terminalPreferredLaunchCols,
        rows: settings.terminalPreferredLaunchRows,
      };
      return isUsableTerminalSize(size) ? size : null;
    } catch (error) {
      log.debug('terminal', 'Failed to read preferred terminal launch size', {
        error: formatError(error),
      });
      return null;
    }
  }

  private schedulePtyExitRetryReset(stream: PaneStream): void {
    this.clearPtyExitRetryResetTimer(stream.paneId);
    const timer = setTimeout(() => {
      this.ptyExitRetryResetTimers.delete(stream.paneId);
      if (!this.isCurrentStream(stream) || stream.mode !== 'pty') return;
      this.ptyExitRetries.delete(stream.paneId);
      log.debug('terminal', 'PTY exit recovery budget reset after stable client uptime', {
        paneId: stream.paneId,
        tmuxPaneId: stream.tmuxPaneId,
      });
    }, PTY_EXIT_RETRY_RESET_MS);
    this.ptyExitRetryResetTimers.set(stream.paneId, timer);
  }

  private clearPtyExitRetryResetTimer(paneId: string): void {
    const timer = this.ptyExitRetryResetTimers.get(paneId);
    if (!timer) return;
    clearTimeout(timer);
    this.ptyExitRetryResetTimers.delete(paneId);
  }

  private bumpAttachToken(paneId: string): number {
    const next = this.lastAttachToken + 1;
    this.lastAttachToken = next;
    this.attachTokens.set(paneId, next);
    return next;
  }

  private async replayInitialScrollback(
    stream: PaneStream,
    historySize: number,
  ): Promise<void> {
    const settings = ElectronSettingsService.getInstance().getAll();
    const maxLines = Math.min(historySize, settings.scrollbackLines);
    if (maxLines <= 0) return;

    try {
      const history = await capturePane(stream.tmuxPaneId, {
        startLine: -maxLines,
        endLine: -1,
      });

      if (!history || !this.isCurrentStream(stream)) return;

      const replaySource = stream.skipScrollbackReplay
        ? compactAgentScrollbackForReplay(history)
        : { content: history, droppedLines: 0, duplicateNumberedLines: 0, duplicateStartupFrames: 0 };
      if (replaySource.droppedLines > 0) {
        log.debug('terminal', 'Compacted duplicate agent startup scrollback', {
          droppedLines: replaySource.droppedLines,
          duplicateNumberedLines: replaySource.duplicateNumberedLines,
          duplicateStartupFrames: replaySource.duplicateStartupFrames,
          paneId: stream.paneId,
          tmuxPaneId: stream.tmuxPaneId,
        });
      }

      const replay = formatScrollbackReplay(replaySource.content, stream.rows, stream.cols);
      if (!replay) return;
      for (let offset = 0; offset < replay.length; offset += TERMINAL_REPLAY_CHUNK_CHARS) {
        if (!this.isCurrentStream(stream)) return;
        this.sendToRenderer(stream.paneId, replay.slice(offset, offset + TERMINAL_REPLAY_CHUNK_CHARS), 'replay', stream.streamId);
      }

      log.debug('terminal', 'Initial scrollback replayed', {
        paneId: stream.paneId,
        historySize,
        requestedLines: maxLines,
      });
    } catch (err) {
      log.warn('terminal', 'Failed to replay initial scrollback', {
        paneId: stream.paneId,
        error: String(err),
      });
    }
  }

  private isAttachTokenCurrent(paneId: string, token: number): boolean {
    return (this.attachTokens.get(paneId) ?? 0) === token;
  }

  private isStreamStillCurrent(paneId: string, stream: PaneStream, token: number): boolean {
    return this.isAttachTokenCurrent(paneId, token) && this.streams.get(paneId) === stream;
  }

  private disposeStaleAttachStream(
    paneId: string,
    stream: PaneStream,
    token: number,
    mode: string,
  ): void {
    // The same PaneStream object can already belong to a newer renderer attach
    // generation. Never tear down its current pane-keyed resources from an old
    // continuation. Explicit detach already handles full ownership cleanup.
    if (this.streams.get(paneId) === stream) {
      log.debug('terminal', 'Retained stream owned by a newer attach generation', {
        mode,
        paneId,
        token,
      });
      return;
    }
    this.disposeStreamOwnedResources(stream);
    log.debug('terminal', 'Disposed stale attach stream', { paneId, token, mode });
  }

  private disposeFailedRegisteredStream(stream: PaneStream, token: number): void {
    if (!this.isStreamStillCurrent(stream.paneId, stream, token)) return;

    this.streams.delete(stream.paneId);
    this.disposeStreamResources(stream);
    this.pendingWrites.delete(stream.paneId);
    this.pendingUnlocks.delete(stream.paneId);
    this.clearPendingPtyWriteRetry(stream.paneId);
    this.ptyExitRetries.delete(stream.paneId);
    this.clearPtyExitRetryResetTimer(stream.paneId);
    this.controlClients.stopIfIdle(stream.sessionName, this.streams.values());
    log.warn('terminal', 'Disposed stream after terminal attach startup failed', {
      paneId: stream.paneId,
      streamId: stream.streamId,
      token,
    });
  }

  private disposeStreamResources(stream: PaneStream): void {
    this.disposePtyResources(stream);
    this.stopPtyOsc52Follower(stream.paneId);
    this.disposeStreamOwnedResources(stream);
  }

  private disposeStreamOwnedResources(stream: PaneStream): void {
    stream.controlUnsubscribe?.();
    stream.controlUnsubscribe = null;
    stream.controlLiveBuffer = '';
    if (stream.timer) clearInterval(stream.timer);
    stream.timer = null;
    if (stream.writeCaptureTimer) clearTimeout(stream.writeCaptureTimer);
    if (stream.resizeRepaintTimer) clearTimeout(stream.resizeRepaintTimer);
    this.transcriptStream.dispose(stream);
  }

  private disposePtyResources(stream: PaneStream): void {
    const ptyHandle = this.ptyHandles.get(stream.paneId);
    if (ptyHandle) {
      this.ptyHandles.delete(stream.paneId);
      ptyHandle.dispose();
    }
    this.ptyCopyModePanes.delete(stream.paneId);
  }
}
