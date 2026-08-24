import type { AumxPane, ReviewMetadata } from 'aumx/core';
import { describe, expect, it } from 'vitest';
import { makeActivity } from '../helpers/pane-activity-fixtures';
import {
  getFixHandoffSourceBlockReason,
  getReviewPaneHandoffBlockReason,
  getReviewSourceBlockReason,
  hasOpenReviewForSource,
  resolveReviewSourcePane,
} from '../../src/main/services/review/reviewPaneGuards';

function makePane(overrides: Partial<AumxPane> = {}): AumxPane {
  return {
    agent: 'claude',
    agentStatus: 'idle',
    id: 'source-pane',
    paneId: '%1',
    prompt: 'implement feature',
    slug: 'feature-pane',
    worktreePath: '/repo/.aumx/worktrees/feature-pane',
    ...overrides,
  };
}

function makeReview(overrides: Partial<ReviewMetadata> = {}): ReviewMetadata {
  return {
    changedFiles: 2,
    reviewId: 'review-1',
    sourcePaneId: 'source-pane',
    sourceSlug: 'feature-pane',
    startedAt: 123,
    ...overrides,
  };
}

describe('reviewPaneGuards', () => {
  it('blocks source panes that cannot be safely reviewed', () => {
    // Arrange
    const reviewPane = makePane({ role: 'review' });
    const shellPane = makePane({ agent: undefined, type: 'shell' });
    const workingPane = makePane({ agentStatus: 'working' });
    const waitingPane = makePane({ agentStatus: 'waiting' });

    // Act / Assert
    expect(getReviewSourceBlockReason(reviewPane)).toBe('Review panes cannot be reviewed again');
    expect(getReviewSourceBlockReason(shellPane)).toBe('Only agent panes can be reviewed');
    expect(getReviewSourceBlockReason(workingPane)).toBe('Wait until the source pane is idle before starting review');
    expect(getReviewSourceBlockReason(waitingPane)).toBe('Wait until the source pane is idle before starting review');
    expect(getReviewSourceBlockReason(makePane(), makeActivity())).toBeUndefined();
  });

  it('requires an idle agent pane before injecting reviewer findings', () => {
    // Arrange
    const shellPane = makePane({ agent: undefined, type: 'shell' });
    const waitingPane = makePane({ agentStatus: 'waiting' });
    const unknownStatusPane = makePane({ agentStatus: undefined });

    // Act / Assert
    expect(getFixHandoffSourceBlockReason(shellPane)).toBe('The original pane is not an agent pane');
    expect(getFixHandoffSourceBlockReason(waitingPane)).toBe('Wait until the original pane is idle before sending findings');
    expect(getFixHandoffSourceBlockReason(unknownStatusPane)).toBe('Wait until the original pane is idle before sending findings');
    expect(getFixHandoffSourceBlockReason(makePane(), makeActivity())).toBeUndefined();
  });

  it('blocks handoff while the reviewer is still working', () => {
    // Arrange
    const analyzingReviewPane = makePane({ agentStatus: 'analyzing', role: 'review' });
    const waitingReviewPane = makePane({ agentStatus: 'waiting', role: 'review' });

    // Act / Assert
    expect(getReviewPaneHandoffBlockReason(analyzingReviewPane)).toBe('Wait until the review pane is idle before sending findings');
    expect(getReviewPaneHandoffBlockReason(waitingReviewPane)).toBe('Wait until the review pane is idle before sending findings');
    expect(getReviewPaneHandoffBlockReason(makePane({ role: 'review' }), makeActivity())).toBeUndefined();
  });

  it('detects an already-open review for a source, but allows relaunch after handoff', () => {
    // Arrange
    const source = makePane({ id: 'source-pane', role: undefined });
    const openReview = makePane({ id: 'rev-open', role: 'review', review: makeReview() });
    const handedOffReview = makePane({ id: 'rev-done', role: 'review', review: makeReview({ handedOffAt: 999 }) });

    // Act / Assert
    expect(hasOpenReviewForSource('source-pane', [source, openReview])).toBe(true);
    expect(hasOpenReviewForSource('source-pane', [source, handedOffReview])).toBe(false);
    expect(hasOpenReviewForSource('source-pane', [source])).toBe(false);
  });

  it('resolves the source pane by id first, then by durable worktree path', () => {
    // Arrange
    const sourceById = makePane({ id: 'source-pane', worktreePath: '/repo/worktrees/current' });
    const reopenedSource = makePane({ id: 'reopened-pane', worktreePath: '/repo/worktrees/original' });
    const review = makeReview({ sourceWorktreePath: '/repo/worktrees/original' });

    // Act / Assert
    expect(resolveReviewSourcePane(review, [sourceById, reopenedSource])).toBe(sourceById);
    expect(resolveReviewSourcePane(review, [reopenedSource])?.id).toBe('reopened-pane');
    expect(resolveReviewSourcePane(makeReview({ sourcePaneId: 'missing' }), [reopenedSource])).toBeUndefined();
  });
});
