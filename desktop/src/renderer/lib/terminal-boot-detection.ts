const ANSI_ESCAPE_PATTERN =
  /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g;

const USER_INPUT_PROMPT_PATTERNS: RegExp[] = [
  /quick safety check/i,
  /i trust this folder/i,
  /\bno,\s*exit\b/i,
  /trust this folder/i,
  /enter to confirm/i,
  /esc to cancel/i,
  /select\s+an?\s+option/i,
  /press\s+(enter|return)\s+to\s+continue/i,
  /\bcontinue\?\s*\((?:y\/n|y\/N)\)/i,
];

export function normalizeTerminalText(chunk: string): string {
  return chunk
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(CONTROL_CHAR_PATTERN, '')
    .replace(/\r/g, '\n');
}

export function appendTerminalTail(
  currentTail: string,
  chunk: string,
  maxLength: number = 6000,
): string {
  const normalized = normalizeTerminalText(chunk);
  const combined = `${currentTail}${normalized}`;
  if (combined.length <= maxLength) return combined;
  return combined.slice(-maxLength);
}

export function hasUserInputPrompt(text: string): boolean {
  return USER_INPUT_PROMPT_PATTERNS.some((pattern) => pattern.test(text));
}

// Index of the last (rightmost) match of a source regex, or -1. Uses a fresh
// global copy so it never mutates a shared regex's lastIndex.
function lastMatchIndex(pattern: RegExp, text: string): number {
  const global = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
  let last = -1;
  for (let match = global.exec(text); match !== null; match = global.exec(text)) {
    if (match.index > last) last = match.index;
  }
  return last;
}

/**
 * Position of the last user-input prompt in the text, or -1 if none.
 * Used to tell a still-pending prompt (near the end of the tail) from a
 * resolved boot-time prompt (e.g. the trust/safety check) that has since been
 * answered and scrolled behind newer output like the agent's ready header.
 */
function lastUserInputPromptIndex(text: string): number {
  let last = -1;
  for (const pattern of USER_INPUT_PROMPT_PATTERNS) {
    last = Math.max(last, lastMatchIndex(pattern, text));
  }
  return last;
}

// Non-global so `.test()`/`.exec()` are stateless; callers that scan for the
// last match build a fresh global copy locally.
const AGENT_STARTUP_MARKERS: Record<string, RegExp> = {
  claude: /\bclaude[\s-]?code\b|\bclaude-opus\b|\bopus\s+\d|\bbypass permissions\b/i,
  codex: /\bcodex\b/i,
  opencode: /\bopencode\b/i,
  pi: /\bpi\s+v\d+\.\d+/i,
};

// Steady-state markers from the agent's ready UI (persist in the tail, unlike
// the one-shot boot banner which can scroll out of the rolling window). Only
// tokens verified to appear *after* the input surface is live belong here — a
// marker that fires during loading would clear the overlay early and risk
// injecting stray keystrokes. A missing/absent ready marker is harmless:
// isAgentBootReady falls back to the startup marker (pre-fix behavior). Claude's
// bottom bar ("auto mode on … /effort") only renders once the prompt is live;
// codex/opencode have no verified steady token yet, so they use the fallback.
const AGENT_READY_MARKERS: Record<string, RegExp> = {
  claude: /auto mode on|\/effort\b/i,
};

export function hasAgentStartupMarker(
  agent: string | undefined,
  text: string,
): boolean {
  if (!agent) return false;
  const marker = AGENT_STARTUP_MARKERS[agent];
  return marker ? marker.test(text) : false;
}

function markerFor(markers: Record<string, RegExp>, agent: string | undefined): RegExp | null {
  if (!agent) return null;
  return markers[agent] ?? null;
}

function readyAfterLastPrompt(marker: RegExp, text: string): boolean {
  const promptIndex = lastUserInputPromptIndex(text);
  if (promptIndex === -1) return true;
  return lastMatchIndex(marker, text) >= promptIndex;
}

/**
 * Whether the agent's TUI has finished booting. A steady ready-UI marker is
 * authoritative (it survives the boot banner scrolling out of the tail); the
 * one-shot startup banner is the fallback. In both cases a boot-time trust
 * prompt that has since been answered lingers in the rolling tail, so it only
 * vetoes readiness while it's still the newest signal — once the marker paints
 * after it (marker index ≥ last prompt index), the agent is ready.
 */
export function isAgentBootReady(agent: string | undefined, text: string): boolean {
  const readyMarker = markerFor(AGENT_READY_MARKERS, agent);
  if (readyMarker && readyMarker.test(text)) {
    return readyAfterLastPrompt(readyMarker, text);
  }
  const startupMarker = markerFor(AGENT_STARTUP_MARKERS, agent);
  if (startupMarker && startupMarker.test(text)) {
    return readyAfterLastPrompt(startupMarker, text);
  }
  return false;
}
