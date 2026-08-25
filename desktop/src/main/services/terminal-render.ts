function normalizeCaptureLines(content: string): string[] {
  const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content;
  return trimmed.split('\n').map((l) => l.replace(/\r$/, ''));
}

const CAPTURE_FRAME_CHARSET_SETUP = '\x1b(B\x1b)0\x0f';
const CAPTURE_FRAME_G0_SELECT = '\x0f';
const TERMINAL_AUTOWRAP_ENABLE = '\x1b[?7h';
const TERMINAL_AUTOWRAP_DISABLE = '\x1b[?7l';
const TERMINAL_ALTERNATE_SCREEN_ENTER = '\x1b[?1049h';
const TERMINAL_ALTERNATE_SCREEN_EXIT = '\x1b[?1049l';
const MUXBASE_STARTUP_ENV_PATTERN = /MUXBASE_PROMPT_(?:FILE|CONTENT)=/;
const CLAUDE_STARTUP_SCAN_LINES = 32;
const CLAUDE_STARTUP_HEADER = /^╭───\s*Claude\s+Code\s+v\d/i;
const CLAUDE_STARTUP_BODY = /(Welcome back|Tips for getting started)/i;
const CLAUDE_PROMPT_LINE = /^❯(?:\s|$)/;
const NUMBERED_ASSISTANT_LINE = /^\s*\d{1,4}[.)]\s+\S/;

export interface CapturedPaneCursor {
  x: number;
  y: number;
  visible: boolean;
}

export interface AgentScrollbackCompactionResult {
  content: string;
  droppedLines: number;
  duplicateStartupFrames: number;
  duplicateNumberedLines: number;
}

