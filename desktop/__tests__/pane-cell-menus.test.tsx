// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MuxBasePane } from 'muxbase/core';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTabsStrip } from '../src/renderer/components/dashboard/PaneCellTabs';
import { PaneActionsMenu } from '../src/renderer/components/dashboard/PaneActionsMenu';
import { ReviewLaunchButton } from '../src/renderer/components/dashboard/ReviewLaunchButton';
import type { FileTab } from '../src/renderer/stores';
import { useNotificationStore } from '../src/renderer/stores/notification.store';
import { usePaneActivityStore } from '../src/renderer/stores/pane-activity.store';
import { usePaneStore } from '../src/renderer/stores/pane.store';
import { useReviewLaunchStore } from '../src/renderer/stores/review-launch.store';
import { useDirtyMapStore } from '../src/renderer/stores/worktree-dirty.store';
import { makeActivity } from './helpers/pane-activity-fixtures';

const listAgents = vi.hoisted(() => vi.fn());
const paneApi = vi.hoisted(() => ({
  closePane: vi.fn(),
  duplicatePane: vi.fn(),
  executeCallback: vi.fn(),
  jumpToPane: vi.fn(),
  mergePane: vi.fn(),
  resumeInFullscreen: vi.fn(),
  sendKeys: vi.fn(),
  startReview: vi.fn(),
}));

vi.mock('../src/renderer/api/agent.api', () => ({ listAgents, refreshAgents: vi.fn() }));
vi.mock('../src/renderer/api/git.api', () => ({ getStatus: vi.fn().mockResolvedValue({ hasChanges: false }) }));
vi.mock('../src/renderer/api/pane.api', () => paneApi);
vi.mock('../src/renderer/lib/feature-flags', () => ({
  isKanbanBoardEnabled: () => true,
  isReviewAgentEnabled: () => true,
}));

const PANE: MuxBasePane = {
  agent: 'claude',
  id: 'pane-1',
  paneId: '%1',
  prompt: 'add login',
  slug: 'add-login',
  worktreePath: '/tmp/wt',
};

const EXPECTED_LABELS = [
  'Jump',
  'Merge',
  'Review',
  'Duplicate',
  'Rename',
  'Run Tests',
  'Run Dev',
  'Decompose (Alpha)',
  'Close',
];

function renderInPanel(node: React.ReactNode) {
  return render(<div data-testid="panel" style={{ overflow: 'hidden' }}>{node}</div>);
}

function renderActionsMenu(pane: MuxBasePane = PANE, onRename = vi.fn()) {
  renderInPanel(<PaneActionsMenu onRename={onRename} pane={pane} status="idle" />);
  const trigger = screen.getByRole('button', { name: 'Pane actions' });
  fireEvent.click(trigger);
  return { onRename, trigger };
}

function menuItem(label: string): HTMLElement {
  return screen.getByRole('menuitem', { name: label });
}

