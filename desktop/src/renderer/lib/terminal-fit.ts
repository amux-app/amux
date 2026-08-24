const OVERFLOW_TOLERANCE_PX = 0.5;
const TERMINAL_MIN_ATTACH_COLS = 2;
const TERMINAL_MIN_ATTACH_ROWS = 2;
const AGENT_TERMINAL_ROWS_FLOOR = 8;
const FIXED_WIDTH_MIN_FONT_SIZE = 8;

export type TerminalFitFailureReason = 'too-narrow' | 'too-short';

export interface TerminalFitSize {
  cols: number;
  rows: number;
}

export interface TerminalFitOptions {
  baseFontSize?: number;
  minFontSize?: number;
  minCols?: number;
  minRows?: number;
  onFailure?: (reason: TerminalFitFailureReason) => void;
  /**
   * Lock the fit to EXACTLY this many persisted profile columns. The font
   * scales down only when required to fit the container and never grows above
   * the configured base size. Rows remain the honest rows at that font.
   */
  fixedCols?: number;
}

export interface TerminalFitAddon {
  fit: () => void;
  proposeDimensions: () => TerminalFitSize | undefined;
}

export interface TerminalFitHost {
  cols: number;
  element: HTMLElement | null | undefined;
  options?: {
    fontSize?: number;
  };
  resize: (cols: number, rows: number) => void;
  rows: number;
}

export function fitTerminalToContainer(
  fitAddon: TerminalFitAddon,
  terminal: TerminalFitHost,
  container: HTMLElement,
  options: TerminalFitOptions = {},
): TerminalFitSize | null {
  if (container.offsetWidth === 0 || container.offsetHeight === 0) return null;

  resetTerminalFontSize(terminal, options.baseFontSize);
  const proposedSize = fitAddon.proposeDimensions();
  if (!isUsableTerminalSize(proposedSize)) return null;

  if (options.fixedCols !== undefined) {
    return fitFixedWidthTerminal(fitAddon, terminal, container, proposedSize, options);
  }

  const constrainedSize = resolveConstrainedSize(proposedSize, options);
  if (constrainedSize) {
    return fitConstrainedTerminal(fitAddon, terminal, container, proposedSize, options);
  }

  fitAddon.fit();
  shrinkOverflowingTerminal(terminal, container, options);

  if (!isUsableTerminalSize(terminal)) return null;
  return { cols: terminal.cols, rows: terminal.rows };
}

/**
 * Lock the terminal to exactly `fixedCols` columns. Scale down only when those
 * columns would overflow, preserve breathing room in wider containers, and
 * report the honest rows that fit at the resulting font. Always returns
 * `{ cols: fixedCols, rows }`.
 */
function fitFixedWidthTerminal(
  fitAddon: TerminalFitAddon,
  terminal: TerminalFitHost,
  container: HTMLElement,
  proposedSize: TerminalFitSize,
  options: TerminalFitOptions,
): TerminalFitSize | null {
  const fixedCols = Math.max(
    TERMINAL_MIN_ATTACH_COLS,
    Math.floor(options.fixedCols ?? proposedSize.cols),
  );
  const measuredSize = fitFixedWidthFont(
    fitAddon,
    terminal,
    proposedSize,
    fixedCols,
    options,
  );
  if (measuredSize.cols < fixedCols) {
    options.onFailure?.('too-narrow');
    return null;
  }

  terminal.resize(fixedCols, Math.max(measuredSize.rows, TERMINAL_MIN_ATTACH_ROWS));
  const fitFailure = fitFixedWidthInsideContainer(fitAddon, terminal, container, fixedCols);
  if (fitFailure) {
    options.onFailure?.(fitFailure);
    return null;
  }

  if (!isUsableTerminalSize(terminal) || terminal.cols !== fixedCols) return null;
  return { cols: fixedCols, rows: terminal.rows };
}

