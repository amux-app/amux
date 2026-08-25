// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { SerializableActionResult } from '../../src/shared/ipc-types';

const storeState = vi.hoisted(() => ({
  selectPane: vi.fn(),
  setCreating: vi.fn(),
  setPendingPane: vi.fn(),
  addToast: vi.fn(),
  pendingPane: null as { agent: string; prompt: string; targetPaneId?: string } | null,
  panes: [] as Array<{ id: string; paneId: string }>,
  openConflictResolution: vi.fn(),
  openConflictView: vi.fn(),
  focusPane: vi.fn(),
  returnToFleet: vi.fn(),
  viewMode: 'fleet' as 'fleet' | 'focus',
}));

function makeSelectableStore<T extends object>(state: T) {
  const hook = vi.fn((selector: (s: T) => unknown) => selector(state));
  return Object.assign(hook, { getState: () => state });
}

vi.mock('../../src/renderer/stores', () => ({
  usePaneStore: makeSelectableStore({
    selectPane: storeState.selectPane,
    setCreating: storeState.setCreating,
    setPendingPane: storeState.setPendingPane,
    get pendingPane() {
      return storeState.pendingPane;
    },
    get panes() {
      return storeState.panes;
    },
  }),
  useNotificationStore: makeSelectableStore({ addToast: storeState.addToast }),
  useUiStore: makeSelectableStore({
    openConflictView: storeState.openConflictView,
    focusPane: storeState.focusPane,
    returnToFleet: storeState.returnToFleet,
    get viewMode() {
      return storeState.viewMode;
    },
  }),
}));

vi.mock('../../src/renderer/stores/conflict-resolution.store', () => ({
  useConflictResolutionStore: {
    getState: () => ({ openConflictResolution: storeState.openConflictResolution }),
  },
}));

const paneApiSpies = vi.hoisted(() => ({
  jumpToPane: vi.fn(),
  closePane: vi.fn(),
  mergePane: vi.fn(),
  renamePane: vi.fn(),
  createWorktree: vi.fn(),
  duplicatePane: vi.fn(),
  createPane: vi.fn(),
  executeCallback: vi.fn(),
  startReview: vi.fn(),
  sendFix: vi.fn(),
}));

vi.mock('../../src/renderer/api/pane.api', () => paneApiSpies);

import { usePaneActions } from '../../src/renderer/hooks/usePaneActions';

function renderActions() {
  return renderHook(() => usePaneActions()).result;
}

