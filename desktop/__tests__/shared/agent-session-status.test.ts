import { describe, expect, it } from 'vitest';
import { didTurnJustComplete, didTurnJustStart } from '../../src/renderer/lib/agent-session-status';

describe('didTurnJustComplete', () => {
  const snapshot = (turnCompleted: boolean, awaitingUserInput = false) => ({
    awaitingUserInput,
    isOngoing: !turnCompleted && !awaitingUserInput,
    pendingUserQuestion: undefined,
    turnCompleted,
    lastUpdateTime: 1,
  });

  it('fires on a false -> true turnCompleted edge', () => {
    expect(didTurnJustComplete(snapshot(false), snapshot(true))).toBe(true);
  });

  it('does not fire without a previous snapshot (hydration / app load)', () => {
    expect(didTurnJustComplete(undefined, snapshot(true))).toBe(false);
  });

  it('does not fire when the previous turn was already completed', () => {
    expect(didTurnJustComplete(snapshot(true), snapshot(true))).toBe(false);
  });

  it('does not fire while the turn is still in progress', () => {
    expect(didTurnJustComplete(snapshot(false), snapshot(false))).toBe(false);
  });

  it('does not fire when the agent is awaiting user input', () => {
    expect(didTurnJustComplete(snapshot(false), snapshot(true, true))).toBe(false);
  });
});

describe('didTurnJustStart', () => {
  const snapshot = (turnCompleted: boolean) => ({
    awaitingUserInput: false,
    isOngoing: !turnCompleted,
    pendingUserQuestion: undefined,
    turnCompleted,
    lastUpdateTime: 1,
  });

  it('fires on a true -> false turnCompleted edge (new turn began)', () => {
    expect(didTurnJustStart(snapshot(true), snapshot(false))).toBe(true);
  });

  it('does not fire without a previous snapshot', () => {
    expect(didTurnJustStart(undefined, snapshot(false))).toBe(false);
  });

  it('does not fire when the previous turn was not completed', () => {
    expect(didTurnJustStart(snapshot(false), snapshot(false))).toBe(false);
  });

  it('does not fire while the turn stays completed', () => {
    expect(didTurnJustStart(snapshot(true), snapshot(true))).toBe(false);
  });
});