function fitFixedWidthFont(
  fitAddon: TerminalFitAddon,
  terminal: TerminalFitHost,
  proposedSize: TerminalFitSize,
  fixedCols: number,
  options: TerminalFitOptions,
): TerminalFitSize {
  if (!terminal.options || options.baseFontSize === undefined) return proposedSize;
  const scale = Math.min(proposedSize.cols / fixedCols, 1);
  // A persisted fixed grid may scale below the ordinary agent font floor, but
  // never below the explicit 8px readability boundary.
  terminal.options.fontSize = alignFontSize(
    Math.min(options.baseFontSize, options.baseFontSize * scale),
    FIXED_WIDTH_MIN_FONT_SIZE,
    'floor',
  );

  let measuredSize = fitAddon.proposeDimensions() ?? proposedSize;
  while (
    measuredSize.cols < fixedCols
    && (terminal.options.fontSize ?? FIXED_WIDTH_MIN_FONT_SIZE) > FIXED_WIDTH_MIN_FONT_SIZE
  ) {
    terminal.options.fontSize = (terminal.options.fontSize ?? FIXED_WIDTH_MIN_FONT_SIZE) - 1;
    measuredSize = fitAddon.proposeDimensions() ?? measuredSize;
  }
  return measuredSize;
}

function fitFixedWidthInsideContainer(
  fitAddon: TerminalFitAddon,
  terminal: TerminalFitHost,
  container: HTMLElement,
  fixedCols: number,
): TerminalFitFailureReason | null {
  const screenElement = terminal.element?.querySelector('.xterm-screen');
  if (!(screenElement instanceof HTMLElement)) return null;

  const containerRect = container.getBoundingClientRect();
  let screenRect = screenElement.getBoundingClientRect();

  while (
    screenRect.width > containerRect.width + OVERFLOW_TOLERANCE_PX
    && terminal.options
    && (terminal.options.fontSize ?? FIXED_WIDTH_MIN_FONT_SIZE) > FIXED_WIDTH_MIN_FONT_SIZE
  ) {
    terminal.options.fontSize = (terminal.options.fontSize ?? FIXED_WIDTH_MIN_FONT_SIZE) - 1;
    const measuredSize = fitAddon.proposeDimensions();
    if (!isUsableTerminalSize(measuredSize) || measuredSize.cols < fixedCols) return 'too-narrow';
    terminal.resize(fixedCols, measuredSize.rows);
    screenRect = screenElement.getBoundingClientRect();
  }

  while (
    screenRect.height > containerRect.height + OVERFLOW_TOLERANCE_PX
    && terminal.rows > TERMINAL_MIN_ATTACH_ROWS
  ) {
    terminal.resize(fixedCols, terminal.rows - 1);
    screenRect = screenElement.getBoundingClientRect();
  }

  if (screenRect.width > containerRect.width + OVERFLOW_TOLERANCE_PX) return 'too-narrow';
  if (screenRect.height > containerRect.height + OVERFLOW_TOLERANCE_PX) return 'too-short';
  return null;
}

function fitConstrainedTerminal(
  fitAddon: TerminalFitAddon,
  terminal: TerminalFitHost,
  container: HTMLElement,
  proposedSize: TerminalFitSize,
  options: TerminalFitOptions,
): TerminalFitSize | null {
  applyConstrainedFontSize(terminal, proposedSize, options);

  const minCols = options.minCols ?? TERMINAL_MIN_ATTACH_COLS;
  const reproposed = fitAddon.proposeDimensions() ?? proposedSize;
  const cols = Math.max(reproposed.cols, minCols);
  const rows = Math.max(reproposed.rows, AGENT_TERMINAL_ROWS_FLOOR);

  terminal.resize(cols, rows);
  shrinkOverflowingTerminal(terminal, container, options);

  if (!isUsableTerminalSize(terminal)) return null;
  return { cols: terminal.cols, rows: terminal.rows };
}

