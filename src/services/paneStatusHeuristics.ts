import type { AgentName } from '../utils/agentLaunch.js';

/**
 * Deterministic, content-only status heuristics for a pane capture. Kept free
 * of mutable state so both the poll loop and its tests can reason about a frame
 * in isolation.
 */

// The most reliable indicator for every agent: it is painted only while the
// agent is actively processing. Additional text (timings) may follow. The
// leading paren is optional because Codex's footer omits it ("Esc to
// interrupt"), while Claude's includes it ("(esc to interrupt").
const WORKING_PATTERN = /\(?\s*\besc\s+to\s+interrupt/i;

const OPENCODE_WORKING_PATTERNS = [
  // OpenCode 1.18+ paints this beside its animated progress glyphs. Unlike
  // Claude and Codex, the current footer intentionally omits "to".
  /\besc\s+interrupt\b/i,
  /working\.\.\./i,
  /⏳.*processing/i,
];

const PI_WORKING_PATTERNS = [
  // Pi spells out "escape" in its active footer and renders the animated
  // working label on the line above it.
  /\bescape\s+interrupt\b/i,
  /\bworking\.\.\./i,
];

const OPENCODE_IDLE_PATTERNS = [
  // OpenCode's empty composer placeholder is rendered only when it is ready
  // to accept the next prompt. Search the visible frame because the TUI pads
  // the composer above a bottom-aligned cwd/version footer.
  /\bAsk anything\.\.\./i,
];

// Pi can prefix its context token with cost/subscription statistics, for
// example "$0.000 (sub) 0.0%/1.0M". The footer is bottom-aligned, so search
// within its final rows instead of requiring the token at column zero.
const PI_CONTEXT_FOOTER_PATTERN = /(?:^|\s)(?:\?|\d+(?:\.\d+)?%)\/\S+(?:\s+\([^)]+\))?/i;
const PI_FOOTER_LINE_COUNT = 2;
const PI_INPUT_ACTIVE_PATTERNS = [
  /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+\S/i,
  /^\s*(?:working\.\.\.|retrying\b|(?:auto-)?compacting\b|summarizing\b)/i,
];

const WORKING_TAIL_LINES = 8;

export type TailStatus = 'idle' | 'working' | null;

/**
 * The captured visible frame can carry trailing whitespace-only rows below the
 * agent's status chrome (e.g. a classic-renderer footer with blank cursor rows
 * beneath it). Stripping them before windowing keeps the tail anchored to the
 * last real content instead of the last raw row.
 */
function stripTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  return lines.slice(0, end);
}

function workingPatternsFor(agent?: AgentName): RegExp[] {
  if (agent === 'opencode') return [WORKING_PATTERN, ...OPENCODE_WORKING_PATTERNS];
  if (agent === 'pi') return [WORKING_PATTERN, ...PI_WORKING_PATTERNS];
  return [WORKING_PATTERN];
}

function idlePatternsFor(agent?: AgentName): RegExp[] {
  if (agent === 'opencode') return OPENCODE_IDLE_PATTERNS;
  return [];
}

/**
 * Detects the input-ready chrome used only during a fresh launch. Working
 * markers have priority because both TUIs can briefly retain composer chrome
 * while transitioning into an active turn.
 */
export function isAgentReadyForInput(content: string, agent: AgentName): boolean {
  const lines = stripTrailingBlankLines(content.split('\n'));
  if (agent === 'opencode') {
    const workingPatterns = workingPatternsFor(agent);
    const active = lines.some((line) => workingPatterns.some((pattern) => pattern.test(line)));
    return !active && lines.some((line) => OPENCODE_IDLE_PATTERNS.some((pattern) => pattern.test(line)));
  }
  if (agent !== 'pi') return false;

  const activePatterns = [...workingPatternsFor(agent), ...PI_INPUT_ACTIVE_PATTERNS];
  const active = lines.some((line) => activePatterns.some((pattern) => pattern.test(line)));
  return !active && lines.slice(-PI_FOOTER_LINE_COUNT)
    .some((line) => PI_CONTEXT_FOOTER_PATTERN.test(line));
}

/**
 * Classifies status chrome in a VISIBLE frame. Working indicators are checked
 * first. OpenCode also exposes an idle-only empty-composer marker, allowing an
 * immediate idle transition. Pi's context footer persists during active turns,
 * so Pi continues through the analyzer's stable-capture fallback.
 */
export function classifyTailStatus(content: string, agent?: AgentName): TailStatus {
  const trimmedLines = stripTrailingBlankLines(content.split('\n'));
  const workingWindow = trimmedLines.slice(-WORKING_TAIL_LINES);
  const workingPatterns = workingPatternsFor(agent);

  const isWorking = workingWindow.some(line => workingPatterns.some(pattern => pattern.test(line)));
  if (isWorking) return 'working';

  const idlePatterns = idlePatternsFor(agent);
  const isIdle = trimmedLines.some(line => idlePatterns.some(pattern => pattern.test(line)));
  return isIdle ? 'idle' : null;
}
