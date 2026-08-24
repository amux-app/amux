import type { NormalizedSession } from '../../shared/agent-session-types';

type SessionStatusSnapshot = Pick<
  NormalizedSession,
  'awaitingUserInput' | 'isOngoing' | 'pendingUserQuestion' | 'turnCompleted' | 'lastUpdateTime'
>;

export function didTurnJustComplete(
  previous: SessionStatusSnapshot | undefined,
  next: SessionStatusSnapshot,
): boolean {
  if (!previous) return false;
  return next.turnCompleted === true
    && previous.turnCompleted !== true
    && !next.awaitingUserInput;
}

export function didTurnJustStart(
  previous: SessionStatusSnapshot | undefined,
  next: SessionStatusSnapshot,
): boolean {
  if (!previous) return false;
  return previous.turnCompleted === true && next.turnCompleted === false;
}
