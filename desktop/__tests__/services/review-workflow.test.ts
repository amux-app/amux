import type { AgentName, MuxBasePane } from 'muxbase/core';
import { existsSync, rmSync, writeFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneActivity, ReadinessToken } from '../../src/shared/pane-activity.js';

const reviewServices = vi.hoisted(() => ({
  collectSnapshotDiffData: vi.fn(),
  collectWorkingDiffData: vi.fn(),
  createReviewSnapshot: vi.fn(),
  extractReviewFindings: vi.fn(),
  hasReviewSnapshotChanged: vi.fn(),
  resolveBaseBranch: vi.fn(),
}));

const reviewLogger = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../src/main/services/git/gitDiff.js', () => ({
  collectSnapshotDiffData: reviewServices.collectSnapshotDiffData,
  collectWorkingDiffData: reviewServices.collectWorkingDiffData,
  createReviewSnapshot: reviewServices.createReviewSnapshot,
  hasReviewSnapshotChanged: reviewServices.hasReviewSnapshotChanged,
  resolveBaseBranch: reviewServices.resolveBaseBranch,
  sh: (value: string) => `'${value}'`,
}));

vi.mock('../../src/main/services/Logger.js', () => ({ log: reviewLogger }));

vi.mock('../../src/main/services/review/fixHandoff.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/services/review/fixHandoff.js')>(
    '../../src/main/services/review/fixHandoff.js',
  );
  return { ...actual, extractReviewFindings: reviewServices.extractReviewFindings };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    rmSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

import { ReviewWorkflow } from '../../src/main/services/bridge/ReviewWorkflow.js';

const readyActivity: PaneActivity = {
  activityRevision: 1,
  adapterHealth: 'healthy',
  certainty: 'confirmed',
  liveness: 'running',
  openBackgroundWork: [],
  origin: 'adapter',
  paneIncarnationId: 'incarnation-1',
  sinceWallMs: 1,
  state: 'idle',
};

const readinessToken: ReadinessToken = {
  activityRevision: 1,
  epochId: 'epoch-1',
  paneIncarnationId: 'incarnation-1',
  revision: 1,
};

function makeSource(overrides: Partial<MuxBasePane> = {}): MuxBasePane {
  return {
    agent: 'claude',
    id: 'source',
    paneId: '%1',
    projectRoot: '/project',
    prompt: 'Implement feature',
    slug: 'feature',
    worktreePath: '/project/.worktrees/feature',
    ...overrides,
  };
}

function makeReview(overrides: Partial<MuxBasePane> = {}): MuxBasePane {
  return {
    agent: 'claude',
    id: 'review',
    paneId: '%2',
    projectRoot: '/project',
    role: 'review',
    slug: 'review-feature',
    review: {
      changedFiles: 1,
      reviewId: 'review-id',
      sourcePaneId: 'source',
      sourceSlug: 'feature',
      sourceWorktreePath: '/project/.worktrees/feature',
      startedAt: 1,
    },
    ...overrides,
  };
}

function makeHarness(initialPanes: MuxBasePane[] = [makeSource()]) {
  let panes = initialPanes;
  const createPane = vi.fn(async () => ({ success: true, pane: makeReview() }));
  const sendPromptToPane = vi.fn(async () => undefined);
  const dependencies = {
    captureReadinessTokenFor: vi.fn(() => readinessToken),
    createPane,
    getAvailableAgents: vi.fn(() => ['claude', 'codex'] as AgentName[]),
    getPane: vi.fn((paneId: string) => panes.find((pane) => pane.id === paneId)),
    getPaneActivity: vi.fn(() => readyActivity),
    getPanes: vi.fn(() => panes),
    getProjectRoot: vi.fn(() => '/project'),
    getSession: vi.fn(() => null),
    replacePanesBestEffort: vi.fn((next: MuxBasePane[]) => { panes = next; }),
    revalidateReadinessOrReject: vi.fn((pane, _token, blockReason, notFoundReason) => {
      if (!pane) return { ok: false as const, reason: notFoundReason };
      const reason = blockReason(pane);
      return reason ? { ok: false as const, reason } : { ok: true as const, pane };
    }),
    sendPromptToPane,
    setProgress: vi.fn(),
  };
  return {
    createPane,
    dependencies,
    getPanes: () => panes,
    sendPromptToPane,
    workflow: new ReviewWorkflow(dependencies),
  };
}

