import type { AgentName } from 'aumx/core';
import {
  OPENCODE_LINE_DOWN_INPUT,
  OPENCODE_LINE_UP_INPUT,
} from '../../shared/terminal-scroll-protocol';

const PIXELS_PER_LINE = 16;
const PIXELS_PER_PAGE = 480;
const NATIVE_SCROLL_PIXELS_PER_LINE = 24;
const OPENCODE_MESSAGE_SCROLL_PIXELS_PER_LINE = 20;
const AGENT_MESSAGE_SCROLL_PIXELS_PER_PAGE = 120;
const MAX_NATIVE_SCROLL_LINES = 240;
const MAX_OPENCODE_SCROLL_STEPS = 10;
const MAX_AGENT_SCROLL_STEPS = 3;
const MAX_TMUX_SCROLL_LINES = 120;
const MAX_SELECTION_SCROLL_UNITS = 2;

const PAGE_UP_INPUT = '\x1b[5~';
const PAGE_DOWN_INPUT = '\x1b[6~';

export interface TerminalWheelBufferState {
  baseY: number;
  type: 'normal' | 'alternate';
  viewportY: number;
}

export interface TerminalWheelEventState {
  residualDeltaY: number;
}

export interface SelectionWheelState {
  selectionResidualDeltaY: number;
}

export interface TerminalWheelEventLike {
  deltaMode: number;
  deltaY: number;
}

export interface TerminalWheelResolveOptions {
  preferTmuxScroll?: boolean;
}

export type TerminalWheelAction =
  | { type: 'none' }
  | { type: 'suppress' }
  | { lines: number; type: 'native-scroll' }
  | { input: string; type: 'agent-input' }
  | { direction: 'down' | 'up'; lines: number; type: 'tmux-scroll' };

export type SelectionWheelAction =
  | { type: 'none' }
  | { direction: 'down' | 'up'; type: 'selection-scroll'; units: number };

export function resolveTerminalWheelAction(
  agent: AgentName | undefined,
  buffer: TerminalWheelBufferState,
  event: TerminalWheelEventLike,
  state: TerminalWheelEventState,
  options: TerminalWheelResolveOptions = {},
): TerminalWheelAction {
  if (event.deltaY === 0) return { type: 'none' };

  const deltaY = normalizeWheelDeltaY(event);
  if (options.preferTmuxScroll) {
    // buffer.type is useless here: the pty tmux client puts xterm on the
    // alternate screen for every pane, so the main process routes between
    // copy-mode scrollback and agent-specific TUI input using tmux's live
    // #{alternate_on} state.
    return getTmuxScrollAction(deltaY, state);
  }

  const nativeLines = getNativeScrollLines(buffer, deltaY);
  if (nativeLines !== 0) {
    state.residualDeltaY = 0;
    return { lines: nativeLines, type: 'native-scroll' };
  }

  if (buffer.type === 'normal' && buffer.baseY > 0) {
    return { type: 'suppress' };
  }

  if (!agent) {
    return { type: 'none' };
  }

  return getAgentScrollAction(agent, deltaY, state);
}

export function resolveSelectionWheelAction(
  event: TerminalWheelEventLike,
  state: SelectionWheelState,
): SelectionWheelAction {
  if (event.deltaY === 0) return { type: 'none' };

  if (event.deltaMode === 1) {
    state.selectionResidualDeltaY = 0;
    const units = Math.min(MAX_SELECTION_SCROLL_UNITS, Math.max(1, Math.abs(Math.trunc(event.deltaY))));
    const direction = event.deltaY < 0 ? 'up' : 'down';
    return { direction, type: 'selection-scroll', units };
  }

  const pixelDelta = event.deltaMode === 2 ? event.deltaY * PIXELS_PER_PAGE : event.deltaY;
  accumulateSelectionWheelDelta(state, pixelDelta);

  const steps = Math.trunc(Math.abs(state.selectionResidualDeltaY) / NATIVE_SCROLL_PIXELS_PER_LINE);
  if (steps === 0) return { type: 'none' };

  const direction = state.selectionResidualDeltaY < 0 ? 'up' : 'down';
  const units = Math.min(steps, MAX_SELECTION_SCROLL_UNITS);
  const sign = direction === 'up' ? -1 : 1;
  state.selectionResidualDeltaY = sign * (Math.abs(state.selectionResidualDeltaY) % NATIVE_SCROLL_PIXELS_PER_LINE);
  return { direction, type: 'selection-scroll', units };
}

