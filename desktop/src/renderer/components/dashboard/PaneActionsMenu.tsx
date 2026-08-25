import type { MuxBasePane } from 'muxbase/core';
import type { PaneActivityState } from '../../../shared/pane-activity';
import { useRef, useState } from 'react';
import type { SerializableActionResult } from '../../../shared/ipc-types';
import * as paneApi from '../../api/pane.api';
import { usePaneActions } from '../../hooks/usePaneActions';
import { useReviewControls } from '../../hooks/useReviewControls';
import { cn } from '../../lib/cn';
import { HEADER_ICON_BUTTON_CLASS } from '../../lib/constants';
import { isKanbanBoardEnabled } from '../../lib/feature-flags';
import { useDecomposeStore, useElectronSettingsStore, useNotificationStore, useUiStore } from '../../stores';
import { useProjectStore } from '../../stores/project.store';
import { AnchoredMenu } from '../shared/AnchoredMenu';
import { ConfirmDialog } from '../shared/ConfirmDialog';

interface PaneActionsMenuProps {
  pane: MuxBasePane;
  status: PaneActivityState;
  /** Invoked when the user picks "Rename" — the header owns the inline rename input. */
  onRename: () => void;
}

/**
 * The pane's "⋮" actions dropdown, shared by the normal and Zen headers so the
 * two can't drift. Self-contained apart from `onRename`, which toggles the
 * header-local rename input.
 */