interface AgentScrollbackCompactionOptions {
  dropStartupBeforePrompt?: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function renderCapturedPaneCursor(opts: {
  cursor?: CapturedPaneCursor | null;
  cols: number;
  rows: number;
  trimmedTopRows: number;
}): string {
  const { cursor, cols, rows, trimmedTopRows } = opts;
  if (!cursor) {
    return `\x1b[${rows};1H`;
  }

  const clampedRow = clamp(cursor.y - trimmedTopRows, 0, rows - 1) + 1;
  const clampedCol = clamp(cursor.x, 0, Math.max(cols, 1) - 1) + 1;
  const visibility = cursor.visible ? '\x1b[?25h' : '\x1b[?25l';

  return `${visibility}\x1b[${clampedRow};${clampedCol}H`;
}

function renderCapturedPaneScreenMode(alternateOn?: boolean): string {
  if (alternateOn === undefined) return '';
  return alternateOn ? TERMINAL_ALTERNATE_SCREEN_ENTER : TERMINAL_ALTERNATE_SCREEN_EXIT;
}

export function renderCapturedPaneFrame(opts: {
  alternateOn?: boolean;
  content: string;
  cols: number;
  rows: number;
  cursor?: CapturedPaneCursor | null;
  isFirst: boolean;
}): string {
  const { alternateOn, content, cols, rows, cursor, isFirst } = opts;
  const isVisuallyBlank = (line: string): boolean => stripTerminalControls(line).trim().length === 0;

  let rawLines = normalizeCaptureLines(content);
  let trimmedTopRows = 0;

  // Some TUIs (notably Claude/Codex) appear with an empty first row in tmux,
  // which in our xterm replay can look like a "garbled" header due to glyph
  // overlap/clipping. When the first non-blank line looks like an agent header,
  // trim leading blank rows so the UI anchors to the top-left.
  const firstNonBlankIdx = rawLines.findIndex((l) => !isVisuallyBlank(l));
  if (firstNonBlankIdx > 0) {
    const firstNonBlank = stripTerminalControls(rawLines[firstNonBlankIdx]);
    if (/(Claude Code|Codex|OpenCode)/i.test(firstNonBlank) || firstNonBlank.startsWith('╭───')) {
      trimmedTopRows += firstNonBlankIdx;
      rawLines = rawLines.slice(firstNonBlankIdx);
    }
  }

  // Strip pre-agent shell content (e.g., cd commands, git output) that
  // can appear above the agent header during pane startup.
  const agentHeaderRegex = /(Claude Code|Codex|OpenCode)/i;
  const agentHeaderIdx = rawLines.findIndex((l) => {
    const plain = stripTerminalControls(l);
    return agentHeaderRegex.test(plain) || plain.startsWith('╭───');
  });
  if (agentHeaderIdx > 0) {
    const hasPreAgentContent = rawLines.slice(0, agentHeaderIdx).some((l) => !isVisuallyBlank(l));
    if (hasPreAgentContent) {
      trimmedTopRows += agentHeaderIdx;
      rawLines = rawLines.slice(agentHeaderIdx);
    }
  }

  // When the muxbase startup command is visible in any line — either as the sole
  // content (agentHeaderIdx === -1, agent not yet started) or mixed into the
  // right-side columns of the agent's UI lines (agent rendering on primary screen
  // without clearing the echoed command first) — show a blank frame.
  // paneCreation sends `printf '\033c'` before the agent, so once the agent is
  // rendering this check no longer fires. Safe: these env-var names are internal.
  const hasMuxBaseStartup = rawLines.some((l) => {
    const plain = stripTerminalControls(l);
    return MUXBASE_STARTUP_ENV_PATTERN.test(plain);
  });
  if (hasMuxBaseStartup) {
    rawLines = [];
  }

  const maxRows = Math.max(rows, 1);
  // capture-pane may omit trailing blank lines. Always render from the top of
  // the captured output and clear any remaining rows so content stays anchored
  // to the top-left (matches tmux) rather than drifting to the bottom.
  const visible = rawLines.length > maxRows ? rawLines.slice(0, maxRows) : rawLines;

  let painted = '';
  for (let i = 0; i < maxRows; i++) {
    const line = visible[i] ?? '';
    // \x1b[<r>;<c>H = move cursor to absolute row/col (1-based)
    // \x1b[0m      = reset SGR before the erase so a trailing background from
    //                the previous line's content doesn't smear into \x1b[2K
    // \x1b[2K      = clear entire line (avoid wrap/scroll edge cases)
    painted += `\x1b[${i + 1};1H\x1b[0m\x1b[2K${clipLineToColumns(line, cols)}`;
  }

  // \x1b[0m  = reset SGR attrs (prevents color bleed between frames)
  // \x1b[2J  = clear entire screen (first frame only — guarantees clean slate)
  // Temporarily disable autowrap while painting fixed-position capture rows
  // to avoid last-column wrap artifacts, then restore it before live TUI
  // bytes resume.
  const prefix = isFirst
    ? `${renderCapturedPaneScreenMode(alternateOn)}${CAPTURE_FRAME_CHARSET_SETUP}\x1b[0m\x1b[2J${TERMINAL_AUTOWRAP_DISABLE}`
    : `${renderCapturedPaneScreenMode(alternateOn)}${CAPTURE_FRAME_CHARSET_SETUP}\x1b[0m${TERMINAL_AUTOWRAP_DISABLE}`;
  const cursorRestore = renderCapturedPaneCursor({ cursor, cols, rows: maxRows, trimmedTopRows });
  return prefix + painted + CAPTURE_FRAME_G0_SELECT + TERMINAL_AUTOWRAP_ENABLE + cursorRestore;
}

export function formatScrollbackInsert(content: string, viewportRows: number, viewportCols?: number): string {
  if (!content) return '';
  const lines = normalizeCaptureLines(content);
  if (lines.length === 0) return '';

  return formatScrollbackLines(lines, viewportRows, viewportCols);
}

export function formatScrollbackReplay(content: string, viewportRows: number, viewportCols?: number): string {
  if (!content) return '';

  const lines = normalizeCaptureLines(content);
  if (lines.length === 0) return '';

  return formatScrollbackLines(lines, viewportRows, viewportCols);
}

export function compactAgentScrollbackForReplay(
  content: string,
  options: AgentScrollbackCompactionOptions = {},
): AgentScrollbackCompactionResult {
  if (!content) {
    return { content, droppedLines: 0, duplicateNumberedLines: 0, duplicateStartupFrames: 0 };
  }

  let lines = normalizeCaptureLines(content);
  const firstPromptLine = lines.findIndex(isClaudePromptLine);
  const scanEnd = firstPromptLine >= 0 ? firstPromptLine : lines.length;
  const startupFrames: number[] = [];

  for (let i = 0; i < scanEnd; i += 1) {
    if (isClaudeStartupFrameStart(lines, i)) {
      startupFrames.push(i);
    }
  }

  if (options.dropStartupBeforePrompt && startupFrames.length > 0) {
    const replayStartLine = firstPromptLine >= 0 ? firstPromptLine : lines.length;
    const compactedLines = compactDuplicateNumberedLines(lines.slice(replayStartLine));
    return {
      content: compactedLines.lines.join('\n'),
      droppedLines: replayStartLine + compactedLines.dropped,
      duplicateNumberedLines: compactedLines.dropped,
      duplicateStartupFrames: startupFrames.length,
    };
  }

  if (startupFrames.length < 2) {
    const compactedLines = compactDuplicateNumberedLines(lines);
    return {
      content: compactedLines.lines.join('\n'),
      droppedLines: compactedLines.dropped,
      duplicateNumberedLines: compactedLines.dropped,
      duplicateStartupFrames: startupFrames.length,
    };
  }

  const replayStartLine = startupFrames[startupFrames.length - 1];
  lines = lines.slice(replayStartLine);
  const compactedLines = compactDuplicateNumberedLines(lines);
  return {
    content: compactedLines.lines.join('\n'),
    droppedLines: replayStartLine + compactedLines.dropped,
    duplicateNumberedLines: compactedLines.dropped,
    duplicateStartupFrames: startupFrames.length,
  };
}

function isClaudePromptLine(line: string): boolean {
  return CLAUDE_PROMPT_LINE.test(stripTerminalControls(line).trimStart());
}

function isClaudeStartupFrameStart(lines: string[], index: number): boolean {
  const header = stripTerminalControls(lines[index] ?? '').trim();
  if (!CLAUDE_STARTUP_HEADER.test(header)) return false;

  const sample = lines
    .slice(index, Math.min(lines.length, index + CLAUDE_STARTUP_SCAN_LINES))
    .map((line) => stripTerminalControls(line))
    .join('\n');
  return CLAUDE_STARTUP_BODY.test(sample);
}

function compactDuplicateNumberedLines(lines: string[]): { dropped: number; lines: string[] } {
  const seen = new Set<string>();
  const compacted: string[] = [];
  let dropped = 0;

  for (const line of lines) {
    if (isClaudePromptLine(line)) {
      seen.clear();
    }

    const plain = stripTerminalControls(line);
    if (NUMBERED_ASSISTANT_LINE.test(plain)) {
      const comparable = plain
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (seen.has(comparable)) {
        dropped += 1;
        continue;
      }
      seen.add(comparable);
    }
    compacted.push(line);
  }

  return { dropped, lines: compacted };
}

function stripTerminalControls(line: string): string {
  return line
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1bP[^\x1b]*(?:\x1b\\)/g, '')
    .replace(/\x1b[\^_].*?(?:\x1b\\)/g, '')
    .replace(/\x1b./g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function formatScrollbackLines(lines: string[], viewportRows: number, viewportCols?: number): string {
  const rows = Math.max(viewportRows, 1);
  let out = '';

  for (let offset = 0; offset < lines.length; offset += rows) {
    out += formatScrollbackPage(lines.slice(offset, offset + rows), rows, viewportCols);
  }

  return out;
}

function formatScrollbackPage(lines: string[], rows: number, cols?: number): string {
  let out = CAPTURE_FRAME_CHARSET_SETUP + TERMINAL_AUTOWRAP_DISABLE;
  for (let i = 0; i < lines.length; i++) {
    out += `\x1b[${i + 1};1H\x1b[2K\x1b[0m${clipLineToColumns(lines[i], cols)}`;
  }
  out += `${CAPTURE_FRAME_G0_SELECT}${TERMINAL_AUTOWRAP_ENABLE}\x1b[${rows};1H`;
  out += '\n'.repeat(lines.length);
  return out;
}

function clipLineToColumns(line: string, cols?: number): string {
  const maxCols = normalizeColumnLimit(cols);
  if (maxCols === undefined) return line;

  let out = '';
  let usedCols = 0;
  for (let i = 0; i < line.length;) {
    const control = readTerminalControlSequence(line, i);
    if (control) {
      out += control.sequence;
      i = control.nextIndex;
      continue;
    }

    const codePoint = line.codePointAt(i);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    const width = terminalColumnWidth(codePoint);
    if (usedCols + width > maxCols) break;
    out += char;
    usedCols += width;
    i += char.length;
  }

  return out;
}

function normalizeColumnLimit(cols?: number): number | undefined {
  if (cols === undefined) return undefined;
  if (!Number.isFinite(cols)) return undefined;
  return Math.max(Math.floor(cols), 1);
}

function readTerminalControlSequence(line: string, index: number): { nextIndex: number; sequence: string } | null {
  const code = line.charCodeAt(index);
  if (code === 0x0e || code === 0x0f) {
    return { sequence: line[index], nextIndex: index + 1 };
  }
  if (code !== 0x1b) return null;

  const next = line[index + 1];
  if (!next) return { sequence: line[index], nextIndex: index + 1 };

  if (next === '[') {
    let end = index + 2;
    while (end < line.length) {
      const c = line.charCodeAt(end);
      end += 1;
      if (c >= 0x40 && c <= 0x7e) break;
    }
    return { sequence: line.slice(index, end), nextIndex: end };
  }

  if (next === ']') {
    let end = index + 2;
    while (end < line.length) {
      if (line.charCodeAt(end) === 0x07) {
        end += 1;
        break;
      }
      if (line.charCodeAt(end) === 0x1b && line[end + 1] === '\\') {
        end += 2;
        break;
      }
      end += 1;
    }
    return { sequence: line.slice(index, end), nextIndex: end };
  }

  if (next === 'P' || next === '^' || next === '_') {
    let end = index + 2;
    while (end < line.length) {
      if (line.charCodeAt(end) === 0x1b && line[end + 1] === '\\') {
        end += 2;
        break;
      }
      end += 1;
    }
    return { sequence: line.slice(index, end), nextIndex: end };
  }

  return { sequence: line.slice(index, index + 2), nextIndex: index + 2 };
}

function terminalColumnWidth(codePoint: number): number {
  if (codePoint === 0 || codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (isCombiningCodePoint(codePoint)) return 0;
  return isWideCodePoint(codePoint) ? 2 : 1;
}

function isCombiningCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f)
    || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)
    || (codePoint >= 0x1dc0 && codePoint <= 0x1dff)
    || (codePoint >= 0x20d0 && codePoint <= 0x20ff)
    || (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f
      || codePoint === 0x2329
      || codePoint === 0x232a
      || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
      || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
      || (codePoint >= 0xf900 && codePoint <= 0xfaff)
      || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
      || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
      || (codePoint >= 0xff00 && codePoint <= 0xff60)
      || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
      || (codePoint >= 0x1f300 && codePoint <= 0x1f64f)
      || (codePoint >= 0x1f900 && codePoint <= 0x1f9ff)
      || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  );
}
