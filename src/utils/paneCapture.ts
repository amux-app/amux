import { execFile, execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { TMUX_COMMAND_TIMEOUT } from '../constants/timing.js';
import { LogService } from '../services/LogService.js';

const log = LogService.getInstance();
const LOG_SOURCE = 'paneCapture';
const TMUX_BIN = 'tmux';
const CAPTURE_MAX_ATTEMPTS = 2;
const BLANK_PANE_WINDOW_LINES = 200;
const WINDOW_GROWTH_PADDING = 20;
const PANE_HEIGHT_FORMAT = '#{pane_height}';

/**
 * A single capture window: the pane's scrollback tail plus its visible rows.
 * `visibleFrame` is sliced off the tail of the same capture, so a caller that
 * needs both windows pays for exactly one `tmux capture-pane` invocation.
 */
export interface PaneWindowCapture {
  content: string;
  visibleFrame: string;
}

export interface PaneWindowCaptureRequest {
  lines: number;
  paneId: string;
}

export interface PaneWindowCaptureBatch {
  captures: Map<string, PaneWindowCapture>;
  tmuxInvocations: number;
}

export type AsyncTmuxRunner = (args: string[]) => Promise<string>;

interface WindowAttempt {
  paneHeight: number;
  rows: string[];
  trailingBlankCount: number;
}

interface PendingWindowCapture extends PaneWindowCaptureRequest {
  historyLines: number;
}

interface BatchAttemptResult {
  attempts: Map<string, WindowAttempt>;
  tmuxInvocations: number;
}

const EMPTY_ATTEMPT: WindowAttempt = { rows: [], trailingBlankCount: 0, paneHeight: 0 };
const ASYNC_TMUX_MAX_BUFFER = 4 * 1024 * 1024;
const CAPTURE_FAILURE_LOG_INTERVAL = 30_000;

let lastFailureMessage = '';
let lastFailureLoggedAt = 0;

/**
 * Captures run every poll tick, so a pane that stays dead would otherwise emit
 * the same failure twice a second. A repeat is logged at most once per window;
 * a different failure is logged immediately.
 */
function logCaptureFailure(message: string): void {
  const now = Date.now();
  if (message === lastFailureMessage && now - lastFailureLoggedAt < CAPTURE_FAILURE_LOG_INTERVAL) {
    return;
  }
  lastFailureMessage = message;
  lastFailureLoggedAt = now;
  log.debug(`tmux capture failed: ${message}`, LOG_SOURCE);
}

/**
 * Build shell-free `tmux capture-pane` argv. The pane id is passed as its own
 * element so ids like `%42` stay literal without shell quoting.
 */
function captureArgs(paneId: string, historyLines?: number): string[] {
  const args = ['capture-pane', '-t', paneId, '-p'];
  if (historyLines !== undefined) args.push('-S', `-${historyLines}`);
  return args;
}

/**
 * Same capture plus the pane's row count, as one tmux command list. Reading
 * the height inside the invocation that produced the rows makes the visible
 * frame resize-proof: no cached height can survive an app-driven, layout-driven
 * or foreign-client resize. The status line is requested AFTER the capture on
 * purpose - a resize landing between
 * the two commands can then only narrow the visible slice, never widen it
 * into scrollback.
 */
function captureWithHeightArgs(paneId: string, historyLines: number): string[] {
  return [
    ...captureArgs(paneId, historyLines),
    ';',
    'display-message', '-p', '-t', paneId, PANE_HEIGHT_FORMAT,
  ];
}

function runTmux(args: string[]): string {
  try {
    return execFileSync(TMUX_BIN, args, {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch {
    return '';
  }
}

/**
 * Resolves with whatever tmux printed, including on failure: a tmux command
 * list aborts at the first failing command, but every pane captured before that
 * point is already on stdout. Discarding it would send the whole batch through
 * the per-pane fallback for one dead pane.
 */
function runTmuxAsync(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(TMUX_BIN, args, {
      encoding: 'utf8',
      maxBuffer: ASYNC_TMUX_MAX_BUFFER,
      timeout: TMUX_COMMAND_TIMEOUT,
    }, (error, stdout) => {
      if (error) logCaptureFailure(error.message);
      resolve(stdout ?? '');
    });
  });
}

/**
 * Split a capture into pane rows, dropping the trailing newline artefact so
 * `rows.length` equals the number of terminal rows tmux emitted.
 */
function toRows(captured: string): string[] {
  const rows = captured.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  return rows;
}

function countTrailingBlanks(rows: string[]): number {
  let count = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].trim() !== '') break;
    count++;
  }
  return count;
}

function parsePaneHeight(raw: string | undefined): number {
  const height = Number.parseInt((raw ?? '').trim(), 10);
  return Number.isInteger(height) && height > 0 ? height : 0;
}

