const ENTER_KEY = 'Enter';

export const SHIFT_ENTER_NEWLINE_INPUT = '\x1b[13;2u';

const CSI_U_AGENTS = new Set(['claude', 'codex', 'pi']);

export interface TerminalKeyboardEvent {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
  type: string;
}

export function isPlainShiftEnter(event: TerminalKeyboardEvent): boolean {
  return event.key === ENTER_KEY
    && event.shiftKey
    && !event.ctrlKey
    && !event.altKey
    && !event.metaKey;
}

function supportsCsiU(agent: string | undefined): boolean {
  return !!agent && CSI_U_AGENTS.has(agent.toLowerCase());
}

export function getTerminalKeyboardInputOverride(
  event: TerminalKeyboardEvent,
  agent?: string,
): string | null {
  if (event.type !== 'keydown') return null;
  if (!isPlainShiftEnter(event)) return null;
  if (!supportsCsiU(agent)) return null;
  return SHIFT_ENTER_NEWLINE_INPUT;
}

/**
 * True when xterm's default Shift+Enter handling should be suppressed.
 * Suppress only when we have an override to substitute, otherwise let xterm
 * emit its native CR so panes without CSI-u support (opencode, plain shell) still
 * receive newline input.
 */
export function shouldSuppressDefaultShiftEnter(
  event: TerminalKeyboardEvent,
  agent?: string,
): boolean {
  if (!isPlainShiftEnter(event)) return false;
  return getTerminalKeyboardInputOverride(event, agent) !== null;
}