function isUsableTerminalSize(size: TerminalFitSize | null | undefined): size is TerminalFitSize {
  return !!size
    && Number.isFinite(size.cols)
    && Number.isFinite(size.rows)
    && size.cols >= TERMINAL_MIN_ATTACH_COLS
    && size.rows >= TERMINAL_MIN_ATTACH_ROWS;
}

function resolveConstrainedSize(size: TerminalFitSize, options: TerminalFitOptions): TerminalFitSize | null {
  const minCols = options.minCols ?? TERMINAL_MIN_ATTACH_COLS;
  const minRows = options.minRows ?? TERMINAL_MIN_ATTACH_ROWS;
  if (size.cols >= minCols && size.rows >= minRows) return null;
  return {
    cols: Math.max(size.cols, minCols),
    rows: Math.max(size.rows, minRows),
  };
}

function resetTerminalFontSize(terminal: TerminalFitHost, baseFontSize: number | undefined): void {
  if (!terminal.options || baseFontSize === undefined) return;
  const fontSize = alignFontSize(baseFontSize, 1);
  if (terminal.options.fontSize === fontSize) return;
  terminal.options.fontSize = fontSize;
}

function applyConstrainedFontSize(
  terminal: TerminalFitHost,
  proposedSize: TerminalFitSize,
  options: TerminalFitOptions,
): void {
  if (!terminal.options || options.baseFontSize === undefined) return;
  const minCols = options.minCols ?? TERMINAL_MIN_ATTACH_COLS;
  const minRows = options.minRows ?? TERMINAL_MIN_ATTACH_ROWS;
  const scale = Math.min(proposedSize.cols / minCols, proposedSize.rows / minRows, 1);
  const fittedFontSize = options.baseFontSize * scale;
  const minFontSize = options.minFontSize ?? 1;
  terminal.options.fontSize = alignFontSize(
    Math.min(options.baseFontSize, Math.max(fittedFontSize, minFontSize)),
    minFontSize,
  );
}

function alignFontSize(
  fontSize: number,
  minFontSize: number,
  roundMode: 'round' | 'floor' = 'round',
): number {
  const aligned = roundMode === 'floor' ? Math.floor(fontSize) : Math.round(fontSize);
  return Math.max(minFontSize, aligned);
}

function shrinkOverflowingTerminal(
  terminal: TerminalFitHost,
  container: HTMLElement,
  options: TerminalFitOptions,
): void {
  const screenElement = terminal.element?.querySelector('.xterm-screen');
  if (!(screenElement instanceof HTMLElement)) return;

  const containerRect = container.getBoundingClientRect();
  const minCols = options.minCols ?? TERMINAL_MIN_ATTACH_COLS;
  const minRows = Math.min(options.minRows ?? TERMINAL_MIN_ATTACH_ROWS, AGENT_TERMINAL_ROWS_FLOOR);

  // Iterate rather than shrink-by-one: when the constrained branch has to
  // clamp up to (minCols, minRows) and the font is already at its floor, the
  // rendered screen can overshoot the container by several rows and one pass
  // still leaves the bottom clipped by overflow-hidden.
  let cols = terminal.cols;
  let rows = terminal.rows;
  const MAX_ITER = 32;
  for (let i = 0; i < MAX_ITER; i += 1) {
    const screenRect = screenElement.getBoundingClientRect();
    const overflowsWidth = screenRect.width > containerRect.width + OVERFLOW_TOLERANCE_PX;
    const overflowsHeight = screenRect.height > containerRect.height + OVERFLOW_TOLERANCE_PX;
    if (!overflowsWidth && !overflowsHeight) break;

    let changed = false;
    if (overflowsWidth && cols > minCols) {
      cols -= 1;
      changed = true;
    }
    if (overflowsHeight && rows > minRows) {
      rows -= 1;
      changed = true;
    }
    if (!changed) break;
    terminal.resize(cols, rows);
  }
}
