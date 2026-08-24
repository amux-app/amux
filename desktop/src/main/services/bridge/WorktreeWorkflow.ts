import {
  createWorktreeForPane,
  inspectPreservedWorktreeAsync,
  listPreservedWorktreesAsync,
  removePreservedWorktreeAsync,
  shQuote,
  TMUX_SHELL_READY_DELAY,
  triggerHook,
  type AumxPane,
  type PreservedWorktree,
} from 'aumx/core';
import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'path';
import type {
  OrphanedWorktreeInfo,
  PaneAttachWorktreeResponse,
  PaneCreateResponse,
  PaneCreateWorktreeResponse,
  WorktreeInspectResponse,
  WorktreeOrphansListResponse,
  WorktreeRemovalState,
  WorktreeRemoveResponse,
} from '../../../shared/ipc-types.js';
import { formatError } from '../../utils/formatError.js';
import { log } from '../Logger.js';

const NO_ACTIVE_PROJECT_MESSAGE = 'Choose or create a project before starting panes.';

function toOrphanedWorktreeInfo(worktree: PreservedWorktree): OrphanedWorktreeInfo {
  return {
    branch: worktree.branch,
    gitStatus: worktree.gitStatus,
    lastModifiedMs: worktree.lastModified.getTime(),
    path: worktree.path,
    registration: worktree.registration,
    slug: worktree.slug,
  };
}

interface WorktreeWorkflowDependencies {
  ensureValidControlPaneId(): Promise<void>;
  getPane(paneId: string): AumxPane | undefined;
  getPanes(): AumxPane[];
  getProjectName(): string;
  getProjectRoot(): string;
  getSessionName(): string;
  hasActiveProjectContext(): boolean;
  killPane(paneId: string): Promise<void>;
  newWindowPane(options: { cwd: string; sessionName: string }): Promise<string>;
  replacePanesBestEffort(panes: AumxPane[]): void;
  resumePaneWatcher(): void;
  saveReopenedPane(pane: AumxPane): void;
  sendProgress(action: string, active: boolean): void;
  sendShellCommand(paneId: string, command: string): Promise<void>;
  sendTmuxKeys(paneId: string, keys: string): Promise<void>;
  sendToast(message: string, type: 'error' | 'info' | 'success' | 'warning'): void;
  setPaneTitleSafe(paneId: string, title: string): Promise<void>;
  setupTranscriptPiping(
    paneId: string,
    existingTranscriptPath?: string,
    filenamePrefix?: string,
  ): Promise<string | undefined>;
  startPaneMonitor(panes: AumxPane[]): Promise<void>;
  suspendPaneWatcher(): void;
}

export class WorktreeWorkflow {
  constructor(
    private readonly dependencies: WorktreeWorkflowDependencies,
    private readonly mutationPaths = new Set<string>(),
  ) {}

  async list(): Promise<WorktreeOrphansListResponse> {
    if (!this.dependencies.hasActiveProjectContext()) {
      return { success: false, worktrees: [], error: NO_ACTIVE_PROJECT_MESSAGE };
    }
    const worktrees = await listPreservedWorktreesAsync(
      this.dependencies.getProjectRoot(),
      this.getActiveWorktreePaths(),
    );
    return { success: true, worktrees: worktrees.map(toOrphanedWorktreeInfo) };
  }

  async inspect(worktreePath: string): Promise<WorktreeInspectResponse> {
    if (!this.dependencies.hasActiveProjectContext()) {
      return { success: false, error: NO_ACTIVE_PROJECT_MESSAGE };
    }
    try {
      const worktree = await inspectPreservedWorktreeAsync(
        this.dependencies.getProjectRoot(),
        this.getActiveWorktreePaths(),
        worktreePath,
      );
      return { success: true, worktree: toOrphanedWorktreeInfo(worktree) };
    } catch (error) {
      return { success: false, error: formatError(error) };
    }
  }