function toAttempt(captured: string): WindowAttempt {
  if (!captured) return EMPTY_ATTEMPT;
  const rows = toRows(captured);
  const paneHeight = parsePaneHeight(rows.pop());
  return { rows, trailingBlankCount: countTrailingBlanks(rows), paneHeight };
}

function contentLineCount(attempt: WindowAttempt): number {
  return attempt.rows.length - attempt.trailingBlankCount;
}

function attemptContent(attempt: WindowAttempt): string {
  const { rows, trailingBlankCount } = attempt;
  return rows.slice(0, -trailingBlankCount || rows.length).join('\n');
}

/**
 * History window for the next attempt, or null when the pane holds no content
 * and widening the window further cannot help.
 */
function nextWindowLines(
  currentLines: number,
  attempt: WindowAttempt,
  isFirstAttempt: boolean
): number | null {
  if (contentLineCount(attempt) === 0) {
    return isFirstAttempt ? BLANK_PANE_WINDOW_LINES : null;
  }
  return currentLines + attempt.trailingBlankCount + WINDOW_GROWTH_PADDING;
}

/**
 * Capture a pane window, widening the history request when the requested
 * number of non-blank lines is not yet covered. Bounded to `maxAttempts`
 * invocations: the last attempt is returned as-is rather than triggering an
 * extra capture, because every tmux spawn is a measurable cost per poll tick.
 */
function captureWindow(paneId: string, lines: number, maxAttempts: number): WindowAttempt {
  let currentLines = lines;
  let attempt = EMPTY_ATTEMPT;

  for (let i = 0; i < maxAttempts; i++) {
    attempt = toAttempt(runTmux(captureWithHeightArgs(paneId, currentLines)));
    if (attempt.rows.length === 0) return EMPTY_ATTEMPT;
    if (contentLineCount(attempt) >= lines) return attempt;

    const next = nextWindowLines(currentLines, attempt, i === 0);
    if (next === null) return EMPTY_ATTEMPT;
    currentLines = next;
  }

  return attempt;
}

function sliceVisibleFrame(rows: string[], paneHeight: number): string {
  if (rows.length === 0 || paneHeight <= 0) return '';
  return rows.slice(-Math.min(paneHeight, rows.length)).join('\n');
}

function toPaneWindowCapture(attempt: WindowAttempt): PaneWindowCapture {
  return {
    content: attemptContent(attempt),
    visibleFrame: sliceVisibleFrame(attempt.rows, attempt.paneHeight),
  };
}

function sliceAttempt(attempt: WindowAttempt, historyLines: number): WindowAttempt {
  if (attempt.rows.length === 0) return EMPTY_ATTEMPT;
  const rowLimit = historyLines + attempt.paneHeight;
  const rows = attempt.rows.slice(-Math.min(rowLimit, attempt.rows.length));
  return {
    paneHeight: attempt.paneHeight,
    rows,
    trailingBlankCount: countTrailingBlanks(rows),
  };
}

/**
 * Derive the same bounded analysis window that the old two-process algorithm
 * selected, but from one generously bounded capture. This keeps status and LLM
 * inputs stable while avoiding a routine retry for sparse or blank panes.
 */
function selectAnalysisAttempt(
  attempt: WindowAttempt,
  requestedLines: number,
): WindowAttempt {
  const initial = sliceAttempt(attempt, requestedLines);
  if (contentLineCount(initial) >= requestedLines) return initial;

  if (contentLineCount(initial) === 0) {
    return sliceAttempt(attempt, BLANK_PANE_WINDOW_LINES);
  }

  const widenedLines = Math.min(
    BLANK_PANE_WINDOW_LINES,
    requestedLines + initial.trailingBlankCount + WINDOW_GROWTH_PADDING,
  );
  return sliceAttempt(attempt, widenedLines);
}

function makeCaptureMarker(token: string, index: number): string {
  return `__MUXBASE_CAPTURE_${token}_${index}__`;
}

function buildBatchArgs(
  requests: PendingWindowCapture[],
  token: string,
): { args: string[]; markers: string[] } {
  const args: string[] = [];
  const markers: string[] = [];

  requests.forEach((request, index) => {
    if (args.length > 0) args.push(';');
    const marker = makeCaptureMarker(token, index);
    markers.push(marker);
    args.push(
      'display-message', '-p', '-t', request.paneId, marker,
      ';',
      ...captureWithHeightArgs(request.paneId, request.historyLines),
    );
  });

  return { args, markers };
}

