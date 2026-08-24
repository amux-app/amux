export type AgentTurnState = 'awaiting_input' | 'completed' | 'ongoing' | 'unknown';

export interface AgentTurnStateSnapshot {
  awaitingUserInput?: boolean;
  isOngoing?: boolean;
  turnCompleted?: boolean;
}

/**
 * Pure priority resolution for the main-process status arbiter: awaiting input
 * beats a completed turn, which beats an ongoing turn.
 */
export function deriveAgentTurnState(session: AgentTurnStateSnapshot): AgentTurnState {
  if (session.awaitingUserInput) return 'awaiting_input';
  if (session.turnCompleted === true) return 'completed';
  if (session.isOngoing) return 'ongoing';
  return 'unknown';
}
