import { describe, expect, it } from 'vitest';
import {
  resetSelectionWheelResidual,
  resolveSelectionWheelAction,
  resolveTerminalWheelAction,
  type TerminalWheelBufferState,
  type TerminalWheelEventState,
  type SelectionWheelState,
} from '../../src/renderer/lib/terminal-wheel';

function makeState(): TerminalWheelEventState {
  return { residualDeltaY: 0 };
}

function makeSelectionWheelState(): SelectionWheelState {
  return { selectionResidualDeltaY: 0 };
}

function makeBuffer(overrides: Partial<TerminalWheelBufferState> = {}): TerminalWheelBufferState {
  return {
    baseY: 0,
    type: 'alternate',
    viewportY: 0,
    ...overrides,
  };
}

describe('resolveTerminalWheelAction', () => {
  it('uses native xterm scrollback when normal-buffer history is available', () => {
    // Arrange
    const state = makeState();
    const buffer = makeBuffer({ baseY: 100, type: 'normal', viewportY: 100 });

    // Act
    const action = resolveTerminalWheelAction('claude', buffer, { deltaMode: 0, deltaY: -96 }, state);

    // Assert
    expect(action).toEqual({ lines: -4, type: 'native-scroll' });
    expect(state.residualDeltaY).toBe(0);
  });

  it('stops at native scrollback boundaries without leaking wheel input into the agent', () => {
    const bufferAtTop = makeBuffer({ baseY: 100, type: 'normal', viewportY: 0 });
    const bufferAtBottom = makeBuffer({ baseY: 100, type: 'normal', viewportY: 100 });

    expect(resolveTerminalWheelAction(
      'claude',
      bufferAtTop,
      { deltaMode: 0, deltaY: -96 },
      makeState(),
    )).toEqual({ type: 'suppress' });
    expect(resolveTerminalWheelAction(
      'claude',
      bufferAtBottom,
      { deltaMode: 0, deltaY: 96 },
      makeState(),
    )).toEqual({ type: 'suppress' });
    expect(resolveTerminalWheelAction(
      'claude',
      bufferAtTop,
      { deltaMode: 0, deltaY: 96 },
      makeState(),
    )).toEqual({ lines: 4, type: 'native-scroll' });
  });

  it('keeps large native wheel gestures fast enough for long agent scrollback', () => {
    // Arrange
    const state = makeState();
    const buffer = makeBuffer({ baseY: 1_300, type: 'normal', viewportY: 1_300 });

    // Act
    const action = resolveTerminalWheelAction('claude', buffer, { deltaMode: 0, deltaY: -16_000 }, state);

    // Assert
    expect(action).toEqual({ lines: -240, type: 'native-scroll' });
    expect(state.residualDeltaY).toBe(0);
  });

  it('maps OpenCode wheel movement to message-line scrolling when no terminal scrollback exists', () => {
    // Arrange
    const state = makeState();
    const buffer = makeBuffer({ type: 'alternate' });

    // Act
    const action = resolveTerminalWheelAction('opencode', buffer, { deltaMode: 0, deltaY: -45 }, state);

    // Assert
    expect(action).toEqual({ input: '\x1b\x19\x1b\x19', type: 'agent-input' });
    expect(state.residualDeltaY).toBe(-5);
  });

  it('suppresses small OpenCode wheel deltas until enough movement accumulates', () => {
    // Arrange
    const state = makeState();
    const buffer = makeBuffer({ type: 'alternate' });

    // Act
    const action = resolveTerminalWheelAction('opencode', buffer, { deltaMode: 0, deltaY: -8 }, state);

    // Assert
    expect(action).toEqual({ type: 'suppress' });
    expect(state.residualDeltaY).toBe(-8);
  });

  it('maps Claude and Codex wheel movement to page scrolling when no terminal scrollback exists', () => {
    // Arrange
    const state = makeState();
    const buffer = makeBuffer({ type: 'alternate' });

    // Act
    const action = resolveTerminalWheelAction('codex', buffer, { deltaMode: 0, deltaY: 260 }, state);

    // Assert
    expect(action).toEqual({ input: '\x1b[6~\x1b[6~', type: 'agent-input' });
    expect(state.residualDeltaY).toBe(20);
  });

  it('maps Codex wheel movement to line-wise tmux scrolling when PTY scroll is preferred', () => {
    // Arrange
    const state = makeState();
    const buffer = makeBuffer({ type: 'alternate' });

    // Act
    const action = resolveTerminalWheelAction('codex', buffer, { deltaMode: 0, deltaY: -260 }, state, {
      preferTmuxScroll: true,
    });

    // Assert: 260px / 24px-per-line = 10 lines, residual keeps the remainder.
    expect(action).toEqual({ direction: 'up', lines: 10, type: 'tmux-scroll' });
    expect(state.residualDeltaY).toBe(-20);
  });

  it('routes Claude to tmux-scroll so the main process picks keys from live alternate_on', () => {
    // Arrange: the renderer no longer guesses Claude's scroll keys. It emits a
    // tmux-scroll action; TerminalManager sends PgUp/PgDn when the pane is live
    // fullscreen (alt_on=1) or drives copy-mode when classic (alt_on=0). This is
    // robust to legacy panes with no renderer stamp and to setting changes.
    const state = makeState();
    const buffer = makeBuffer({ type: 'alternate' });

    // Act
    const action = resolveTerminalWheelAction('claude', buffer, { deltaMode: 0, deltaY: -260 }, state, {
      preferTmuxScroll: true,
    });

    // Assert: 260px / 24px-per-line = 10 lines.
    expect(action).toEqual({ direction: 'up', lines: 10, type: 'tmux-scroll' });
    expect(state.residualDeltaY).toBe(-20);
  });

  it('routes PTY OpenCode through tmux so live alternate-screen state owns the decision', () => {
    // Arrange
    const state = makeState();
    const buffer = makeBuffer({ type: 'alternate' });

    // Act
    const action = resolveTerminalWheelAction('opencode', buffer, { deltaMode: 0, deltaY: -45 }, state, {
      preferTmuxScroll: true,
    });

    // Assert
    expect(action).toEqual({ direction: 'up', lines: 1, type: 'tmux-scroll' });
    expect(state.residualDeltaY).toBe(-21);
  });

  it('emits a line for small wheel ticks without a page-sized dead zone', () => {
    // Arrange: Codex stays on the line-wise tmux-scroll path (it is not a
    // self-scrolling alt-screen agent), so small ticks still map to one line.
    const state = makeState();
    const buffer = makeBuffer({ type: 'alternate' });

    // Act
    const action = resolveTerminalWheelAction('codex', buffer, { deltaMode: 0, deltaY: -30 }, state, {
      preferTmuxScroll: true,
    });

    // Assert
    expect(action).toEqual({ direction: 'up', lines: 1, type: 'tmux-scroll' });
    expect(state.residualDeltaY).toBe(-6);
  });

  it('does not make users overcome stale momentum after reversing wheel direction', () => {
    const state = makeState();
    const buffer = makeBuffer({ type: 'alternate' });

    const initial = resolveTerminalWheelAction(undefined, buffer, { deltaMode: 0, deltaY: -20 }, state, {
      preferTmuxScroll: true,
    });
    const reversed = resolveTerminalWheelAction(undefined, buffer, { deltaMode: 0, deltaY: 24 }, state, {
      preferTmuxScroll: true,
    });

    expect(initial).toEqual({ type: 'suppress' });
    expect(reversed).toEqual({ direction: 'down', lines: 1, type: 'tmux-scroll' });
    expect(state.residualDeltaY).toBe(0);
  });

  it('routes Claude to tmux-scroll under PTY even when normal-buffer xterm scrollback exists', () => {
    // Arrange: preferTmuxScroll wins over ephemeral xterm scrollback; the main
    // process then chooses PgUp/PgDn vs copy-mode from the pane's live alt state.
    const state = makeState();
    const buffer = makeBuffer({ baseY: 100, type: 'normal', viewportY: 100 });

    // Act
    const action = resolveTerminalWheelAction('claude', buffer, { deltaMode: 0, deltaY: -260 }, state, {
      preferTmuxScroll: true,
    });

    // Assert
    expect(action).toEqual({ direction: 'up', lines: 10, type: 'tmux-scroll' });
    expect(state.residualDeltaY).toBe(-20);
  });

  it('prefers persistent tmux scrolling over ephemeral xterm scrollback for PTY panes', () => {
    // Arrange: Codex — not a self-scrolling agent, so tmux-scroll owns it.
    const state = makeState();
    const buffer = makeBuffer({ baseY: 100, type: 'normal', viewportY: 100 });

    // Act
    const action = resolveTerminalWheelAction('codex', buffer, { deltaMode: 0, deltaY: -260 }, state, {
      preferTmuxScroll: true,
    });

    // Assert
    expect(action).toEqual({ direction: 'up', lines: 10, type: 'tmux-scroll' });
    expect(state.residualDeltaY).toBe(-20);
  });

  it('maps plain PTY terminals to tmux scrolling', () => {
    // Arrange
    const state = makeState();
    const buffer = makeBuffer({ type: 'alternate' });

    // Act
    const action = resolveTerminalWheelAction(undefined, buffer, { deltaMode: 0, deltaY: 260 }, state, {
      preferTmuxScroll: true,
    });

    // Assert
    expect(action).toEqual({ direction: 'down', lines: 10, type: 'tmux-scroll' });
    expect(state.residualDeltaY).toBe(20);
  });

  it('leaves plain non-PTY terminals untouched', () => {
    // Arrange
    const state = makeState();
    const buffer = makeBuffer({ type: 'alternate' });

    // Act
    const action = resolveTerminalWheelAction(undefined, buffer, { deltaMode: 0, deltaY: -96 }, state);

    // Assert
    expect(action).toEqual({ type: 'none' });
  });
});

