import { describe, expect, it } from 'vitest';
import { completeTerminalSelectionGesture, claimTerminalSelectionGesture, beginTerminalSelectionGesture } from '../../src/renderer/lib/terminal-selection-gesture';
import {
  captureRepaintObservation,
  isReviewHighlightTruthful,
  restoreActiveGestureFromObservation,
  restoreGestureFromObservation,
  shouldAcknowledgeRepaint,
} from '../../src/renderer/lib/terminal-selection-finalizer';

const gesture = completeTerminalSelectionGesture(
  claimTerminalSelectionGesture(
    beginTerminalSelectionGesture({ x: 2, y: 40 }),
    { end: { x: 10, y: 42 }, start: { x: 2, y: 40 } },
  ),
);

describe('terminal selection finalizer review mode', () => {
  it('tags observations with their step purpose', () => {
    const logical = captureRepaintObservation(gesture);
    const review = captureRepaintObservation(gesture, 'review');

    expect(logical.purpose).toBe('logical');
    expect(review.purpose).toBe('review');
  });

  it('accepts only an unambiguous visible slice of the frozen range', () => {
    const frozen = 'line-01\nline-02\nline-03\nline-04';

    expect(isReviewHighlightTruthful(true, 'line-02\nline-03', frozen)).toBe(true);
    expect(isReviewHighlightTruthful(true, 'line-02', 'line-02\nline-02')).toBe(false);
    expect(isReviewHighlightTruthful(true, 'unrelated', frozen)).toBe(false);
    expect(isReviewHighlightTruthful(true, '', frozen)).toBe(false);
    expect(isReviewHighlightTruthful(false, '', frozen)).toBe(true);
    expect(isReviewHighlightTruthful(false, 'line-02', frozen)).toBe(false);
  });

  it('acknowledges only a verified advancing frame', () => {
    expect(shouldAcknowledgeRepaint('advanced')).toBe(true);
    expect(shouldAcknowledgeRepaint('unchanged')).toBe(false);
    expect(shouldAcknowledgeRepaint('unverified')).toBe(false);
  });

  it('restores both endpoints from an observation without mutating it', () => {
    const observation = captureRepaintObservation(gesture, 'review');
    const moved = { ...gesture, anchor: { x: 0, y: 5 }, pointer: { x: 0, y: 7 } };

    const restored = restoreGestureFromObservation(moved, observation);

    expect(restored.anchor).toEqual(observation.preStepAnchor);
    expect(restored.pointer).toEqual(observation.preStepPointer);
    expect(restored.anchor).not.toBe(observation.preStepAnchor);
  });

  it('restores only the anchor of an active drag and preserves its latest pointer', () => {
    const observation = captureRepaintObservation(gesture);
    const moved = { ...gesture, anchor: { x: 0, y: 5 }, pointer: { x: 17, y: 99 } };

    const restored = restoreActiveGestureFromObservation(moved, observation);

    expect(restored.anchor).toEqual(observation.preStepAnchor);
    expect(restored.pointer).toEqual({ x: 17, y: 99 });
  });
});