export function resetSelectionWheelResidual(state: SelectionWheelState): void {
  state.selectionResidualDeltaY = 0;
}

function normalizeWheelDeltaY(event: TerminalWheelEventLike): number {
  if (event.deltaMode === 1) return event.deltaY * PIXELS_PER_LINE;
  if (event.deltaMode === 2) return event.deltaY * PIXELS_PER_PAGE;
  return event.deltaY;
}

function getNativeScrollLines(buffer: TerminalWheelBufferState, deltaY: number): number {
  if (buffer.type !== 'normal' || buffer.baseY <= 0) return 0;

  const direction = deltaY < 0 ? -1 : 1;
  const canScrollUp = direction < 0 && buffer.viewportY > 0;
  const canScrollDown = direction > 0 && buffer.viewportY < buffer.baseY;
  if (!canScrollUp && !canScrollDown) return 0;

  const availableLines = direction < 0 ? buffer.viewportY : buffer.baseY - buffer.viewportY;
  const requestedLines = Math.max(1, Math.round(Math.abs(deltaY) / NATIVE_SCROLL_PIXELS_PER_LINE));
  const lines = Math.min(availableLines, MAX_NATIVE_SCROLL_LINES, requestedLines);
  return direction * lines;
}

function getAgentScrollAction(
  agent: AgentName,
  deltaY: number,
  state: TerminalWheelEventState,
): TerminalWheelAction {
  accumulateWheelDelta(state, deltaY);
  const threshold = agent === 'opencode'
    ? OPENCODE_MESSAGE_SCROLL_PIXELS_PER_LINE
    : AGENT_MESSAGE_SCROLL_PIXELS_PER_PAGE;
  const steps = Math.trunc(Math.abs(state.residualDeltaY) / threshold);
  if (steps === 0) return { type: 'suppress' };

  const direction = state.residualDeltaY < 0 ? -1 : 1;
  state.residualDeltaY -= direction * steps * threshold;

  if (agent === 'opencode') {
    return {
      input: (direction < 0 ? OPENCODE_LINE_UP_INPUT : OPENCODE_LINE_DOWN_INPUT)
        .repeat(Math.min(steps, MAX_OPENCODE_SCROLL_STEPS)),
      type: 'agent-input',
    };
  }

  return {
    input: (direction < 0 ? PAGE_UP_INPUT : PAGE_DOWN_INPUT).repeat(Math.min(steps, MAX_AGENT_SCROLL_STEPS)),
    type: 'agent-input',
  };
}

// Line-granular so tmux copy-mode scrolling feels like native terminal
// scrolling: no page-sized dead zone, one line per ~24px of wheel motion.
function getTmuxScrollAction(
  deltaY: number,
  state: TerminalWheelEventState,
): TerminalWheelAction {
  accumulateWheelDelta(state, deltaY);
  const steps = Math.trunc(Math.abs(state.residualDeltaY) / NATIVE_SCROLL_PIXELS_PER_LINE);
  if (steps === 0) return { type: 'suppress' };

  const direction = state.residualDeltaY < 0 ? -1 : 1;
  state.residualDeltaY -= direction * steps * NATIVE_SCROLL_PIXELS_PER_LINE;
  return {
    direction: direction < 0 ? 'up' : 'down',
    lines: Math.min(steps, MAX_TMUX_SCROLL_LINES),
    type: 'tmux-scroll',
  };
}

function accumulateWheelDelta(state: TerminalWheelEventState, deltaY: number): void {
  if (
    state.residualDeltaY !== 0
    && Math.sign(state.residualDeltaY) !== Math.sign(deltaY)
  ) {
    state.residualDeltaY = 0;
  }
  state.residualDeltaY += deltaY;
}

function accumulateSelectionWheelDelta(state: SelectionWheelState, deltaY: number): void {
  if (
    state.selectionResidualDeltaY !== 0
    && Math.sign(state.selectionResidualDeltaY) !== Math.sign(deltaY)
  ) {
    state.selectionResidualDeltaY = 0;
  }
  state.selectionResidualDeltaY += deltaY;
}
