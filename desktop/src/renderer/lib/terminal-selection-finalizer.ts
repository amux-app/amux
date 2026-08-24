import type { TerminalSelectionCell, TerminalSelectionGesture } from './terminal-selection-gesture';

export type SelectionStepPurpose = 'logical' | 'review';
export type SelectionMergeResult = 'advanced' | 'unchanged' | 'unverified';

export interface SelectionRepaintObservation {
  preStepAnchor: TerminalSelectionCell;
  preStepPointer: TerminalSelectionCell;
  purpose: SelectionStepPurpose;
  rangeVerifiedBeforeStep: boolean;
  sawUnverifiedFrame: boolean;
}

export function captureRepaintObservation(
  gesture: TerminalSelectionGesture,
  purpose: SelectionStepPurpose = 'logical',
  rangeVerifiedBeforeStep: boolean = false,
): SelectionRepaintObservation {
  return {
    preStepAnchor: { ...gesture.anchor },
    preStepPointer: { ...gesture.pointer },
    purpose,
    rangeVerifiedBeforeStep,
    sawUnverifiedFrame: false,
  };
}

export function shouldAcknowledgeRepaint(mergeResult: SelectionMergeResult): boolean {
  return mergeResult === 'advanced';
}

export function isReviewHighlightTruthful(
  expectedOnscreen: boolean,
  visibleSelection: string,
  frozenSelection: string,
): boolean {
  if (!expectedOnscreen) return visibleSelection.length === 0;
  if (!visibleSelection) return false;

  const firstMatch = frozenSelection.indexOf(visibleSelection);
  return firstMatch >= 0 && firstMatch === frozenSelection.lastIndexOf(visibleSelection);
}

export function restoreGestureFromObservation(
  gesture: TerminalSelectionGesture,
  observation: SelectionRepaintObservation,
): TerminalSelectionGesture {
  return {
    ...gesture,
    anchor: { ...observation.preStepAnchor },
    pointer: { ...observation.preStepPointer },
  };
}

export function restoreActiveGestureFromObservation(
  gesture: TerminalSelectionGesture,
  observation: SelectionRepaintObservation,
): TerminalSelectionGesture {
  return {
    ...gesture,
    anchor: { ...observation.preStepAnchor },
    pointer: { ...gesture.pointer },
  };
}
