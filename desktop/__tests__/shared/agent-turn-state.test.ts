import { describe, expect, it } from 'vitest';
import { deriveAgentTurnState } from '../../src/shared/agent-turn-state';

describe('deriveAgentTurnState', () => {
  it('prioritizes awaiting input over every other signal', () => {
    // Arrange
    const snapshot = { awaitingUserInput: true, isOngoing: true, turnCompleted: false };

    // Act
    const state = deriveAgentTurnState(snapshot);

    // Assert
    expect(state).toBe('awaiting_input');
  });

  it('maps a completed turn to completed when not awaiting input', () => {
    // Arrange
    const snapshot = { awaitingUserInput: false, isOngoing: false, turnCompleted: true };

    // Act
    const state = deriveAgentTurnState(snapshot);

    // Assert
    expect(state).toBe('completed');
  });

  it('maps an ongoing turn to ongoing', () => {
    // Arrange
    const snapshot = { awaitingUserInput: false, isOngoing: true, turnCompleted: false };

    // Act
    const state = deriveAgentTurnState(snapshot);

    // Assert
    expect(state).toBe('ongoing');
  });

  it('returns unknown when no signal has fired yet', () => {
    // Arrange
    const snapshot = { awaitingUserInput: false, isOngoing: false, turnCompleted: false };

    // Act
    const state = deriveAgentTurnState(snapshot);

    // Assert
    expect(state).toBe('unknown');
  });

  it('treats every field as optional', () => {
    // Arrange / Act
    const state = deriveAgentTurnState({});

    // Assert
    expect(state).toBe('unknown');
  });
});