describe('ReviewWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    reviewServices.createReviewSnapshot.mockResolvedValue({ sha: 'snapshot', skippedFiles: [] });
    reviewServices.hasReviewSnapshotChanged.mockResolvedValue(false);
    reviewServices.resolveBaseBranch.mockResolvedValue('main');
    reviewServices.collectSnapshotDiffData.mockResolvedValue({
      changedFiles: ['src/feature.ts'],
      deletions: 2,
      insertions: 10,
    });
  });

  it('launches a read-only review pane and releases its in-flight slot', async () => {
    const harness = makeHarness();

    await expect(harness.workflow.startReview('source', 'claude')).resolves.toMatchObject({
      success: true,
    });
    expect(harness.createPane).toHaveBeenCalledWith(
      'Review: feature',
      'claude',
      expect.objectContaining({ readOnly: true, role: 'review', worktreeStartPoint: 'snapshot' }),
    );
    await expect(harness.workflow.startReview('source', 'claude')).resolves.toMatchObject({
      success: true,
    });
  });

  it('persists the reviewed snapshot sha in the review metadata', async () => {
    const harness = makeHarness();

    await harness.workflow.startReview('source', 'claude');

    expect(harness.createPane).toHaveBeenCalledWith(
      'Review: feature',
      'claude',
      expect.objectContaining({ review: expect.objectContaining({ snapshotSha: 'snapshot' }) }),
    );
  });

  it('does not launch when readiness revalidation fails after snapshotting', async () => {
    const harness = makeHarness();
    harness.dependencies.revalidateReadinessOrReject.mockReturnValue({
      ok: false,
      reason: 'Pane was recreated while preparing the action',
    });

    await expect(harness.workflow.startReview('source')).resolves.toEqual({
      success: false,
      error: 'Pane was recreated while preparing the action',
    });
    expect(harness.createPane).not.toHaveBeenCalled();
  });

  it('rejects a concurrent review without releasing the active review slot', async () => {
    const harness = makeHarness();
    const inFlightReviews = new Set(['source']);
    const workflow = new ReviewWorkflow(harness.dependencies, inFlightReviews);

    await expect(workflow.startReview('source')).resolves.toEqual({
      success: false,
      error: 'A review is already launching for this pane',
    });
    expect(inFlightReviews.has('source')).toBe(true);
    expect(reviewServices.createReviewSnapshot).not.toHaveBeenCalled();
  });

  it('marks no-issues findings as handed off without sending a prompt', async () => {
    const harness = makeHarness([makeSource(), makeReview()]);
    reviewServices.extractReviewFindings.mockReturnValue({ kind: 'no-issues', text: 'NO_ISSUES_FOUND' });

    await expect(harness.workflow.startFixHandoff('review')).resolves.toMatchObject({
      success: true,
      noIssues: true,
      sourcePaneId: 'source',
    });
    expect(harness.sendPromptToPane).not.toHaveBeenCalled();
    expect(harness.getPanes().find((pane) => pane.id === 'review')?.review?.handedOffAt)
      .toEqual(expect.any(Number));
  });

  it('closes the source review guard after a clean handoff', async () => {
    const harness = makeHarness([makeSource(), makeReview()]);
    reviewServices.extractReviewFindings.mockReturnValue({ kind: 'no-issues', text: 'NO_ISSUES_FOUND' });

    await harness.workflow.startFixHandoff('review');

    expect(harness.getPanes().find((pane) => pane.id === 'review')?.review?.handedOffAt)
      .toEqual(expect.any(Number));
    expect(harness.getPanes().some((pane) => (
      pane.role === 'review'
      && pane.review?.sourcePaneId === 'source'
      && !pane.review.handedOffAt
    ))).toBe(false);
  });

  it('computes drift before readiness revalidation', async () => {
    const snapshotSha = '0123456789abcdef0123456789abcdef01234567';
    const harness = makeHarness([makeSource(), makeReview({ review: { ...makeReview().review!, snapshotSha } })]);
    const order: string[] = [];
    reviewServices.extractReviewFindings.mockReturnValue({ kind: 'findings', text: 'P1: bug' });
    reviewServices.hasReviewSnapshotChanged.mockImplementation(async () => {
      order.push('drift');
      return true;
    });
    harness.dependencies.revalidateReadinessOrReject.mockImplementation((pane, _token, blockReason, notFoundReason) => {
      order.push('revalidate');
      if (!pane) return { ok: false as const, reason: notFoundReason };
      const reason = blockReason(pane);
      return reason ? { ok: false as const, reason } : { ok: true as const, pane };
    });

    await expect(harness.workflow.startFixHandoff('review')).resolves.toMatchObject({ success: true });

    expect(order.indexOf('drift')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('drift')).toBeLessThan(order.indexOf('revalidate'));
  });

  it('returns drift for a clean handoff without sending a prompt', async () => {
    const snapshotSha = '0123456789abcdef0123456789abcdef01234567';
    const harness = makeHarness([makeSource(), makeReview({ review: { ...makeReview().review!, snapshotSha } })]);
    reviewServices.extractReviewFindings.mockReturnValue({ kind: 'no-issues', text: 'NO_ISSUES_FOUND' });
    reviewServices.hasReviewSnapshotChanged.mockResolvedValue(true);

    await expect(harness.workflow.startFixHandoff('review')).resolves.toEqual({
      snapshotDrift: 'changed',
      success: true,
      noIssues: true,
      sourcePaneId: 'source',
    });
    expect(harness.sendPromptToPane).not.toHaveBeenCalled();
  });

  it('maps a malformed in-memory snapshot sha to unknown without invoking Git drift detection', async () => {
    const harness = makeHarness([makeSource(), makeReview({
      review: { ...makeReview().review!, snapshotSha: 'not-a-git-object' },
    })]);
    reviewServices.extractReviewFindings.mockReturnValue({ kind: 'findings', text: 'P1: bug' });

    await expect(harness.workflow.startFixHandoff('review')).resolves.toMatchObject({
      snapshotDrift: 'unknown',
      success: true,
    });
    expect(reviewServices.hasReviewSnapshotChanged).not.toHaveBeenCalled();
  });

  it('logs separately when the review pane disappears after prompt delivery', async () => {
    const harness = makeHarness([makeSource(), makeReview()]);
    reviewServices.extractReviewFindings.mockReturnValue({ kind: 'findings', text: 'P1: bug' });
    harness.dependencies.getPanes
      .mockImplementationOnce(() => [makeSource(), makeReview()])
      .mockImplementationOnce(() => [makeSource(), makeReview()])
      .mockImplementationOnce(() => []);

    await expect(harness.workflow.startFixHandoff('review')).resolves.toMatchObject({ success: true });

    expect(reviewLogger.warn).toHaveBeenCalledWith(
      'bridge',
      'Review metadata update skipped: pane missing',
      { paneId: 'review' },
    );
  });

  it('logs separately when review metadata disappears from an existing pane', async () => {
    const harness = makeHarness([makeSource(), makeReview()]);
    reviewServices.extractReviewFindings.mockReturnValue({ kind: 'findings', text: 'P1: bug' });
    harness.dependencies.getPanes
      .mockImplementationOnce(() => [makeSource(), makeReview()])
      .mockImplementationOnce(() => [makeSource(), makeReview()])
      .mockImplementationOnce(() => [makeSource(), { ...makeReview(), review: undefined }]);

    await expect(harness.workflow.startFixHandoff('review')).resolves.toMatchObject({ success: true });

    expect(reviewLogger.warn).toHaveBeenCalledWith(
      'bridge',
      'Review metadata update skipped: review metadata absent',
      { paneId: 'review' },
    );
  });

  it('writes findings, delivers the prompt, then marks the review handed off', async () => {
    const harness = makeHarness([makeSource(), makeReview()]);
    reviewServices.extractReviewFindings.mockReturnValue({ kind: 'findings', text: 'P1: bug' });
    harness.sendPromptToPane.mockImplementation(async () => {
      expect(harness.getPanes().find((pane) => pane.id === 'review')?.review?.handedOffAt)
        .toBeUndefined();
    });

    await expect(harness.workflow.startFixHandoff('review')).resolves.toMatchObject({
      success: true,
      sourcePaneId: 'source',
    });
    expect(writeFileSync).toHaveBeenCalled();
    expect(harness.sendPromptToPane).toHaveBeenCalledOnce();
    expect(harness.getPanes().find((pane) => pane.id === 'review')?.review?.handedOffAt)
      .toEqual(expect.any(Number));
  });

  it('removes an unpublished findings file when prompt delivery fails', async () => {
    const harness = makeHarness([makeSource(), makeReview()]);
    reviewServices.extractReviewFindings.mockReturnValue({ kind: 'findings', text: 'P1: bug' });
    harness.sendPromptToPane.mockRejectedValue(new Error('tmux unavailable'));

    await expect(harness.workflow.startFixHandoff('review')).resolves.toMatchObject({
      success: false,
      error: 'tmux unavailable',
    });
    expect(rmSync).toHaveBeenCalledWith(expect.stringContaining('findings-'), { force: true });
    expect(harness.getPanes().find((pane) => pane.id === 'review')?.review?.handedOffAt)
      .toBeUndefined();
  });
});
