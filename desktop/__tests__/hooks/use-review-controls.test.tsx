// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import type { MuxBasePane } from 'muxbase/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useReviewControls } from '../../src/renderer/hooks/useReviewControls';
import { useDirtyMapStore } from '../../src/renderer/stores/worktree-dirty.store';
import { useElectronSettingsStore } from '../../src/renderer/stores/electron-settings.store';
import { usePaneStore } from '../../src/renderer/stores/pane.store';
import { usePaneActivityStore } from '../../src/renderer/stores/pane-activity.store';

const gitApi = vi.hoisted(() => ({
  getStatus: vi.fn(),
}));

vi.mock('../../src/renderer/api/git.api', () => gitApi);

function makePane(overrides: Partial<MuxBasePane> = {}): MuxBasePane {
  return {
    agent: 'codex',
    id: 'pane-1',
    paneId: '%1',
    prompt: 'build feature',
    slug: 'feature',
    worktreePath: '/tmp/project/.muxbase/worktrees/feature',
    ...overrides,
  };
}

describe('useReviewControls', () => {
beforeEach(() => {
    vi.clearAllMocks();
    useDirtyMapStore.getState().clear();
    usePaneStore.setState({ panes: [] });
    usePaneActivityStore.setState({ activityByPaneId: {
      'pane-1': readyActivity('pane-1'),
      'source-pane': readyActivity('source-pane'),
      'review-pane': readyActivity('review-pane'),
    } });
    useElectronSettingsStore.setState({
      isLoading: false,
      settings: { enableReviewAgent: true } as ReturnType<typeof useElectronSettingsStore.getState>['settings'],
    });
  });

  it('allows reviewing an idle agent pane that already has a worktree', () => {
    const { result } = renderHook(() => useReviewControls(makePane(), 'idle'));

    expect(result.current.canReview).toBe(true);
    expect(result.current.canSendFixes).toBe(false);
    expect(gitApi.getStatus).not.toHaveBeenCalled();
  });

  it('checks dirty state for an idle agent pane without a worktree', async () => {
    gitApi.getStatus.mockResolvedValue({ hasChanges: true });
    const pane = makePane({ projectRoot: '/tmp/project', worktreePath: undefined });

    const { result } = renderHook(() => useReviewControls(pane, 'idle'));

    expect(result.current.canReview).toBe(false);
    await waitFor(() => expect(result.current.canReview).toBe(true));
    expect(gitApi.getStatus).toHaveBeenCalledWith({ worktreePath: '/tmp/project' });
  });

  it('does not offer review or inspect dirty state for Pi panes', () => {
    const pane = makePane({
      agent: 'pi',
      projectRoot: '/tmp/project',
      worktreePath: undefined,
    });

    const { result } = renderHook(() => useReviewControls(pane, 'idle'));

    expect(result.current.canReview).toBe(false);
    expect(gitApi.getStatus).not.toHaveBeenCalled();
  });

  it('allows sending fixes only for idle unhanded review panes', () => {
    const reviewPane = makePane({
      role: 'review',
      review: {
        changedFiles: 1,
        reviewId: 'review-1',
        sourcePaneId: 'source-pane',
        sourceSlug: 'feature',
        startedAt: Date.now(),
      },
    });

    const { result, rerender } = renderHook(
      ({ pane, status }) => useReviewControls(pane, status),
      { initialProps: { pane: reviewPane, status: 'idle' as const } },
    );

    expect(result.current.canReview).toBe(false);
    expect(result.current.canSendFixes).toBe(true);
    expect(result.current.showHandedOffPill).toBe(false);

    act(() => {
      rerender({
        pane: { ...reviewPane, review: { ...reviewPane.review!, handedOffAt: Date.now() } },
        status: 'idle',
      });
    });

    expect(result.current.canSendFixes).toBe(false);
    expect(result.current.showHandedOffPill).toBe(true);
  });

  it('replaces a second review action with navigation to the open review pane', () => {
    const sourcePane = makePane({ id: 'source-pane' });
    const reviewPane = makePane({
      id: 'review-pane',
      role: 'review',
      review: {
        changedFiles: 1,
        reviewId: 'review-1',
        sourcePaneId: sourcePane.id,
        sourceSlug: sourcePane.slug,
        startedAt: Date.now(),
      },
    });
    usePaneStore.setState({ panes: [sourcePane, reviewPane] });

    const { result } = renderHook(() => useReviewControls(sourcePane, 'idle'));

    expect(result.current.canReview).toBe(false);
    expect(result.current.openReviewPaneId).toBe('review-pane');
  });

  it('resolves the original pane for review-to-source navigation and reports a missing source', () => {
    const sourcePane = makePane({ id: 'source-pane' });
    const reviewPane = makePane({
      id: 'review-pane',
      role: 'review',
      review: {
        changedFiles: 1,
        reviewId: 'review-1',
        sourcePaneId: sourcePane.id,
        sourceSlug: sourcePane.slug,
        startedAt: Date.now(),
      },
    });
    usePaneStore.setState({ panes: [sourcePane, reviewPane] });
    const { result, rerender } = renderHook(({ pane }) => useReviewControls(pane, 'idle'), {
      initialProps: { pane: reviewPane },
    });

    expect(result.current.reviewSourcePaneId).toBe('source-pane');
    expect(result.current.isReviewSourceMissing).toBe(false);

    act(() => usePaneStore.setState({ panes: [reviewPane] }));
    rerender({ pane: reviewPane });

    expect(result.current.reviewSourcePaneId).toBeUndefined();
    expect(result.current.isReviewSourceMissing).toBe(true);
  });
});

function readyActivity(paneId: string) {
  return {
    activityRevision: 1,
    adapterHealth: 'healthy' as const,
    certainty: 'confirmed' as const,
    liveness: 'running' as const,
    openBackgroundWork: [],
    origin: 'adapter' as const,
    paneIncarnationId: `${paneId}-incarnation`,
    sinceWallMs: Date.now(),
    state: 'idle' as const,
  };
}
