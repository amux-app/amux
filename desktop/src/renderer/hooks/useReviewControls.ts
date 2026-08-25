import type { MuxBasePane } from 'muxbase/core';
import type { PaneActivityState } from '../../shared/pane-activity';
import { useEffect } from 'react';
import { isReadyForMutation } from '../../shared/pane-activity';
import * as gitApi from '../api/git.api';
import { isReviewAgentEnabled } from '../lib/feature-flags';
import { useElectronSettingsStore } from '../stores/electron-settings.store';
import { usePaneStore } from '../stores/pane.store';
import { usePaneActivityStore } from '../stores/pane-activity.store';
import { useReviewLaunchStore } from '../stores/review-launch.store';
import { useDirtyMapStore } from '../stores/worktree-dirty.store';

interface ReviewControls {
  canReview: boolean;
  canSendFixes: boolean;
  isReviewLaunching: boolean;
  isReviewSourceMissing: boolean;
  openReviewPaneId?: string;
  reviewSourcePaneId?: string;
  scope: ReviewScope;
  showHandedOffPill: boolean;
}

export type ReviewScope = 'worktree' | 'uncommitted';

export function useReviewControls(pane: MuxBasePane, _status: PaneActivityState): ReviewControls {
  const reviewAgentEnabled = useElectronSettingsStore((s) => isReviewAgentEnabled(s.settings));
  const isReviewPane = pane.role === 'review';
  const activity = usePaneActivityStore((s) => s.activityByPaneId[pane.id]);
  const isIdleStatus = activity ? isReadyForMutation(activity) : false;
  const hasWorktree = !!pane.worktreePath;
  const reviewRoot = pane.worktreePath ?? pane.projectRoot;
  const reviewBase = !isReviewPane && !!pane.agent && pane.agent !== 'pi' && isIdleStatus;
  const isDirty = useDirtyMapStore((s) => s.dirtyMap[pane.id]);
  const setDirty = useDirtyMapStore((s) => s.setDirty);
  const isReviewLaunching = useReviewLaunchStore((s) => s.launchingIds.has(pane.id));
  const panes = usePaneStore((s) => s.panes);
  const openReviewPaneId = !isReviewPane
    ? panes.find((candidate) => (
      candidate.role === 'review'
      && candidate.review?.sourcePaneId === pane.id
      && !candidate.review.handedOffAt
    ))?.id
    : undefined;
  const reviewSourcePane = isReviewPane && pane.review
    ? panes.find((candidate) => candidate.id === pane.review?.sourcePaneId)
      ?? panes.find((candidate) => (
        !!pane.review?.sourceWorktreePath
        && candidate.worktreePath === pane.review.sourceWorktreePath
      ))
    : undefined;

  useEffect(() => {
    if (!reviewBase || hasWorktree || !reviewRoot) return;
    let cancelled = false;
    gitApi.getStatus({ worktreePath: reviewRoot })
      .then((r) => { if (!cancelled) setDirty(pane.id, r.hasChanges === true); })
      .catch(() => { if (!cancelled) setDirty(pane.id, false); });
    return () => { cancelled = true; };
  }, [reviewBase, hasWorktree, reviewRoot, pane.id, setDirty]);

  return {
    canReview: reviewAgentEnabled && reviewBase && !openReviewPaneId && (hasWorktree || isDirty === true),
    canSendFixes: reviewAgentEnabled && isReviewPane && !!pane.review && isIdleStatus && !pane.review.handedOffAt,
    isReviewLaunching,
    isReviewSourceMissing: isReviewPane && !!pane.review && !reviewSourcePane,
    openReviewPaneId,
    reviewSourcePaneId: reviewSourcePane?.id,
    scope: hasWorktree ? 'worktree' : 'uncommitted',
    showHandedOffPill: reviewAgentEnabled && isReviewPane && !!pane.review?.handedOffAt,
  };
}