describe('usePaneActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.pendingPane = null;
    storeState.panes = [{ id: 'pane-7', paneId: '%7' }];
    storeState.viewMode = 'fleet';
  });

  it('jumpToPane sends the registered pane id, not the renderer tmux pane id', async () => {
    // Arrange
    paneApiSpies.jumpToPane.mockResolvedValue(undefined);
    const actions = renderActions();

    // Act
    await actions.current.jumpToPane('%7');

    // Assert
    expect(paneApiSpies.jumpToPane).toHaveBeenCalledWith({ paneId: 'pane-7' });
  });

  it('jumpToPane never calls the IPC layer for a pane that is no longer open', async () => {
    // Arrange
    storeState.panes = [];
    const actions = renderActions();

    // Act
    await actions.current.jumpToPane('%7');

    // Assert
    expect(paneApiSpies.jumpToPane).not.toHaveBeenCalled();
    expect(storeState.addToast).toHaveBeenCalledWith(
      expect.stringContaining('Failed to jump'),
      'error',
    );
  });

  it('jumpToPane surfaces a failure as an error toast', async () => {
    // Arrange
    paneApiSpies.jumpToPane.mockRejectedValue(new Error('tmux gone'));
    const actions = renderActions();

    // Act
    await actions.current.jumpToPane('%7');

    // Assert
    expect(storeState.addToast).toHaveBeenCalledWith(
      expect.stringContaining('tmux gone'),
      'error',
    );
  });

  it('closePane auto-resolves a choice result using the default option', async () => {
    // Arrange — closePane first returns a choice dialog, then a success result
    const choice: SerializableActionResult = {
      type: 'choice',
      message: 'How do you want to close?',
      callbackId: 'cb-1',
      options: [
        { id: 'kill_only', label: 'Just close', default: true },
        { id: 'kill_and_clean', label: 'Close and remove worktree' },
      ],
    };
    paneApiSpies.closePane.mockResolvedValue(choice);
    paneApiSpies.executeCallback.mockResolvedValue({ type: 'success', message: 'Pane closed' });
    const actions = renderActions();

    // Act
    const closed = await actions.current.closePane('muxbase-1');

    // Assert — the default choice id is sent back through the callback
    expect(paneApiSpies.executeCallback).toHaveBeenCalledWith({
      callbackId: 'cb-1',
      value: 'kill_only',
    });
    expect(storeState.addToast).toHaveBeenCalledWith('Pane closed', 'success');
    expect(closed).toBe(true);
  });

  it('closePane surfaces a thrown error as an error toast', async () => {
    // Arrange
    paneApiSpies.closePane.mockRejectedValue(new Error('disk full'));
    const actions = renderActions();

    // Act
    const closed = await actions.current.closePane('muxbase-1');

    // Assert
    expect(storeState.addToast).toHaveBeenCalledWith(
      expect.stringContaining('disk full'),
      'error',
    );
    expect(closed).toBe(false);
  });

  it('closePane reports false when the backend rejects the close action', async () => {
    paneApiSpies.closePane.mockResolvedValue({ type: 'error', message: 'Pane is still running' });
    const actions = renderActions();

    const closed = await actions.current.closePane('muxbase-1');

    expect(storeState.addToast).toHaveBeenCalledWith('Pane is still running', 'error');
    expect(closed).toBe(false);
  });

  it('renamePane forwards the registered pane id and normalized name', async () => {
    // Arrange
    paneApiSpies.renamePane.mockResolvedValue({ type: 'success', message: 'Renamed' });
    const actions = renderActions();

    // Act
    await actions.current.renamePane('pane-7', 'Clearer name');

    // Assert
    expect(paneApiSpies.renamePane).toHaveBeenCalledWith({
      paneId: 'pane-7',
      newName: 'Clearer name',
    });
    expect(storeState.addToast).toHaveBeenCalledWith('Renamed', 'success');
  });

  it('createPane selects the new pane and toasts on success', async () => {
    // Arrange
    paneApiSpies.createPane.mockResolvedValue({
      success: true,
      pane: { id: 'muxbase-9', slug: 'fix-bug' },
    });
    const actions = renderActions();

    // Act
    await actions.current.createPane({ prompt: 'fix the bug' });

    // Assert
    expect(storeState.selectPane).toHaveBeenCalledWith('muxbase-9');
    expect(storeState.addToast).toHaveBeenCalledWith(
      expect.stringContaining('fix-bug'),
      'success',
    );
  });

  it('createPane clears the pending pane and toasts when the backend reports failure', async () => {
    // Arrange
    paneApiSpies.createPane.mockResolvedValue({
      success: false,
      error: 'worktree path collision',
    });
    const actions = renderActions();

    // Act
    await actions.current.createPane({ prompt: 'fix the bug' });

    // Assert
    expect(storeState.addToast).toHaveBeenCalledWith('worktree path collision', 'error');
    expect(storeState.setPendingPane).toHaveBeenCalledWith(null);
  });

  it('createPane snaps back to fleet view when the user was in focus mode', async () => {
    // Arrange
    storeState.viewMode = 'focus';
    paneApiSpies.createPane.mockResolvedValue({
      success: true,
      pane: { id: 'muxbase-9', slug: 'fix-bug' },
    });
    const actions = renderActions();

    // Act
    await actions.current.createPane({ prompt: 'fix the bug' });

    // Assert
    expect(storeState.returnToFleet).toHaveBeenCalledTimes(1);
  });

  it('createPane leaves the view mode alone when the user was not in focus mode', async () => {
    // Arrange — user is in fleet already; kanban / summary should also be left alone
    storeState.viewMode = 'fleet';
    paneApiSpies.createPane.mockResolvedValue({
      success: true,
      pane: { id: 'muxbase-9', slug: 'fix-bug' },
    });
    const actions = renderActions();

    // Act
    await actions.current.createPane({ prompt: 'fix the bug' });

    // Assert
    expect(storeState.returnToFleet).not.toHaveBeenCalled();
  });

  it('mergePane routes a merge-conflict result into the conflict-resolution flow', async () => {
    // Arrange
    const conflictResult: SerializableActionResult = {
      type: 'choice',
      title: 'Merge Conflicts Detected',
      message: 'Resolve conflicts',
      callbackId: 'cb-merge',
      options: [{ id: 'resolve', label: 'Resolve' }],
    };
    paneApiSpies.mergePane.mockResolvedValue(conflictResult);
    const actions = renderActions();

    // Act
    await actions.current.mergePane('muxbase-2');

    // Assert — conflict UI is opened rather than toasting a generic message
    expect(storeState.openConflictResolution).toHaveBeenCalledWith('muxbase-2', conflictResult);
    expect(storeState.openConflictView).toHaveBeenCalled();
  });

  it('moves Focus view into the newly created review pane', async () => {
    storeState.viewMode = 'focus';
    paneApiSpies.startReview.mockResolvedValue({
      success: true,
      pane: { id: 'review-pane', slug: 'review-feature' },
    });
    const actions = renderActions();

    await actions.current.startReview('source-pane', 'codex');

    expect(storeState.selectPane).toHaveBeenCalledWith('review-pane');
    expect(storeState.focusPane).toHaveBeenCalledWith('review-pane');
  });

  it('moves Focus view back to the author pane after sending findings', async () => {
    storeState.viewMode = 'focus';
    paneApiSpies.sendFix.mockResolvedValue({ success: true, sourcePaneId: 'source-pane' });
    const actions = renderActions();

    await actions.current.sendFixesToAuthor('review-pane');

    expect(storeState.selectPane).toHaveBeenCalledWith('source-pane');
    expect(storeState.focusPane).toHaveBeenCalledWith('source-pane');
  });

  it('warns when findings may cite line numbers from a changed source', async () => {
    paneApiSpies.sendFix.mockResolvedValue({
      success: true,
      snapshotDrift: 'changed',
      sourcePaneId: 'source-pane',
    });
    const actions = renderActions();

    await actions.current.sendFixesToAuthor('review-pane');

    expect(storeState.addToast).toHaveBeenCalledWith(
      "The author's code changed since this review — findings may cite outdated line numbers.",
      'warning',
    );
  });

  it('moves Focus view back to the author pane when the review is clean', async () => {
    storeState.viewMode = 'focus';
    paneApiSpies.sendFix.mockResolvedValue({
      success: true,
      noIssues: true,
      sourcePaneId: 'source-pane',
    });
    const actions = renderActions();

    await actions.current.sendFixesToAuthor('review-pane');

    expect(storeState.focusPane).toHaveBeenCalledWith('source-pane');
    expect(storeState.addToast).toHaveBeenCalledWith(
      'Reviewer found no issues — returning to the author',
      'info',
    );
  });
});