function parseBatchOutput(
  output: string,
  requests: PendingWindowCapture[],
  markers: string[],
): Map<string, WindowAttempt> {
  const attempts = new Map<string, WindowAttempt>();

  requests.forEach((request, index) => {
    const markerLine = `${markers[index]}\n`;
    const start = output.indexOf(markerLine);
    if (start < 0) return;

    const contentStart = start + markerLine.length;
    const nextMarker = markers[index + 1];
    const end = nextMarker
      ? output.indexOf(`${nextMarker}\n`, contentStart)
      : output.length;
    if (end < 0) return;

    // The last segment is bounded by the end of stdout, so a truncated command
    // list would otherwise have its final content row popped as the pane
    // height. Without a parsable height the segment is treated as missing and
    // recaptured per pane instead of producing a corrupt window.
    const attempt = toAttempt(output.slice(contentStart, end));
    if (attempt.paneHeight === 0) return;

    attempts.set(request.paneId, attempt);
  });

  return attempts;
}

async function captureBatchAttempts(
  requests: PendingWindowCapture[],
  runner: AsyncTmuxRunner,
): Promise<BatchAttemptResult> {
  if (requests.length === 0) {
    return { attempts: new Map(), tmuxInvocations: 0 };
  }

  const token = randomUUID().replaceAll('-', '');
  const { args, markers } = buildBatchArgs(requests, token);
  const attempts = new Map<string, WindowAttempt>();
  let tmuxInvocations = 1;

  try {
    const output = await runner(args);
    for (const [paneId, attempt] of parseBatchOutput(output, requests, markers)) {
      attempts.set(paneId, attempt);
    }
  } catch {
    // A disappearing pane can fail the whole tmux command list. Fall back only
    // for this exceptional path so other live panes still receive a result.
  }

  const missingRequests = requests.filter((request) => !attempts.has(request.paneId));
  tmuxInvocations += missingRequests.length;
  const fallbackResults = await Promise.all(missingRequests.map(async (request) => {
    try {
      const output = await runner(captureWithHeightArgs(request.paneId, request.historyLines));
      return { attempt: toAttempt(output), paneId: request.paneId };
    } catch {
      return { attempt: EMPTY_ATTEMPT, paneId: request.paneId };
    }
  }));

  for (const result of fallbackResults) {
    attempts.set(result.paneId, result.attempt);
  }

  return { attempts, tmuxInvocations };
}

/**
 * Capture every pane due in the same scheduling turn with one bounded tmux
 * command list. Sparse and blank panes are trimmed in memory from the same
 * capture. Only a failed/malformed batch falls back per pane.
 */
export async function capturePaneWindows(
  requests: PaneWindowCaptureRequest[],
  runner: AsyncTmuxRunner = runTmuxAsync,
): Promise<PaneWindowCaptureBatch> {
  const boundedRequests = requests.map((request) => ({
    ...request,
    historyLines: BLANK_PANE_WINDOW_LINES,
  }));
  const batch = await captureBatchAttempts(boundedRequests, runner);

  return {
    captures: new Map(requests.map((request) => [
      request.paneId,
      toPaneWindowCapture(selectAnalysisAttempt(
        batch.attempts.get(request.paneId) ?? EMPTY_ATTEMPT,
        request.lines,
      )),
    ])),
    tmuxInvocations: batch.tmuxInvocations,
  };
}

/**
 * Captures the last N lines from a tmux pane, automatically skipping trailing blank lines.
 * If the captured content ends with blank lines, it will fetch more lines to ensure
 * we get actual content.
 *
 * @param paneId - The tmux pane ID to capture from
 * @param lines - Number of non-blank lines to capture (default: 50)
 * @param maxAttempts - Maximum number of capture invocations (default: 2)
 * @returns The captured content with trailing blank lines removed, or empty string on failure
 */
export function capturePaneContent(
  paneId: string,
  lines: number = 50,
  maxAttempts: number = CAPTURE_MAX_ATTEMPTS
): string {
  return attemptContent(captureWindow(paneId, lines, maxAttempts));
}

/**
 * Captures a pane's scrollback window and its visible frame in a single tmux
 * invocation. The visible frame is the tail `pane_height` rows of the capture:
 * tmux always ends a `-S -N` capture at the bottom row of the visible pane and
 * always emits exactly `pane_height` visible rows, including blank ones. The
 * row count comes from the same invocation, so the split cannot drift when the
 * pane is resized between polls.
 *
 * @param paneId - The tmux pane ID to capture from
 * @param lines - Number of non-blank scrollback+visible lines to capture
 */
export function capturePaneWindow(paneId: string, lines: number): PaneWindowCapture {
  return toPaneWindowCapture(captureWindow(paneId, lines, CAPTURE_MAX_ATTEMPTS));
}

/**
 * Captures only the VISIBLE frame of a tmux pane (no scrollback, i.e. no `-S`).
 * Use this for deterministic "is the agent working right now" checks: a finished
 * "esc to interrupt" line lingering in scrollback must not be read as active.
 *
 * @param paneId - The tmux pane ID to capture from
 * @returns The visible pane content, or empty string on failure
 */
export function capturePaneVisible(paneId: string): string {
  return runTmux(captureArgs(paneId));
}