  async remove(
    worktreePath: string,
    allowDataLoss: boolean,
    expectedState: WorktreeRemovalState,
  ): Promise<WorktreeRemoveResponse> {
    if (!this.dependencies.hasActiveProjectContext()) {
      return { success: false, error: NO_ACTIVE_PROJECT_MESSAGE };
    }
    const normalizedPath = resolve(worktreePath);
    if (this.mutationPaths.has(normalizedPath)) {
      return { success: false, error: 'Worktree is already being modified' };
    }

    this.mutationPaths.add(normalizedPath);
    try {
      await removePreservedWorktreeAsync({
        activeWorktreePaths: this.getActiveWorktreePaths(),
        allowDataLoss,
        expectedState,
        projectRoot: this.dependencies.getProjectRoot(),
        worktreePath: normalizedPath,
      });
      log.info('bridge', 'Removed preserved worktree', { worktreePath: normalizedPath });
      this.dependencies.sendToast(
        `Removed preserved worktree "${basename(normalizedPath)}"`,
        'success',
      );
      return { success: true };
    } catch (error) {
      log.warn('bridge', 'Failed to remove preserved worktree', {
        error: formatError(error),
        worktreePath: normalizedPath,
      });
      return { success: false, error: formatError(error) };
    } finally {
      this.mutationPaths.delete(normalizedPath);
    }
  }

  async reopen(worktreePath: string): Promise<PaneCreateResponse> {
    if (!this.dependencies.hasActiveProjectContext()) {
      this.dependencies.sendToast(NO_ACTIVE_PROJECT_MESSAGE, 'warning');
      return { success: false, error: NO_ACTIVE_PROJECT_MESSAGE };
    }

    const normalizedWorktreePath = resolve(worktreePath);
    log.info('bridge', 'Reopening preserved worktree', {
      worktreePath: normalizedWorktreePath,
    });
    if (this.mutationPaths.has(normalizedWorktreePath)) {
      return { success: false, error: 'Worktree is already reopening' };
    }

    this.mutationPaths.add(normalizedWorktreePath);
    let allocatedPaneId: string | undefined;
    let panePersisted = false;
    let progressStarted = false;
    let watcherSuspended = false;
    try {
      const worktree = await this.findOrphanedWorktree(normalizedWorktreePath);
      if (!worktree) {
        return { success: false, error: 'Worktree is not available to reopen' };
      }

      this.dependencies.sendProgress('Reopening worktree...', true);
      progressStarted = true;
      await this.dependencies.ensureValidControlPaneId();
      this.dependencies.suspendPaneWatcher();
      watcherSuspended = true;

      const tmuxPaneId = await this.dependencies.newWindowPane({
        cwd: worktree.path,
        sessionName: this.dependencies.getSessionName(),
      });
      allocatedPaneId = tmuxPaneId;
      await new Promise((complete) => setTimeout(complete, TMUX_SHELL_READY_DELAY));
      await this.dependencies.setPaneTitleSafe(tmuxPaneId, worktree.slug);
      const transcriptPath = await this.dependencies.setupTranscriptPiping(
        tmuxPaneId,
        undefined,
        'reopened',
      );
      const pane: AumxPane = {
        branchName: worktree.branch && worktree.branch !== worktree.slug
          ? worktree.branch
          : undefined,
        id: `aumx-${randomUUID()}`,
        paneId: tmuxPaneId,
        projectName: this.dependencies.getProjectName(),
        projectRoot: this.dependencies.getProjectRoot(),
        prompt: '',
        slug: worktree.slug,
        terminalTranscriptPath: transcriptPath,
        type: 'worktree',
        worktreePath: worktree.path,
      };

      this.dependencies.saveReopenedPane(pane);
      panePersisted = true;
      try {
        await this.dependencies.startPaneMonitor(this.dependencies.getPanes());
      } catch (error) {
        log.warn('bridge', 'Pane monitor refresh failed after reopening worktree', {
          error: formatError(error),
          paneId: pane.id,
        });
      }
      triggerHook('pane_reopened', this.dependencies.getProjectRoot(), pane).catch((error) => {
        log.debug('bridge', 'pane_reopened hook failed', { error: String(error) });
      });
      this.dependencies.sendToast(`Reopened worktree "${worktree.slug}"`, 'success');
      return { success: true, pane };
    } catch (error) {
      log.error('bridge', 'Failed to reopen worktree', error);
      if (allocatedPaneId && !panePersisted) {
        try {
          await this.dependencies.killPane(allocatedPaneId);
        } catch (cleanupError) {
          log.warn('bridge', 'Failed to clean up uncommitted reopened pane', {
            error: formatError(cleanupError),
            paneId: allocatedPaneId,
          });
        }
      }
      return { success: false, error: formatError(error) };
    } finally {
      this.mutationPaths.delete(normalizedWorktreePath);
      if (watcherSuspended) this.dependencies.resumePaneWatcher();
      if (progressStarted) this.dependencies.sendProgress('Reopening worktree...', false);
    }
  }

