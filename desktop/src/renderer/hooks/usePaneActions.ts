import { useCallback } from 'react';
import type { AgentName, MuxBasePane } from 'muxbase/core';
import { usePaneStore, useNotificationStore, useUiStore } from '../stores';
import { useReviewLaunchStore } from '../stores/review-launch.store';
import { useConflictResolutionStore } from '../stores/conflict-resolution.store';
import * as paneApi from '../api/pane.api';
import type { PaneCreateRequest, SerializableActionResult } from '../../shared/ipc-types';

// Module-level: shared across all usePaneActions() instances so concurrent calls
// from ReviewLaunchButton, the kebab menu, and FocusHeader are all de-duped.
const inFlightReviewPaneIds = new Set<string>();

const MERGE_CONFLICTS_TITLE = 'Merge Conflicts Detected';

const AUTO_MERGE_CONFIRM_TITLES = new Set([
  'Merge Worktree',
  'Multi-Repository Merge',
  'Multi-Merge Complete',
]);

interface HumanizedError {
  title: string;
  detail: string;
}

const ERROR_PATTERNS: Array<{ pattern: RegExp; title: string; detail: string }> = [
  {
    pattern: /does not have a commit checked out/i,
    title: 'Worktree not initialized',
    detail: 'The project had no commits when this worktree was created. Close this pane and create a new one.',
  },
  {
    pattern: /not a git repository/i,
    title: 'Not a git repository',
    detail: 'The worktree directory is missing or corrupted.',
  },
  {
    pattern: /merge conflict|CONFLICT/,
    title: 'Merge conflicts',
    detail: 'Files have conflicting changes that need manual resolution.',
  },
  {
    pattern: /nothing to commit|No new commits/i,
    title: 'Nothing to merge',
    detail: 'The worktree has no new changes to merge into main.',
  },
];

const COMMAND_FAILED_PREFIX = /^Command failed:\s*/;

function humanizeMergeError(raw: string): HumanizedError {
  for (const { pattern, title, detail } of ERROR_PATTERNS) {
    if (pattern.test(raw)) {
      return { title, detail };
    }
  }

  const cleaned = raw.replace(COMMAND_FAILED_PREFIX, '').trim();
  return {
    title: 'Merge failed',
    detail: cleaned.length > 120 ? `${cleaned.slice(0, 117)}...` : cleaned,
  };
}

function getDefaultChoiceId(result: SerializableActionResult): string | null {
  if (!result.options || result.options.length === 0) return null;
  return result.options.find((opt) => opt.default)?.id ?? result.options[0]?.id ?? null;
}

async function resolveMergeActionFlow(result: SerializableActionResult): Promise<SerializableActionResult> {
  let current = result;

  for (let i = 0; i < 10; i++) {
    if (
      current.type === 'confirm'
      && current.callbackId
      && current.title
      && AUTO_MERGE_CONFIRM_TITLES.has(current.title)
    ) {
      current = await paneApi.executeCallback({ callbackId: current.callbackId });
      continue;
    }

    if (
      current.type === 'choice'
      && current.callbackId
      && (current.title === 'Close Pane' || current.title === 'Worktree Has Uncommitted Changes' || current.title === 'Main Branch Has Uncommitted Changes')
    ) {
      const choiceId = getDefaultChoiceId(current);
      if (!choiceId) return current;
      current = await paneApi.executeCallback({ callbackId: current.callbackId, value: choiceId });
      continue;
    }

    return current;
  }

  return {
    type: 'error',
    message: 'Merge flow exceeded maximum follow-up steps',
  };
}

function getActionToastSeverity(
  result: SerializableActionResult,
): 'success' | 'error' | 'warning' | 'info' {
  if (result.type === 'error') return 'error';
  if (result.type === 'confirm' || result.type === 'choice' || result.type === 'input') return 'warning';
  if (result.type === 'info') return 'info';
  return 'success';
}

export async function jumpToPaneRecord(pane: MuxBasePane): Promise<void> {
  try {
    await paneApi.jumpToPane({ paneId: pane.id });
  } catch (err) {
    useNotificationStore.getState().addToast(`Failed to jump: ${(err as Error).message}`, 'error');
  }
}

// Entry point for callers that only hold a tmux pane id (menus, shortcuts).
async function jumpToTmuxPane(tmuxPaneId: string): Promise<void> {
  const pane = usePaneStore.getState().panes.find((candidate) => candidate.paneId === tmuxPaneId);
  if (!pane) {
    useNotificationStore.getState().addToast('Failed to jump: that pane is no longer open', 'error');
    return;
  }
  await jumpToPaneRecord(pane);
}

