import type { AgentName, AumxPane } from 'aumx/core';
import { existsSync, rmSync, writeFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneActivity, ReadinessToken } from '../../src/shared/pane-activity.js';

const reviewServices = vi.hoisted(() => ({
  collectSnapshotDiffData: vi.fn(),
  collectWorkingDiffData: vi.fn(),
  createReviewSnapshot: vi.fn(),
  extractReviewFindings: vi.fn(),
  resolveBaseBranch: vi.fn(),
}));

vi.mock('../../src/main/services/git/gitDiff.js', () => ({
  collectSnapshotDiffData: reviewServices.collectSnapshotDiffData,
  collectWorkingDiffData: reviewServices.collectWorkingDiffData,
  createReviewSnapshot: reviewServices.createReviewSnapshot,
  resolveBaseBranch: reviewServices.resolveBaseBranch,
  sh: (value: string) => `'${value}'`,
}));

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

function makeSource(overrides: Partial<AumxPane> = {}): AumxPane {
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

function makeReview(overrides: Partial<AumxPane> = {}): AumxPane {
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

function makeHarness(initialPanes: AumxPane[] = [makeSource()]) {
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
    replacePanesBestEffort: vi.fn((next: AumxPane[]) => { panes = next; }),
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

    await expect(harness.workflow.startFixHandoff('review')).resolves.toEqual({
      success: true,
      noIssues: true,
      sourcePaneId: 'source',
    });
    expect(harness.sendPromptToPane).not.toHaveBeenCalled();
    expect(harness.getPanes().find((pane) => pane.id === 'review')?.review?.handedOffAt)
      .toEqual(expect.any(Number));
  });

  it('writes findings, delivers the prompt, then marks the review handed off', async () => {
    const harness = makeHarness([makeSource(), makeReview()]);
    reviewServices.extractReviewFindings.mockReturnValue({ kind: 'findings', text: 'P1: bug' });
    harness.sendPromptToPane.mockImplementation(async () => {
      expect(harness.getPanes().find((pane) => pane.id === 'review')?.review?.handedOffAt)
        .toBeUndefined();
    });

    await expect(harness.workflow.startFixHandoff('review')).resolves.toEqual({
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