  async createForPane(paneId: string): Promise<PaneCreateWorktreeResponse> {
    log.info('bridge', 'Create worktree requested', { paneId });
    const pane = this.dependencies.getPane(paneId);
    if (!pane) return { success: false, error: 'Pane not found' };
    if (pane.worktreePath) return { success: false, error: 'Pane already has a worktree' };

    try {
      const targetProjectRoot = pane.projectRoot ?? this.dependencies.getProjectRoot();
      const result = await createWorktreeForPane(pane, targetProjectRoot);
      if (!result) return { success: false, error: 'Worktree creation returned no result' };

      const panes = this.dependencies.getPanes();
      const index = panes.findIndex((candidate) => candidate.id === paneId);
      if (index >= 0) {
        const updated = panes.map((candidate, currentIndex) => currentIndex === index
          ? {
              ...candidate,
              branchName: result.branchName !== candidate.slug
                ? result.branchName
                : undefined,
              worktreePath: result.worktreePath,
            }
          : candidate);
        this.dependencies.replacePanesBestEffort(updated);
      }

      await this.changePaneDirectory(pane, result.worktreePath, 'new');
      log.info('bridge', 'Worktree created', { paneId, worktreePath: result.worktreePath });
      this.dependencies.sendToast(`Worktree created for "${pane.slug}"`, 'success');
      return {
        success: true,
        branchName: result.branchName,
        worktreePath: result.worktreePath,
      };
    } catch (error) {
      log.error('bridge', 'Worktree creation failed', error);
      return { success: false, error: formatError(error) };
    }
  }

  async attachToPane(
    paneId: string,
    worktreePath: string,
  ): Promise<PaneAttachWorktreeResponse> {
    log.info('bridge', 'Attach worktree requested', { paneId, worktreePath });
    const pane = this.dependencies.getPane(paneId);
    if (!pane) return { success: false, error: 'Pane not found' };

    const normalizedPath = resolve(worktreePath);
    if (pane.worktreePath && resolve(pane.worktreePath) === normalizedPath) {
      return {
        success: true,
        branchName: pane.branchName,
        worktreePath: pane.worktreePath,
      };
    }
    if (this.mutationPaths.has(normalizedPath)) {
      return { success: false, error: 'Worktree is already being modified' };
    }

    this.mutationPaths.add(normalizedPath);
    try {
      const worktree = await this.findOrphanedWorktree(normalizedPath);
      if (!worktree) return { success: false, error: 'Worktree is not available to attach' };

      const panes = this.dependencies.getPanes();
      const index = panes.findIndex((candidate) => candidate.id === paneId);
      if (index < 0) return { success: false, error: 'Pane not found' };
      const branchName = worktree.branch ?? worktree.slug;
      const updated = panes.map((candidate, currentIndex) => currentIndex === index
        ? {
            ...candidate,
            branchName: branchName === candidate.slug ? candidate.branchName : branchName,
            worktreePath: worktree.path,
          }
        : candidate);
      this.dependencies.replacePanesBestEffort(updated);

      await this.changePaneDirectory(pane, worktree.path, 'attached');
      log.info('bridge', 'Worktree attached to pane', {
        paneId,
        worktreePath: worktree.path,
      });
      this.dependencies.sendToast(
        `Attached worktree "${worktree.slug}" to "${pane.slug}"`,
        'success',
      );
      return { success: true, branchName, worktreePath: worktree.path };
    } catch (error) {
      log.error('bridge', 'Attach worktree failed', error);
      return { success: false, error: formatError(error) };
    } finally {
      this.mutationPaths.delete(normalizedPath);
    }
  }

  private async changePaneDirectory(
    pane: AumxPane,
    worktreePath: string,
    operation: 'attached' | 'new',
  ): Promise<void> {
    if (!pane.paneId) return;
    try {
      await this.dependencies.sendShellCommand(pane.paneId, `cd ${shQuote(worktreePath)}`);
      await this.dependencies.sendTmuxKeys(pane.paneId, 'Enter');
    } catch (error) {
      const message = operation === 'new'
        ? 'Failed to chdir pane into new worktree'
        : 'Failed to chdir pane into attached worktree';
      log.warn('bridge', message, { paneId: pane.id, err: formatError(error) });
    }
  }

  private async findOrphanedWorktree(worktreePath: string): Promise<PreservedWorktree> {
    return inspectPreservedWorktreeAsync(
      this.dependencies.getProjectRoot(),
      this.getActiveWorktreePaths(),
      worktreePath,
    );
  }

  private getActiveWorktreePaths(): string[] {
    return this.dependencies.getPanes().flatMap((pane) => (
      pane.worktreePath ? [pane.worktreePath] : []
    ));
  }
}
