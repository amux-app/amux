import { describe, expect, it } from 'vitest';
import {
  advanceTerminalSelectionGesture,
  beginTerminalSelectionGesture,
  cancelTerminalSelectionGesture,
  claimTerminalSelectionGesture,
  completeTerminalSelectionGesture,
  isTerminalSelectionCopyEligible,
  markTerminalSelectionGestureApplicationOwned,
  shouldCoordinateTerminalSelectionScroll,
  shouldInterceptTerminalSelectionCopy,
  shouldReviewTerminalSelectionScroll,
} from '../../src/renderer/lib/terminal-selection-gesture';

const anchor = { x: 4, y: 8 };
const originalSelection = {
  end: { x: 12, y: 8 },
  start: { x: 2, y: 8 },
};
const currentSelection = {
  end: { x: 18, y: 9 },
  start: { x: 4, y: 8 },
};

describe('terminal selection gesture ownership', () => {
  it('does not let a selection that predates pointer down claim the gesture', () => {
    const pending = beginTerminalSelectionGesture(anchor, originalSelection);

    const unchanged = claimTerminalSelectionGesture(pending, originalSelection);

    expect(unchanged.owner).toBe('pending');
    expect(shouldCoordinateTerminalSelectionScroll(unchanged)).toBe(false);
  });

  it('locks terminal ownership when xterm reports a new selection', () => {
    const pending = beginTerminalSelectionGesture(anchor, originalSelection);

    const claimed = claimTerminalSelectionGesture(pending, currentSelection);
    const afterApplicationForwarding = markTerminalSelectionGestureApplicationOwned(claimed);

    expect(claimed.owner).toBe('terminal');
    expect(afterApplicationForwarding.owner).toBe('terminal');
    expect(shouldCoordinateTerminalSelectionScroll(afterApplicationForwarding)).toBe(true);
    expect(shouldInterceptTerminalSelectionCopy(afterApplicationForwarding, true)).toBe(true);
  });

  it('locks application ownership when input is forwarded before xterm claims it', () => {
    const pending = beginTerminalSelectionGesture(anchor);

    const applicationOwned = markTerminalSelectionGestureApplicationOwned(pending);
    const lateSelection = claimTerminalSelectionGesture(applicationOwned, currentSelection);

    expect(lateSelection.owner).toBe('application');
    expect(shouldCoordinateTerminalSelectionScroll(lateSelection)).toBe(false);
    expect(shouldInterceptTerminalSelectionCopy(lateSelection, true)).toBe(false);
  });

  it('keeps completed terminal ownership available for explicit copy arbitration', () => {
    const claimed = claimTerminalSelectionGesture(
      beginTerminalSelectionGesture(anchor),
      currentSelection,
    );

    const completed = completeTerminalSelectionGesture(claimed);

    expect(completed.phase).toBe('completed');
    expect(shouldCoordinateTerminalSelectionScroll(completed)).toBe(false);
    expect(shouldInterceptTerminalSelectionCopy(completed, true)).toBe(true);
  });

  it('moves both completed selection endpoints with viewport navigation', () => {
    const claimed = claimTerminalSelectionGesture(
      beginTerminalSelectionGesture(anchor),
      currentSelection,
    );
    const completed = completeTerminalSelectionGesture(claimed);

    const advanced = advanceTerminalSelectionGesture(
      completed,
      () => currentSelection,
      'up',
      3,
    );

    expect(advanced).toMatchObject({
      anchor: { x: currentSelection.end.x, y: currentSelection.end.y + 3 },
      pointer: { x: currentSelection.start.x, y: currentSelection.start.y + 3 },
    });
  });

  it('keeps an active drag pointer pinned while its anchor follows scrolling', () => {
    const claimed = claimTerminalSelectionGesture(
      beginTerminalSelectionGesture(anchor),
      currentSelection,
    );

    const advanced = advanceTerminalSelectionGesture(
      claimed,
      () => currentSelection,
      'down',
      2,
    );

    expect(advanced).toMatchObject({
      anchor: { x: currentSelection.start.x, y: currentSelection.start.y - 2 },
      pointer: currentSelection.end,
    });
  });

  it('fails closed after cancellation', () => {
    const claimed = claimTerminalSelectionGesture(
      beginTerminalSelectionGesture(anchor),
      currentSelection,
    );

    const canceled = cancelTerminalSelectionGesture(claimed);

    expect(canceled.phase).toBe('canceled');
    expect(shouldCoordinateTerminalSelectionScroll(canceled)).toBe(false);
    expect(shouldInterceptTerminalSelectionCopy(canceled, true)).toBe(true);
  });

  it('does not mutate the input gesture anchor or pointer on active-phase advancement', () => {
    const claimed = claimTerminalSelectionGesture(
      beginTerminalSelectionGesture(anchor),
      currentSelection,
    );
    const firstAdvanced = advanceTerminalSelectionGesture(
      claimed, () => currentSelection, 'down', 1,
    );
    expect(firstAdvanced?.ownsVisualSelection).toBe(true);
    const savedAnchorY = firstAdvanced!.anchor.y;
    const savedPointerY = firstAdvanced!.pointer.y;

    const secondAdvanced = advanceTerminalSelectionGesture(
      firstAdvanced!, () => currentSelection, 'down', 2,
    );

    expect(firstAdvanced!.anchor.y).toBe(savedAnchorY);
    expect(firstAdvanced!.pointer.y).toBe(savedPointerY);
    expect(firstAdvanced!.ownsVisualSelection).toBe(true);
    expect(secondAdvanced?.anchor.y).toBe(savedAnchorY - 2);
    expect(secondAdvanced?.pointer.y).toBe(savedPointerY);
    expect(secondAdvanced?.ownsVisualSelection).toBe(true);
  });

  it('does not mutate the input gesture anchor or pointer on completed-phase advancement', () => {
    const completed = completeTerminalSelectionGesture(
      claimTerminalSelectionGesture(beginTerminalSelectionGesture(anchor), currentSelection),
    );
    const firstAdvanced = advanceTerminalSelectionGesture(
      completed, () => currentSelection, 'up', 1,
    );
    expect(firstAdvanced?.ownsVisualSelection).toBe(true);
    const savedAnchorY = firstAdvanced!.anchor.y;
    const savedPointerY = firstAdvanced!.pointer.y;

    const secondAdvanced = advanceTerminalSelectionGesture(
      firstAdvanced!, () => currentSelection, 'up', 2,
    );

    expect(firstAdvanced!.anchor.y).toBe(savedAnchorY);
    expect(firstAdvanced!.pointer.y).toBe(savedPointerY);
    expect(secondAdvanced?.anchor.y).toBe(savedAnchorY + 2);
    expect(secondAdvanced?.pointer.y).toBe(savedPointerY + 2);
    expect(secondAdvanced?.ownsVisualSelection).toBe(true);
  });

  it('reviews a completed terminal-owned range but not an active or application one', () => {
    const active = claimTerminalSelectionGesture(
      beginTerminalSelectionGesture(anchor),
      currentSelection,
    );
    const completed = completeTerminalSelectionGesture(active);
    const applicationCompleted = completeTerminalSelectionGesture(
      markTerminalSelectionGestureApplicationOwned(beginTerminalSelectionGesture(anchor)),
    );

    expect(shouldReviewTerminalSelectionScroll(active)).toBe(false);
    expect(shouldReviewTerminalSelectionScroll(completed)).toBe(true);
    expect(shouldReviewTerminalSelectionScroll(applicationCompleted)).toBe(false);
    expect(shouldReviewTerminalSelectionScroll(null)).toBe(false);
  });

  it('makes offscreen completed terminal ranges copy-eligible only when verified', () => {
    const completed = completeTerminalSelectionGesture(
      claimTerminalSelectionGesture(beginTerminalSelectionGesture(anchor), currentSelection),
    );
    const applicationCompleted = completeTerminalSelectionGesture(
      markTerminalSelectionGestureApplicationOwned(beginTerminalSelectionGesture(anchor)),
    );

    expect(isTerminalSelectionCopyEligible(completed, true, false)).toBe(true);
    expect(isTerminalSelectionCopyEligible(completed, false, true)).toBe(true);
    expect(isTerminalSelectionCopyEligible(completed, false, false)).toBe(false);
    expect(isTerminalSelectionCopyEligible(applicationCompleted, false, true)).toBe(false);
    expect(isTerminalSelectionCopyEligible(null, false, true)).toBe(false);
  });

  it('never exposes Copy for application-owned or canceled gestures', () => {
    const applicationOwned = markTerminalSelectionGestureApplicationOwned(
      beginTerminalSelectionGesture(anchor),
    );
    const canceled = cancelTerminalSelectionGesture(
      claimTerminalSelectionGesture(beginTerminalSelectionGesture(anchor), currentSelection),
    );

    expect(isTerminalSelectionCopyEligible(applicationOwned, true, true)).toBe(false);
    expect(isTerminalSelectionCopyEligible(canceled, true, true)).toBe(false);
    expect(isTerminalSelectionCopyEligible(null, true, false)).toBe(true);
  });
});
