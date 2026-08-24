import { describe, expect, it } from 'vitest';
import {
  getTerminalKeyboardInputOverride,
  isPlainShiftEnter,
  SHIFT_ENTER_NEWLINE_INPUT,
  shouldSuppressDefaultShiftEnter,
  type TerminalKeyboardEvent,
} from '../../src/renderer/lib/terminal-keyboard';

function makeKeyboardEvent(overrides: Partial<TerminalKeyboardEvent> = {}): TerminalKeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    key: 'Enter',
    metaKey: false,
    shiftKey: false,
    type: 'keydown',
    ...overrides,
  };
}

describe('terminal keyboard input overrides', () => {
  it('maps plain Shift+Enter keydown to the CSI u escape sequence for Claude', () => {
    // Arrange
    const event = makeKeyboardEvent({ shiftKey: true });

    // Act
    const inputOverride = getTerminalKeyboardInputOverride(event, 'claude');

    // Assert
    expect(isPlainShiftEnter(event)).toBe(true);
    expect(inputOverride).toBe(SHIFT_ENTER_NEWLINE_INPUT);
    expect(inputOverride).toBe('\x1b[13;2u');
  });

  it('maps plain Shift+Enter keydown to the CSI u escape sequence for Codex', () => {
    // Arrange
    const event = makeKeyboardEvent({ shiftKey: true });

    // Act
    const inputOverride = getTerminalKeyboardInputOverride(event, 'codex');

    // Assert
    expect(inputOverride).toBe(SHIFT_ENTER_NEWLINE_INPUT);
  });

  it('maps plain Shift+Enter keydown to the CSI u escape sequence for Pi', () => {
    const event = makeKeyboardEvent({ shiftKey: true });

    expect(getTerminalKeyboardInputOverride(event, 'pi')).toBe(SHIFT_ENTER_NEWLINE_INPUT);
  });

  it('does NOT emit CSI u for agents that do not support it (opencode, plain shell)', () => {
    // Arrange
    const event = makeKeyboardEvent({ shiftKey: true });

    // Act
    const opencodeOverride = getTerminalKeyboardInputOverride(event, 'opencode');
    const noAgentOverride = getTerminalKeyboardInputOverride(event, undefined);

    // Assert — opencode and shell panes would otherwise see literal "ESC[13;2u" garbage
    expect(opencodeOverride).toBeNull();
    expect(noAgentOverride).toBeNull();
  });

  it('suppresses non-keydown Shift+Enter events without duplicating input', () => {
    // Arrange
    const event = makeKeyboardEvent({ shiftKey: true, type: 'keyup' });

    // Act
    const inputOverride = getTerminalKeyboardInputOverride(event, 'claude');

    // Assert
    expect(isPlainShiftEnter(event)).toBe(true);
    expect(inputOverride).toBeNull();
  });

  it('does not override Enter chords with other modifiers', () => {
    // Arrange
    const modifiedEvents = [
      makeKeyboardEvent({ ctrlKey: true, shiftKey: true }),
      makeKeyboardEvent({ altKey: true, shiftKey: true }),
      makeKeyboardEvent({ metaKey: true, shiftKey: true }),
      makeKeyboardEvent({ shiftKey: false }),
    ];

    // Act
    const inputOverrides = modifiedEvents.map((event) => getTerminalKeyboardInputOverride(event, 'claude'));

    // Assert
    expect(modifiedEvents.every((event) => !isPlainShiftEnter(event))).toBe(true);
    expect(inputOverrides).toEqual([null, null, null, null]);
  });
});

describe('shouldSuppressDefaultShiftEnter', () => {
  it('suppresses default Shift+Enter for Claude, Codex, and Pi (we substitute CSI u)', () => {
    // Arrange
    const event = makeKeyboardEvent({ shiftKey: true });

    // Act + Assert
    expect(shouldSuppressDefaultShiftEnter(event, 'claude')).toBe(true);
    expect(shouldSuppressDefaultShiftEnter(event, 'codex')).toBe(true);
    expect(shouldSuppressDefaultShiftEnter(event, 'pi')).toBe(true);
  });

  it('does NOT suppress default Shift+Enter for opencode/shell (let xterm emit CR)', () => {
    // Arrange — regression guard for the silent-swallow bug:
    // before this fix opencode users got nothing on Shift+Enter.
    const event = makeKeyboardEvent({ shiftKey: true });

    // Act + Assert
    expect(shouldSuppressDefaultShiftEnter(event, 'opencode')).toBe(false);
    expect(shouldSuppressDefaultShiftEnter(event, undefined)).toBe(false);
  });

  it('does NOT suppress non-Shift+Enter events', () => {
    // Arrange
    const plainEnter = makeKeyboardEvent({ shiftKey: false });
    const ctrlShiftEnter = makeKeyboardEvent({ shiftKey: true, ctrlKey: true });

    // Act + Assert
    expect(shouldSuppressDefaultShiftEnter(plainEnter, 'claude')).toBe(false);
    expect(shouldSuppressDefaultShiftEnter(ctrlShiftEnter, 'claude')).toBe(false);
  });
});
