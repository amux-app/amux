type TerminalSelectionOwner = 'application' | 'pending' | 'terminal';
type TerminalSelectionGesturePhase = 'active' | 'canceled' | 'completed';

export interface TerminalSelectionCell {
  x: number;
  y: number;
}

export interface TerminalSelectionPosition {
  end: TerminalSelectionCell;
  start: TerminalSelectionCell;
}

export interface TerminalSelectionGesture {
  anchor: TerminalSelectionCell;
  initialSelection?: TerminalSelectionPosition;
  owner: TerminalSelectionOwner;
  ownsVisualSelection: boolean;
  phase: TerminalSelectionGesturePhase;
  pointer: TerminalSelectionCell;
}

export function beginTerminalSelectionGesture(
  anchor: TerminalSelectionCell,
  initialSelection?: TerminalSelectionPosition,
): TerminalSelectionGesture {
  return {
    anchor: { ...anchor },
    initialSelection: cloneSelectionPosition(initialSelection),
    owner: 'pending',
    ownsVisualSelection: false,
    phase: 'active',
    pointer: { ...anchor },
  };
}

export function claimTerminalSelectionGesture(
  gesture: TerminalSelectionGesture,
  selection: TerminalSelectionPosition | undefined,
): TerminalSelectionGesture {
  if (
    gesture.phase === 'canceled'
    || gesture.owner !== 'pending'
    || !selection
    || isSameTerminalSelectionPosition(selection, gesture.initialSelection)
  ) return gesture;

  return { ...gesture, owner: 'terminal' };
}

export function markTerminalSelectionGestureApplicationOwned(
  gesture: TerminalSelectionGesture,
): TerminalSelectionGesture {
  if (gesture.phase !== 'active' || gesture.owner !== 'pending') return gesture;
  return { ...gesture, owner: 'application' };
}

export function completeTerminalSelectionGesture(
  gesture: TerminalSelectionGesture,
): TerminalSelectionGesture {
  return gesture.phase === 'active' ? { ...gesture, phase: 'completed' } : gesture;
}

export function cancelTerminalSelectionGesture(
  gesture: TerminalSelectionGesture,
): TerminalSelectionGesture {
  return gesture.phase === 'active' ? { ...gesture, phase: 'canceled' } : gesture;
}

export function advanceTerminalSelectionGesture(
  gesture: TerminalSelectionGesture | null,
  getSelectionPosition: () => TerminalSelectionPosition | undefined,
  direction: 'down' | 'up',
  lines: number,
): TerminalSelectionGesture | null {
  if (!gesture) return null;
  let nextGesture = gesture;
  if (!nextGesture.ownsVisualSelection) {
    const position = getSelectionPosition();
    if (position) {
      nextGesture = {
        ...nextGesture,
        anchor: { ...(direction === 'up' ? position.end : position.start) },
        pointer: { ...(direction === 'up' ? position.start : position.end) },
      };
    }
  }
  if (lines <= 0) return nextGesture;

  const rowDelta = direction === 'up' ? lines : -lines;
  const anchor = { ...nextGesture.anchor, y: nextGesture.anchor.y + rowDelta };
  const pointer = nextGesture.phase === 'completed'
    ? { ...nextGesture.pointer, y: nextGesture.pointer.y + rowDelta }
    : { ...nextGesture.pointer };
  return { ...nextGesture, anchor, ownsVisualSelection: true, pointer };
}

export function shouldCoordinateTerminalSelectionScroll(
  gesture: TerminalSelectionGesture | null,
): boolean {
  return gesture?.phase === 'active' && gesture.owner === 'terminal';
}

export function shouldReviewTerminalSelectionScroll(
  gesture: TerminalSelectionGesture | null,
): boolean {
  return gesture?.phase === 'completed' && gesture.owner === 'terminal';
}

export function isTerminalSelectionCopyEligible(
  gesture: TerminalSelectionGesture | null,
  hasVisibleSelection: boolean,
  hasVerifiedCompletedRange: boolean,
): boolean {
  if (gesture?.owner === 'application' || gesture?.phase === 'canceled') return false;
  if (hasVisibleSelection) return true;
  return hasVerifiedCompletedRange && gesture?.owner === 'terminal';
}

export function shouldInterceptTerminalSelectionCopy(
  gesture: TerminalSelectionGesture | null,
  hasCoordinatedRange: boolean,
): boolean {
  return hasCoordinatedRange
    && gesture?.owner === 'terminal';
}

function cloneSelectionPosition(
  selection: TerminalSelectionPosition | undefined,
): TerminalSelectionPosition | undefined {
  if (!selection) return undefined;
  return {
    end: { ...selection.end },
    start: { ...selection.start },
  };
}

export function isSameTerminalSelectionPosition(
  left: TerminalSelectionPosition,
  right: TerminalSelectionPosition | undefined,
): boolean {
  return !!right
    && left.start.x === right.start.x
    && left.start.y === right.start.y
    && left.end.x === right.end.x
    && left.end.y === right.end.y;
}