export function usePaneActions() {
  const selectPane = usePaneStore((s) => s.selectPane);
  const setPendingPane = usePaneStore((s) => s.setPendingPane);
  const addToast = useNotificationStore((s) => s.addToast);
  const focusPane = useUiStore((s) => s.focusPane);
  const viewMode = useUiStore((s) => s.viewMode);
  const setLaunching = useReviewLaunchStore((s) => s.setLaunching);

  const navigateReviewFlow = useCallback((paneId: string) => {
    selectPane(paneId);
    if (viewMode === 'focus') focusPane(paneId);
  }, [focusPane, selectPane, viewMode]);

  const closePane = useCallback(
    async (paneId: string): Promise<boolean> => {
      try {
        let result = await paneApi.closePane({ paneId });

        if (result.type === 'choice' && result.callbackId) {
          const choiceId = getDefaultChoiceId(result);
          if (choiceId) {
            result = await paneApi.executeCallback({ callbackId: result.callbackId, value: choiceId });
          }
        }

        addToast(result.message, getActionToastSeverity(result));
        return result.type === 'success';
      } catch (err) {
        addToast(`Failed to close pane: ${(err as Error).message}`, 'error');
        return false;
      }
    },
    [addToast],
  );

  const declareDuelWinner = useCallback(
    async (winnerPane: MuxBasePane) => {
      try {
        const result = await paneApi.resolveDuel({ winnerPaneId: winnerPane.id });
        if (!result.success) {
          addToast(result.error || 'Failed to resolve duel', 'error');
          return;
        }
        useUiStore.getState().focusPane(winnerPane.id);
      } catch (err) {
        addToast(`Failed to resolve duel: ${(err as Error).message}`, 'error');
      }
    },
    [addToast],
  );

  const mergePane = useCallback(
    async (paneId: string) => {
      try {
        const initialResult = await paneApi.mergePane({ paneId });
        const result = await resolveMergeActionFlow(initialResult);

        if (result.type === 'choice' && result.title === MERGE_CONFLICTS_TITLE) {
          useConflictResolutionStore.getState().openConflictResolution(paneId, result);
          useUiStore.getState().openConflictView();
          return;
        }

        if (result.type === 'error') {
          const { title, detail } = humanizeMergeError(result.message);
          addToast(result.message, 'error', { title, detail });
          return;
        }

        addToast(result.message, getActionToastSeverity(result));
        if (result.type === 'confirm' || result.type === 'choice' || result.type === 'input') {
          addToast(
            `${result.title ?? 'This merge'} needs a decision that isn't available here yet — open the pane's terminal to continue it manually.`,
            'warning',
          );
        }
      } catch (err) {
        const raw = (err as Error).message;
        const { title, detail } = humanizeMergeError(raw);
        addToast(raw, 'error', { title, detail });
      }
    },
    [addToast],
  );

  const renamePane = useCallback(
    async (paneId: string, newName: string) => {
      try {
        const result = await paneApi.renamePane({ paneId, newName });
        addToast(result.message, result.type === 'error' ? 'error' : 'success');
      } catch (err) {
        addToast(`Failed to rename: ${(err as Error).message}`, 'error');
      }
    },
    [addToast],
  );

  const createWorktree = useCallback(
    async (paneId: string) => {
      try {
        const result = await paneApi.createWorktree({ paneId });
        if (!result.success) {
          addToast(result.error || 'Failed to create worktree', 'error');
        }
        return result;
      } catch (err) {
        addToast(`Failed to create worktree: ${(err as Error).message}`, 'error');
        return null;
      }
    },
    [addToast],
  );

  const duplicatePane = useCallback(
    async (paneId: string) => {
      try {
        const response = await paneApi.duplicatePane({ paneId });
        if (response.success && response.pane) {
          selectPane(response.pane.id);
          addToast(`Pane duplicated as "${response.pane.slug}"`, 'success');
        } else if (response.error) {
          addToast(response.error, 'error');
        }
        return response;
      } catch (err) {
        addToast(`Failed to duplicate pane: ${(err as Error).message}`, 'error');
        return null;
      }
    },
    [selectPane, addToast],
  );

  const startReview = useCallback(
    async (paneId: string, agent?: AgentName) => {
      if (inFlightReviewPaneIds.has(paneId)) return null;
      inFlightReviewPaneIds.add(paneId);
      setLaunching(paneId, true);
      try {
        const response = await paneApi.startReview({ paneId, agent });
        if (response.success && response.pane) {
          navigateReviewFlow(response.pane.id);
          addToast(`Review started in "${response.pane.slug}"`, 'success');
        } else if (response.error) {
          addToast(response.error, 'error');
        }
        return response;
      } catch (err) {
        addToast(`Failed to start review: ${(err as Error).message}`, 'error');
        return null;
      } finally {
        inFlightReviewPaneIds.delete(paneId);
        setLaunching(paneId, false);
      }
    },
    [navigateReviewFlow, addToast, setLaunching],
  );

  const sendFixesToAuthor = useCallback(
    async (reviewPaneId: string) => {
      try {
        const response = await paneApi.sendFix({ reviewPaneId });
        if (response.success && response.noIssues) {
          if (response.sourcePaneId) navigateReviewFlow(response.sourcePaneId);
          addToast('Reviewer found no issues — returning to the author', 'info');
        } else if (response.success && response.sourcePaneId) {
          navigateReviewFlow(response.sourcePaneId);
          addToast('Sent findings to the author — fixing now', 'success');
        } else if (response.error) {
          addToast(response.error, 'error');
        }
        return response;
      } catch (err) {
        addToast(`Failed to send fixes: ${(err as Error).message}`, 'error');
        return null;
      }
    },
    [navigateReviewFlow, addToast],
  );

  const createPane = useCallback(
    async (req: PaneCreateRequest) => {
      try {
        const response = await paneApi.createPane(req);
        if (response.success && response.pane) {
          const pending = usePaneStore.getState().pendingPane;
          if (pending) {
            setPendingPane({
              ...pending,
              targetPaneId: response.pane.id,
            });
          }
          selectPane(response.pane.id);
          // If the user was in focus mode, snap back to fleet so the new pane is visible.
          if (useUiStore.getState().viewMode === 'focus') {
            useUiStore.getState().returnToFleet();
          }
          addToast(`Pane "${response.pane.slug}" created`, 'success');
        } else if (response.error) {
          addToast(response.error, 'error');
          setPendingPane(null);
        }
        return response;
      } catch (err) {
        addToast(`Failed to create pane: ${(err as Error).message}`, 'error');
        setPendingPane(null);
        return null;
      }
    },
    [selectPane, setPendingPane, addToast],
  );

  return { jumpToPane: jumpToTmuxPane, closePane, declareDuelWinner, mergePane, renamePane, createWorktree, duplicatePane, startReview, sendFixesToAuthor, createPane };
}
