import { execFile } from 'child_process';
import type { FSWatcher } from 'fs';
import type { StringDecoder } from 'string_decoder';
import type { TerminalDataSource, TerminalStreamMode } from '../../shared/ipc-types.js';
import type { CapturedPaneCursor } from './terminal-render.js';

const CAPTURE_MAX_BUFFER = 5 * 1024 * 1024;
const CAPTURE_TIMEOUT_MS = 3000;

export const NO_CONTENT = Symbol('no-content');

export interface PaneStream {
  paneId: string;
  sessionName: string;
  skipScrollbackReplay: boolean;
  streamId: number;
  tmuxPaneId: string;
  windowId: string | null;
  mode: TerminalStreamMode;
  timer: ReturnType<typeof setInterval> | null;
  lastContent: string | typeof NO_CONTENT;
  attachedAt: number;
  initialized: boolean;
  cols: number;
  rows: number;
  capturing: boolean;
  /** Exact column width for fixed-grid terminals. 0 means responsive. */
  fixedCols: number;
  /** View-session mouse override. Undefined preserves the user's tmux policy. */
  enableMouse?: boolean;
  /** Sticky accessibility latch for the lifetime of this logical stream. */
  screenReaderDetected: boolean;
  consecutiveFailures: number;
  writeCaptureTimer: ReturnType<typeof setTimeout> | null;
  resizeRepaintTimer: ReturnType<typeof setTimeout> | null;
  alternateOn: boolean;
  alternateCheckedAt: number;
  alternateCheckCount: number;
  stdinLocked: boolean;
  historySize: number;
  lastCursor: CapturedPaneCursor | null;
  transcriptPath: string | null;
  transcriptFd: number | null;
  transcriptDev: number | null;
  transcriptIno: number | null;
  transcriptOffset: number;
  transcriptDecoder: StringDecoder | null;
  transcriptWatcher: FSWatcher | null;
  transcriptPollTimer: ReturnType<typeof setInterval> | null;
  transcriptPending: string;
  transcriptPendingSource: TerminalDataSource | null;
  transcriptFlushTimer: ReturnType<typeof setTimeout> | null;
  transcriptReplayInFlight: boolean;
  transcriptSuppressedUntil: number;
  controlLiveBuffer: string;
  controlUnsubscribe: (() => void) | null;
}

export function cursorStateEquals(a: CapturedPaneCursor | null, b: CapturedPaneCursor | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.visible === b.visible;
}

export function stripAnsiForLog(line: string): string {
  return line
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '');
}

export function capturePane(
  tmuxPaneId: string,
  opts?: { startLine?: number; endLine?: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['capture-pane', '-t', tmuxPaneId, '-p', '-e', '-N'];
    if (opts?.startLine !== undefined) args.push('-S', String(opts.startLine));
    if (opts?.endLine !== undefined) args.push('-E', String(opts.endLine));

    execFile(
      'tmux',
      args,
      { encoding: 'utf-8', maxBuffer: CAPTURE_MAX_BUFFER, timeout: CAPTURE_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export function capturePaneText(tmuxPaneId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'tmux',
      ['capture-pane', '-t', tmuxPaneId, '-p', '-S', '-'],
      { encoding: 'utf-8', maxBuffer: CAPTURE_MAX_BUFFER, timeout: CAPTURE_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export function displayPaneFormat(tmuxPaneId: string, format: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'tmux',
      ['display-message', '-p', '-t', tmuxPaneId, format],
      { encoding: 'utf-8', maxBuffer: CAPTURE_MAX_BUFFER, timeout: CAPTURE_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}
