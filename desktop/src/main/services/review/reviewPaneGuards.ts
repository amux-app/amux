import type { MuxBasePane, ReviewMetadata } from 'muxbase/core';
import { resolve } from 'path';
import { isReadyForMutation, type PaneActivity } from '../../../shared/pane-activity.js';

const FIX_HANDOFF_SOURCE_BUSY_MESSAGE = 'Wait until the original pane is idle before sending findings';
const REVIEW_PANE_BUSY_MESSAGE = 'Wait until the review pane is idle before sending findings';
const REVIEW_SOURCE_BUSY_MESSAGE = 'Wait until the source pane is idle before starting review';

export function getFixHandoffSourceCapabilityBlockReason(pane: MuxBasePane): string | undefined {
  if (pane.type === 'shell' || !pane.agent) {
    return 'The original pane is not an agent pane';
  }

  return undefined;
}

export function getReviewSourceCapabilityBlockReason(pane: MuxBasePane): string | undefined {
  if (pane.role === 'review') {
    return 'Review panes cannot be reviewed again';
  }

  if (pane.type === 'shell' || !pane.agent) {
    return 'Only agent panes can be reviewed';
  }

  return undefined;
}

export function getFixHandoffSourceBlockReason(pane: MuxBasePane, activity?: PaneActivity): string | undefined {
  const capabilityBlockReason = getFixHandoffSourceCapabilityBlockReason(pane);
  if (capabilityBlockReason) return capabilityBlockReason;

  if (!activity || !isReadyForMutation(activity)) {
    return FIX_HANDOFF_SOURCE_BUSY_MESSAGE;
  }

  return undefined;
}

export function getReviewPaneHandoffBlockReason(pane: MuxBasePane, activity?: PaneActivity): string | undefined {
  if (!activity || !isReadyForMutation(activity)) {
    return REVIEW_PANE_BUSY_MESSAGE;
  }

  return undefined;
}

export function getReviewSourceBlockReason(pane: MuxBasePane, activity?: PaneActivity): string | undefined {
  const capabilityBlockReason = getReviewSourceCapabilityBlockReason(pane);
  if (capabilityBlockReason) return capabilityBlockReason;

  if (!activity || !isReadyForMutation(activity)) {
    return REVIEW_SOURCE_BUSY_MESSAGE;
  }

  return undefined;
}

export function hasOpenReviewForSource(sourcePaneId: string, panes: MuxBasePane[]): boolean {
  return panes.some(
    (pane) => pane.role === 'review' && pane.review?.sourcePaneId === sourcePaneId && !pane.review.handedOffAt,
  );
}

export function resolveReviewSourcePane(review: ReviewMetadata, panes: MuxBasePane[]): MuxBasePane | undefined {
  const sourceById = panes.find((pane) => pane.id === review.sourcePaneId);
  if (sourceById) return sourceById;

  const sourceWorktreePath = normalizePath(review.sourceWorktreePath);
  if (!sourceWorktreePath) return undefined;

  return panes.find((pane) => normalizePath(pane.worktreePath) === sourceWorktreePath);
}

function normalizePath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? resolve(trimmed) : undefined;
}