export function PaneActionsMenu({ pane, status, onRename }: Readonly<PaneActionsMenuProps>) {
  const { jumpToPane, mergePane, closePane, createWorktree, duplicatePane, startReview } = usePaneActions();
  const addToast = useNotificationStore((s) => s.addToast);
  const kanbanBoardEnabled = useElectronSettingsStore((s) => isKanbanBoardEnabled(s.settings));
  const { canReview, isReviewLaunching } = useReviewControls(pane, status);
  const [menuOpen, setMenuOpen] = useState(false);
  const [creatingWorktree, setCreatingWorktree] = useState(false);
  const [fullscreenConfirm, setFullscreenConfirm] = useState<SerializableActionResult | null>(null);
  const [resumingFullscreen, setResumingFullscreen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hasWorktree = !!pane.worktreePath;
  const isReviewPane = pane.role === 'review';
  const canOfferFullscreenResume = pane.agent === 'claude'
    && (pane.claudeRenderer === 'classic' || (pane.claudeRenderer === 'fullscreen' && status === 'idle'));

  const notifyActionResult = (result: SerializableActionResult) => {
    const severity = result.type === 'error'
      ? 'error'
      : result.type === 'success' ? 'success' : 'info';
    addToast(result.message, severity);
  };

  const handleFullscreenResumeRequest = async () => {
    setMenuOpen(false);
    try {
      const result = await paneApi.resumeInFullscreen({ paneId: pane.id });
      if (result.type === 'confirm' && result.callbackId) {
        setFullscreenConfirm(result);
        return;
      }
      notifyActionResult(result);
    } catch (error) {
      addToast(`Failed to prepare fullscreen resume: ${(error as Error).message}`, 'error');
    }
  };

  const handleFullscreenResumeConfirm = async () => {
    const callbackId = fullscreenConfirm?.callbackId;
    if (!callbackId || resumingFullscreen) return;
    setResumingFullscreen(true);
    try {
      const result = await paneApi.executeCallback({ callbackId });
      notifyActionResult(result);
      setFullscreenConfirm(null);
    } catch (error) {
      addToast(`Failed to resume Claude: ${(error as Error).message}`, 'error');
    } finally {
      setResumingFullscreen(false);
    }
  };

  const handleCreateWorktree = async () => {
    setMenuOpen(false);
    setCreatingWorktree(true);
    try {
      await createWorktree(pane.id);
    } finally {
      setCreatingWorktree(false);
    }
  };

  return (
    <div>
      <button
        ref={triggerRef}
        onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
        className={cn(HEADER_ICON_BUTTON_CLASS, 'text-xs text-[var(--text-muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--text)]')}
        aria-label="Pane actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        &#x22EE;
      </button>
      <AnchoredMenu
        className="w-56 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] shadow-xl py-1"
        label="Pane actions"
        onClose={() => setMenuOpen(false)}
        open={menuOpen}
        triggerRef={triggerRef}
      >
        <MenuItem label="Jump" onClick={() => { if (pane.paneId) jumpToPane(pane.paneId); setMenuOpen(false); }} />
        {pane.duel && (
          <MenuItem
            label="Open duel"
            onClick={() => { useUiStore.getState().openDuel(pane.duel!.groupId); setMenuOpen(false); }}
          />
        )}
        {!hasWorktree && (
          <MenuItem
            label={creatingWorktree ? 'Creating...' : 'Create Worktree'}
            onClick={handleCreateWorktree}
          />
        )}
        {hasWorktree && !isReviewPane && <MenuItem label="Merge" onClick={() => { mergePane(pane.id); setMenuOpen(false); }} />}
        {canReview && (
          <MenuItem
            label={isReviewLaunching ? 'Starting review…' : 'Review'}
            disabled={isReviewLaunching}
            onClick={() => { startReview(pane.id, pane.agent); setMenuOpen(false); }}
          />
        )}
        <MenuItem label="Duplicate" onClick={() => { duplicatePane(pane.id); setMenuOpen(false); }} />
        <MenuItem label="Rename" onClick={() => { onRename(); setMenuOpen(false); }} />
        {pane.agent === 'claude' && pane.claudeRenderer === 'classic' && (
          <div
            aria-disabled="true"
            className="border-y border-[var(--border)] my-1 px-3 py-2 text-[10px] leading-relaxed text-[var(--text-muted)]"
            role="menuitem"
          >
            Terminal history can be incomplete during tall redraws. Use Activity for conversation history.
          </div>
        )}
        {canOfferFullscreenResume && (
          <MenuItem
            label={pane.claudeRenderer === 'classic' ? 'Resume in fullscreen' : 'Retry fullscreen resume'}
            onClick={handleFullscreenResumeRequest}
          />
        )}
        {pane.worktreePath && (
          <>
            <div className="border-t border-[var(--border)] my-1" />
            <MenuItem label="Run Tests" onClick={async () => {
              setMenuOpen(false);
              if (pane.paneId) {
                try {
                  await paneApi.sendKeys({ paneId: pane.id, command: 'pnpm test || npm test || yarn test' });
                } catch (err) {
                  addToast(`Failed to run tests: ${(err as Error).message}`, 'error');
                }
              }
            }} />
            <MenuItem label="Run Dev" onClick={async () => {
              setMenuOpen(false);
              if (pane.paneId) {
                try {
                  await paneApi.sendKeys({ paneId: pane.id, command: 'pnpm dev || npm run dev || yarn dev' });
                } catch (err) {
                  addToast(`Failed to run dev: ${(err as Error).message}`, 'error');
                }
              }
            }} />
          </>
        )}
        {kanbanBoardEnabled && (
          <>
            <div className="border-t border-[var(--border)] my-1" />
            <MenuItem label="Decompose (Alpha)" onClick={() => {
              setMenuOpen(false);
              const project = useProjectStore.getState().activeProject;
              if (project?.root) {
                useDecomposeStore.getState().open({
                  paneId: pane.id,
                  prompt: pane.prompt,
                  projectRoot: project.root,
                });
              }
            }} />
          </>
        )}
        <MenuItem label="Close" onClick={() => { closePane(pane.id); setMenuOpen(false); }} danger />
      </AnchoredMenu>
      <ConfirmDialog
        cancelLabel={fullscreenConfirm?.cancelLabel}
        confirmLabel={resumingFullscreen ? 'Resuming…' : fullscreenConfirm?.confirmLabel}
        initialFocus="cancel"
        message={fullscreenConfirm?.message ?? ''}
        onCancel={() => setFullscreenConfirm(null)}
        onConfirm={handleFullscreenResumeConfirm}
        open={fullscreenConfirm !== null}
        pending={resumingFullscreen}
        restoreFocusTarget={() => triggerRef.current}
        title={fullscreenConfirm?.title ?? 'Resume in fullscreen'}
      />
    </div>
  );
}

function MenuItem({ label, onClick, danger = false, disabled = false }: Readonly<{ label: string; onClick: () => void; danger?: boolean; disabled?: boolean }>) {
  return (
    <button
      role="menuitem"
      onClick={(e) => { e.stopPropagation(); if (!disabled) onClick(); }}
      disabled={disabled}
      className={cn(
        'w-full text-left px-3 py-1.5 text-xs transition-colors',
        disabled
          ? 'opacity-50 cursor-default text-[var(--text-muted)]'
          : danger
            ? 'text-[var(--error)] hover:bg-[var(--error)]/10'
            : 'text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text)]',
      )}
    >
      {label}
    </button>
  );
}