describe('resolveSelectionWheelAction', () => {
  it('returns no-op for zero delta', () => {
    const state = makeSelectionWheelState();
    expect(resolveSelectionWheelAction({ deltaMode: 0, deltaY: 0 }, state)).toEqual({ type: 'none' });
    expect(state.selectionResidualDeltaY).toBe(0);
  });

  it('returns one line-mode unit per tick without accumulation', () => {
    const state = makeSelectionWheelState();
    expect(resolveSelectionWheelAction({ deltaMode: 1, deltaY: -3 }, state))
      .toEqual({ direction: 'up', type: 'selection-scroll', units: 2 });
    expect(state.selectionResidualDeltaY).toBe(0);
  });

  it('accumulates pixel deltas and emits a unit only after 24px', () => {
    const state = makeSelectionWheelState();
    expect(resolveSelectionWheelAction({ deltaMode: 0, deltaY: -12 }, state)).toEqual({ type: 'none' });
    expect(state.selectionResidualDeltaY).toBe(-12);
    expect(resolveSelectionWheelAction({ deltaMode: 0, deltaY: -13 }, state))
      .toEqual({ direction: 'up', type: 'selection-scroll', units: 1 });
    expect(state.selectionResidualDeltaY).toBe(-1);
  });

  it('resets the residual when direction changes', () => {
    const state = makeSelectionWheelState();
    resolveSelectionWheelAction({ deltaMode: 0, deltaY: -20 }, state);
    expect(state.selectionResidualDeltaY).toBe(-20);
    resolveSelectionWheelAction({ deltaMode: 0, deltaY: 10 }, state);
    expect(state.selectionResidualDeltaY).toBe(10);
  });

  it('does not carry pixel momentum across a line-mode selection wheel event', () => {
    const state = makeSelectionWheelState();

    expect(resolveSelectionWheelAction({ deltaMode: 0, deltaY: -20 }, state))
      .toEqual({ type: 'none' });
    expect(resolveSelectionWheelAction({ deltaMode: 1, deltaY: 1 }, state))
      .toEqual({ direction: 'down', type: 'selection-scroll', units: 1 });
    expect(state.selectionResidualDeltaY).toBe(0);
    expect(resolveSelectionWheelAction({ deltaMode: 0, deltaY: -4 }, state))
      .toEqual({ type: 'none' });
    expect(state.selectionResidualDeltaY).toBe(-4);
  });

  it('coalesces a burst to at most 2 units and drops excess, keeping fractional residual', () => {
    const state = makeSelectionWheelState();
    const action = resolveSelectionWheelAction({ deltaMode: 0, deltaY: 200 }, state);
    expect(action).toEqual({ direction: 'down', type: 'selection-scroll', units: 2 });
    expect(state.selectionResidualDeltaY).toBe(200 % 24);
  });

  it('resets selectionResidualDeltaY to zero when resetSelectionWheelResidual is called', () => {
    const state = makeSelectionWheelState();
    resolveSelectionWheelAction({ deltaMode: 0, deltaY: -15 }, state);
    resetSelectionWheelResidual(state);
    expect(state.selectionResidualDeltaY).toBe(0);
  });
});