describe('portalled pane header menus', () => {
  beforeEach(() => {
    listAgents.mockResolvedValue(['claude', 'codex']);
    paneApi.duplicatePane.mockResolvedValue({ success: true, pane: { id: 'pane-2', slug: 'add-login-2' } });
    paneApi.jumpToPane.mockResolvedValue(undefined);
    paneApi.mergePane.mockResolvedValue({ type: 'success', message: 'merged' });
    paneApi.sendKeys.mockResolvedValue(undefined);
    paneApi.startReview.mockResolvedValue({ success: true, pane: { id: 'review-1', slug: 'review-add-login' } });
    useNotificationStore.setState({ toasts: [] });
    usePaneStore.setState({ panes: [PANE] });
    useDirtyMapStore.setState({ dirtyMap: {} });
    useReviewLaunchStore.setState({ launchingIds: new Set() });
    usePaneActivityStore.setState({
      activityByPaneId: {
        [PANE.id]: makeActivity({ certainty: 'confirmed', liveness: 'running', paneIncarnationId: 'pane-1-incarnation', state: 'idle' }),
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    usePaneActivityStore.getState().reset();
  });

  describe('PaneActionsMenu', () => {
    it('opens the menu into document.body instead of the clipping panel', () => {
      // Arrange + Act
      renderActionsMenu();

      // Assert
      const menu = screen.getByRole('menu');
      expect(menu.parentElement).toBe(document.body);
      expect(screen.getByTestId('panel').contains(menu)).toBe(false);
    });

    it('keeps every action and its label', () => {
      // Arrange + Act
      renderActionsMenu();

      // Assert
      expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual(EXPECTED_LABELS);
    });

    it('hides worktree actions and offers creation when the pane has no worktree', () => {
      // Arrange + Act
      renderActionsMenu({ ...PANE, worktreePath: undefined });

      // Assert
      const labels = screen.getAllByRole('menuitem').map((el) => el.textContent);
      expect(labels).toContain('Create Worktree');
      expect(labels).not.toContain('Merge');
      expect(labels).not.toContain('Run Tests');
    });

    it('disables the review action while a review is launching', () => {
      // Arrange
      useReviewLaunchStore.setState({ launchingIds: new Set([PANE.id]) });

      // Act
      renderActionsMenu();

      // Assert
      const review = menuItem('Starting review…');
      expect(review.hasAttribute('disabled')).toBe(true);
    });

    it('hides the direct review shortcut for agents without review capability', () => {
      renderActionsMenu({ ...PANE, agent: 'pi' });

      expect(screen.queryByRole('menuitem', { name: 'Review' })).toBeNull();
    });

    it('runs the jump action exactly once and closes the menu', () => {
      // Arrange
      renderActionsMenu();

      // Act
      fireEvent.click(menuItem('Jump'));

      // Assert
      expect(paneApi.jumpToPane).toHaveBeenCalledTimes(1);
      expect(paneApi.jumpToPane).toHaveBeenCalledWith({ paneId: PANE.id });
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('runs the duplicate action exactly once', () => {
      // Arrange
      renderActionsMenu();

      // Act
      fireEvent.click(menuItem('Duplicate'));

      // Assert
      expect(paneApi.duplicatePane).toHaveBeenCalledTimes(1);
    });

    it('hands renaming back to the header exactly once', () => {
      // Arrange
      const { onRename } = renderActionsMenu();

      // Act
      fireEvent.click(menuItem('Rename'));

      // Assert
      expect(onRename).toHaveBeenCalledTimes(1);
    });

    it('sends the test command exactly once', async () => {
      // Arrange
      renderActionsMenu();

      // Act
      fireEvent.click(menuItem('Run Tests'));

      // Assert
      await waitFor(() => expect(paneApi.sendKeys).toHaveBeenCalledTimes(1));
      expect(paneApi.sendKeys).toHaveBeenCalledWith({ paneId: PANE.id, command: 'pnpm test || npm test || yarn test' });
    });

    it('keeps the close confirmation flow that answers the backend choice', async () => {
      // Arrange
      paneApi.closePane.mockResolvedValue({
        type: 'choice',
        message: 'Close pane?',
        callbackId: 'cb-1',
        options: [{ id: 'keep', label: 'Keep worktree' }, { default: true, id: 'discard', label: 'Discard' }],
      });
      paneApi.executeCallback.mockResolvedValue({ type: 'success', message: 'closed' });
      renderActionsMenu();

      // Act
      fireEvent.click(menuItem('Close'));

      // Assert
      await waitFor(() => expect(paneApi.executeCallback).toHaveBeenCalledTimes(1));
      expect(paneApi.executeCallback).toHaveBeenCalledWith({ callbackId: 'cb-1', value: 'discard' });
    });

    it('keeps the classic warning visible and confirms an exact-session fullscreen resume', async () => {
      paneApi.resumeInFullscreen.mockResolvedValue({
        callbackId: 'resume-cb',
        cancelLabel: 'Cancel',
        confirmLabel: 'Resume in fullscreen',
        message: 'Any unsent text currently typed at the shell will be discarded.',
        title: 'Resume in fullscreen',
        type: 'confirm',
      });
      paneApi.executeCallback.mockResolvedValue({ type: 'success', message: 'Claude resumed in fullscreen.' });
      renderActionsMenu({ ...PANE, claudeRenderer: 'classic', terminalFixedCols: 100 });

      const warning = screen.getByRole('menuitem', { name: /Terminal history can be incomplete/ });
      expect(warning.textContent).toContain(
        'Terminal history can be incomplete during tall redraws. Use Activity',
      );
      expect(warning.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(menuItem('Resume in fullscreen'));

      const dialog = await screen.findByRole('dialog', { name: 'Resume in fullscreen' });
      expect(dialog.textContent).toContain('unsent text');
      await waitFor(() => expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Cancel' }),
      ));
      fireEvent.click(screen.getByRole('button', { name: 'Resume in fullscreen' }));
      await waitFor(() => expect(paneApi.executeCallback).toHaveBeenCalledWith({ callbackId: 'resume-cb' }));
    });

    it('announces fullscreen resume progress, reports errors in text, and restores focus', async () => {
      paneApi.resumeInFullscreen.mockResolvedValue({
        callbackId: 'resume-cb',
        cancelLabel: 'Cancel',
        confirmLabel: 'Resume in fullscreen',
        message: 'Any unsent text currently typed at the shell will be discarded.',
        title: 'Resume in fullscreen',
        type: 'confirm',
      });
      let finishResume!: (result: { message: string; type: 'error' }) => void;
      paneApi.executeCallback.mockReturnValue(new Promise((resolve) => { finishResume = resolve; }));
      const { trigger } = renderActionsMenu({ ...PANE, claudeRenderer: 'classic', terminalFixedCols: 100 });
      fireEvent.click(menuItem('Resume in fullscreen'));
      const dialog = await screen.findByRole('dialog', { name: 'Resume in fullscreen' });

      fireEvent.click(screen.getByRole('button', { name: 'Resume in fullscreen' }));

      await waitFor(() => expect(screen.getByRole('button', { name: 'Resuming…' }).hasAttribute('disabled')).toBe(true));
      expect(dialog.getAttribute('aria-busy')).toBe('true');
      finishResume({ message: 'Fullscreen profile is saved, but resume failed: launch failed', type: 'error' });

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Resume in fullscreen' })).toBeNull());
      expect(document.activeElement).toBe(trigger);
      expect(useNotificationStore.getState().toasts).toContainEqual(expect.objectContaining({
        message: 'Fullscreen profile is saved, but resume failed: launch failed',
        severity: 'error',
      }));
    });

    it('closes on Escape and returns focus to the trigger', () => {
      // Arrange
      const { trigger } = renderActionsMenu();

      // Act
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

      // Assert
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });

    it('activates the focused item exactly once from the keyboard', () => {
      // Arrange
      renderActionsMenu();

      // Act
      fireEvent.keyDown(menuItem('Jump'), { key: 'Enter' });

      // Assert
      expect(paneApi.jumpToPane).toHaveBeenCalledTimes(1);
    });
  });

  describe('ReviewLaunchButton', () => {
    async function openPopover() {
      renderInPanel(<ReviewLaunchButton defaultAgent="claude" paneId={PANE.id} />);
      const trigger = screen.getByRole('button', { name: 'Start review' });
      fireEvent.click(trigger);
      await screen.findByRole('button', { name: 'Start Review' });
      return { trigger };
    }

    it('opens the popover into document.body instead of the clipping panel', async () => {
      // Arrange + Act
      await openPopover();

      // Assert
      const popover = screen.getByRole('dialog');
      expect(popover.parentElement).toBe(document.body);
      expect(screen.getByTestId('panel').contains(popover)).toBe(false);
    });

    it('keeps the reviewer choices and starts the review exactly once', async () => {
      // Arrange
      await openPopover();

      // Assert
      expect(screen.getAllByRole('radio').map((el) => el.textContent)).toEqual(['Claude', 'Codex']);

      // Act
      fireEvent.click(screen.getByRole('button', { name: 'Start Review' }));

      // Assert
      await waitFor(() => expect(paneApi.startReview).toHaveBeenCalledTimes(1));
      expect(paneApi.startReview).toHaveBeenCalledWith({ paneId: PANE.id, agent: 'claude' });
    });

    it('starts the review with the reviewer picked in the popover', async () => {
      // Arrange
      await openPopover();

      // Act
      fireEvent.click(screen.getByRole('radio', { name: 'Codex' }));
      fireEvent.click(screen.getByRole('button', { name: 'Start Review' }));

      // Assert
      await waitFor(() => expect(paneApi.startReview).toHaveBeenCalledWith({ paneId: PANE.id, agent: 'codex' }));
    });

    it('closes on Escape and returns focus to the trigger', async () => {
      // Arrange
      const { trigger } = await openPopover();

      // Act
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

      // Assert
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });

    it('closes on an outside pointer down', async () => {
      // Arrange
      await openPopover();

      // Act
      fireEvent.pointerDown(document.body);

      // Assert
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('never shows the trigger tooltip over the open popover', async () => {
      // Arrange
      const { trigger } = await openPopover();
      const hoverTarget = trigger.parentElement!;

      // Act
      fireEvent.mouseEnter(hoverTarget);
      fireEvent.focusIn(trigger);

      // Assert
      expect(screen.queryByRole('tooltip')).toBeNull();
      expect(screen.getByRole('dialog')).toBeTruthy();

      // Act — the same hover, once the popover no longer covers that spot.
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      fireEvent.mouseEnter(hoverTarget);

      // Assert
      expect(screen.getByRole('tooltip').textContent).toBe('Start review');
    });
  });

  describe('FileTabsStrip', () => {
    const TABS: FileTab[] = [
      { fileName: 'auth.ts', id: 'tab-auth', openedAt: 1, relativePath: 'src/auth.ts', rootPath: '/tmp/wt' },
      { fileName: 'router.ts', id: 'tab-router', openedAt: 2, relativePath: 'src/router.ts', rootPath: '/tmp/wt' },
    ];

    const THREE_TABS: FileTab[] = [
      ...TABS,
      { fileName: 'store.ts', id: 'tab-store', openedAt: 3, relativePath: 'src/store.ts', rootPath: '/tmp/wt' },
    ];

    function renderStrip(activeId: string | null = TABS[0].id, tabs: FileTab[] = TABS) {
      const handlers = {
        onClick: vi.fn(),
        onClose: vi.fn(),
        onCloseAll: vi.fn(),
        onCloseOthers: vi.fn(),
        onCloseToRight: vi.fn(),
      };
      render(
        <div role="tablist">
          <FileTabsStrip activeId={activeId} tabs={tabs} {...handlers} />
        </div>,
      );
      return handlers;
    }

    function fileTab(name: string): HTMLElement {
      return screen.getByRole('tab', { name });
    }

    it('exposes only tabs as interactive accessibility children of the tablist', () => {
      // Arrange + Act
      renderStrip();

      // Assert
      const tablist = screen.getByRole('tablist');
      expect(screen.getAllByRole('tab').map((el) => el.textContent)).toEqual(['auth.ts', 'router.ts']);
      expect(tablist.querySelectorAll('[role="button"]')).toHaveLength(0);
      expect(screen.queryByRole('button', { name: 'Close auth.ts' })).toBeNull();
    });

    it('keeps only the active file tab in the page Tab sequence', () => {
      // Arrange + Act
      renderStrip(TABS[0].id);

      // Assert
      expect(fileTab('auth.ts').tabIndex).toBe(0);
      expect(fileTab('router.ts').tabIndex).toBe(-1);
    });

    it('moves and activates with horizontal arrow keys', () => {
      // Arrange
      const handlers = renderStrip(TABS[0].id);
      const activeTab = fileTab('auth.ts');
      activeTab.focus();

      // Act
      fireEvent.keyDown(activeTab, { key: 'ArrowRight' });

      // Assert
      expect(document.activeElement).toBe(fileTab('router.ts'));
      expect(handlers.onClick).toHaveBeenCalledWith(TABS[1]);
    });

    it('restores focus to the selected tab when arrow activation is refused', async () => {
      // Arrange
      const handlers = renderStrip(TABS[0].id);
      handlers.onClick.mockResolvedValueOnce(false);
      const activeTab = fileTab('auth.ts');
      activeTab.focus();

      // Act
      fireEvent.keyDown(activeTab, { key: 'ArrowRight' });

      // Assert
      await waitFor(() => expect(document.activeElement).toBe(activeTab));
      expect(fileTab('router.ts').getAttribute('aria-selected')).toBe('false');
    });

    it('activates a tab on click without closing it', () => {
      // Arrange
      const handlers = renderStrip(null);

      // Act
      fireEvent.click(fileTab('router.ts'));

      // Assert
      expect(handlers.onClick).toHaveBeenCalledWith(TABS[1]);
      expect(handlers.onClose).not.toHaveBeenCalled();
    });

    it('activates the focused tab from the keyboard', () => {
      // Arrange
      const handlers = renderStrip(null);

      // Act
      fireEvent.keyDown(fileTab('router.ts'), { key: 'Enter' });

      // Assert
      expect(handlers.onClick).toHaveBeenCalledWith(TABS[1]);
    });

    it.each(['Delete', 'Backspace'])('closes the focused tab on %s', (key) => {
      // Arrange
      const handlers = renderStrip();

      // Act
      fireEvent.keyDown(fileTab('auth.ts'), { key });

      // Assert
      expect(handlers.onClose).toHaveBeenCalledWith(TABS[0]);
      expect(handlers.onClick).not.toHaveBeenCalled();
    });

    it('keeps focus on the selected tab when a keyboard close is refused', async () => {
      // Arrange
      const handlers = renderStrip();
      handlers.onClose.mockResolvedValueOnce(false);
      const activeTab = fileTab('auth.ts');
      activeTab.focus();

      // Act
      fireEvent.keyDown(activeTab, { key: 'Delete' });

      // Assert
      await waitFor(() => expect(document.activeElement).toBe(activeTab));
      expect(handlers.onClose).toHaveBeenCalledWith(TABS[0]);
    });

    it('closes a tab when its close control is clicked', () => {
      // Arrange
      const handlers = renderStrip();

      // Act
      fireEvent.click(screen.getByTitle('Close router.ts'));

      // Assert
      expect(handlers.onClose).toHaveBeenCalledWith(TABS[1]);
      expect(handlers.onClick).not.toHaveBeenCalled();
    });

    it('moves focus to the next tab after a keyboard close', () => {
      // Arrange
      renderStrip(THREE_TABS[1].id, THREE_TABS);

      // Act
      fireEvent.keyDown(fileTab('router.ts'), { key: 'Delete' });

      // Assert
      expect(document.activeElement).toBe(fileTab('store.ts'));
    });

    it('moves focus to the previous tab when the last tab is closed from the keyboard', () => {
      // Arrange
      renderStrip(THREE_TABS[2].id, THREE_TABS);

      // Act
      fireEvent.keyDown(fileTab('store.ts'), { key: 'Delete' });

      // Assert
      expect(document.activeElement).toBe(fileTab('router.ts'));
    });

    it('leaves focus untouched when a tab is closed with the mouse', () => {
      // Arrange
      renderStrip(THREE_TABS[0].id, THREE_TABS);

      // Act
      fireEvent.click(screen.getByTitle('Close router.ts'));

      // Assert
      expect(document.activeElement).toBe(document.body);
    });
  });
});
