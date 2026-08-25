import {
  assertClaudeFullscreenSupported,
  closePane,
  isAgentRunningInPane,
  isShellCommand,
  mergePane,
  readRegisteredSession,
  renamePane,
  resumeAgentInPane,
  SettingsManager,
  type ActionContext,
  type ActionResult,
  type MuxBasePane,
} from 'muxbase/core';
import { formatError } from '../../utils/formatError.js';
import { releaseWorktreeSnapshot } from '../git/gitDiff.js';
import { log } from '../Logger.js';

const FULLSCREEN_RESUME_IN_PROGRESS_MESSAGE = 'A fullscreen resume is already in progress for this pane.';

interface PaneActionWorkflowDependencies {
  addPaneToDone(pane: MuxBasePane): void;
  buildActionContext(): ActionContext;
  clearDuelMetadata(paneIds: readonly string[]): void;
  getConfigPath(): string;
  getPane(paneId: string): MuxBasePane | undefined;
  getPanes(): MuxBasePane[];
  getPaneCurrentCommand(paneId: string): Promise<string>;
  getProjectRoot(): string;
  paneExists(paneId: string): Promise<boolean>;
  persistPanesTransactionally(panes: MuxBasePane[]): void;
  reapOrphanedTranscripts(): Promise<void>;
}

export class PaneActionWorkflow {
  constructor(
    private readonly dependencies: PaneActionWorkflowDependencies,
    private readonly inFlightFullscreenResumePaneIds = new Set<string>(),
  ) {}

  async close(paneId: string): Promise<ActionResult> {
    log.info('bridge', 'Close pane requested', { paneId });
    const pane = this.dependencies.getPane(paneId);
    if (!pane) return { type: 'error', message: 'Pane not found' };

    const context = this.dependencies.buildActionContext();
    const result = this.decorateCloseResult(pane, await closePane(pane, context));
    log.info('bridge', 'Close pane result', { paneId, resultType: result.type });
    return result;
  }

  async merge(paneId: string): Promise<ActionResult> {
    log.info('bridge', 'Merge pane requested', { paneId });
    const pane = this.dependencies.getPane(paneId);
    if (!pane) return { type: 'error', message: 'Pane not found' };

    const context = this.dependencies.buildActionContext();
    const result = await mergePane(pane, context);
    log.info('bridge', 'Merge pane result', { paneId, resultType: result.type });
    return this.decorateMergeResult(pane, result);
  }

  async rename(paneId: string, newName: string): Promise<ActionResult> {
    log.info('bridge', 'Rename pane requested', { newName, paneId });
    const pane = this.dependencies.getPane(paneId);
    if (!pane) return { type: 'error', message: 'Pane not found' };

    const context = this.dependencies.buildActionContext();
    const result = await renamePane(pane, context, newName);
    log.info('bridge', 'Rename pane result', { paneId, resultType: result.type });
    return result;
  }

  async resumeInFullscreen(paneId: string): Promise<ActionResult> {
    if (this.inFlightFullscreenResumePaneIds.has(paneId)) {
      return { type: 'info', message: FULLSCREEN_RESUME_IN_PROGRESS_MESSAGE };
    }

    const eligibility = await this.inspectFullscreenResumeEligibility(paneId);
    if (!eligibility.eligible) return { type: 'info', message: eligibility.reason };

    const expectedConfigPath = this.dependencies.getConfigPath();
    const expectedProjectRoot = this.dependencies.getProjectRoot();
    return {
      cancelLabel: 'Cancel',
      confirmLabel: 'Resume in fullscreen',
      message: 'Claude has exited. MuxBase will resume the exact registered conversation in fullscreen. Any unsent text currently typed at the shell will be discarded.',
      onConfirm: async () => this.executeFullscreenResume(
        paneId,
        expectedConfigPath,
        expectedProjectRoot,
      ),
      title: 'Resume in fullscreen',
      type: 'confirm',
    };
  }

  private decorateCloseResult(pane: MuxBasePane, result: ActionResult): ActionResult {
    if (result.type === 'success') {
      void this.dependencies.reapOrphanedTranscripts();
      if (pane.worktreePath) releaseWorktreeSnapshot(pane.worktreePath);
      if (pane.duel) {
        const siblingIds = this.dependencies.getPanes()
          .filter((candidate) => candidate.duel?.groupId === pane.duel!.groupId)
          .map((candidate) => candidate.id);
        this.dependencies.clearDuelMetadata(siblingIds);
      }
      return result;
    }

    if (!result.onSelect) return result;
    const onSelect = result.onSelect;
    return {
      ...result,
      onSelect: async (value: string) => this.decorateCloseResult(
        pane,
        await onSelect(value),
      ),
    };
  }

  private decorateMergeResult(pane: MuxBasePane, result: ActionResult): ActionResult {
    const hasCallback = typeof result.onConfirm === 'function'
      || typeof result.onSelect === 'function'
      || typeof result.onSubmit === 'function';
    let decorated = result;

    if (typeof result.onConfirm === 'function') {
      const originalOnConfirm = result.onConfirm;
      decorated = {
        ...decorated,
        onConfirm: async () => this.decorateMergeResult(pane, await originalOnConfirm()),
      };
    }
    if (typeof result.onSelect === 'function') {
      const originalOnSelect = result.onSelect;
      decorated = {
        ...decorated,
        onSelect: async (value: string) => this.decorateMergeResult(
          pane,
          await originalOnSelect(value),
        ),
      };
    }
    if (typeof result.onSubmit === 'function') {
      const originalOnSubmit = result.onSubmit;
      decorated = {
        ...decorated,
        onSubmit: async (value: string) => this.decorateMergeResult(
          pane,
          await originalOnSubmit(value),
        ),
      };
    }
    if (!hasCallback && result.type === 'success') this.dependencies.addPaneToDone(pane);
    return decorated;
  }

  private async executeFullscreenResume(
    paneId: string,
    expectedConfigPath: string,
    expectedProjectRoot: string,
  ): Promise<ActionResult> {
    if (this.inFlightFullscreenResumePaneIds.has(paneId)) {
      return { type: 'info', message: FULLSCREEN_RESUME_IN_PROGRESS_MESSAGE };
    }

    this.inFlightFullscreenResumePaneIds.add(paneId);
    let profilePersisted = false;
    try {
      if (
        this.dependencies.getConfigPath() !== expectedConfigPath
        || this.dependencies.getProjectRoot() !== expectedProjectRoot
      ) {
        return {
          type: 'error',
          message: 'The active project changed. Reopen the pane action and try again.',
        };
      }

      const eligibility = await this.inspectFullscreenResumeEligibility(paneId);
      if (!eligibility.eligible) return { type: 'info', message: eligibility.reason };

      const panes = this.dependencies.getPanes();
      const paneIndex = panes.findIndex((candidate) => candidate.id === paneId);
      if (paneIndex < 0) return { type: 'error', message: 'Pane not found.' };

      const fullscreenPane: MuxBasePane = {
        ...eligibility.pane,
        claudeRenderer: 'fullscreen',
      };
      delete fullscreenPane.terminalFixedCols;
      const updatedPanes = [...panes];
      updatedPanes[paneIndex] = fullscreenPane;
      this.dependencies.persistPanesTransactionally(updatedPanes);
      profilePersisted = true;

      const settings = SettingsManager.getInstance(
        fullscreenPane.projectRoot ?? expectedProjectRoot,
      ).getSettings();
      const resumed = await resumeAgentInPane(
        fullscreenPane.paneId,
        'claude',
        settings,
        eligibility.sessionId,
        'fullscreen',
        { muxbasePaneId: fullscreenPane.id },
      );
      if (!resumed) {
        return {
          type: 'error',
          message: 'Claude was not resumed because the pane left its shell prompt. The fullscreen profile is saved; retry when the shell is idle.',
        };
      }
      return { type: 'success', message: 'Claude resumed in fullscreen.' };
    } catch (error) {
      return {
        type: 'error',
        message: profilePersisted
          ? `Fullscreen profile is saved, but resume failed: ${formatError(error)}`
          : `Unable to save the fullscreen profile: ${formatError(error)}`,
      };
    } finally {
      this.inFlightFullscreenResumePaneIds.delete(paneId);
    }
  }

  private async inspectFullscreenResumeEligibility(
    paneId: string,
  ): Promise<
    | { eligible: true; pane: MuxBasePane; sessionId: string }
    | { eligible: false; reason: string }
  > {
    const pane = this.dependencies.getPane(paneId);
    if (!pane || pane.agent !== 'claude') {
      return {
        eligible: false,
        reason: 'Resume in fullscreen is available only for registered Claude panes.',
      };
    }
    if (pane.claudeRenderer !== 'classic' && pane.claudeRenderer !== 'fullscreen') {
      return { eligible: false, reason: 'This Claude pane has no persisted renderer profile.' };
    }
    if (!await this.dependencies.paneExists(pane.paneId)) {
      return { eligible: false, reason: 'This pane no longer exists.' };
    }
    if (await isAgentRunningInPane(pane.paneId, 'claude')) {
      return {
        eligible: false,
        reason: 'Exit Claude first; MuxBase will not interrupt a live conversation.',
      };
    }
    const currentCommand = await this.dependencies.getPaneCurrentCommand(pane.paneId);
    if (!currentCommand || !isShellCommand(currentCommand)) {
      return {
        eligible: false,
        reason: 'Wait until the pane is at a shell prompt before resuming.',
      };
    }
    const registeredSession = readRegisteredSession(pane.id);
    if (!registeredSession?.sessionId) {
      return {
        eligible: false,
        reason: 'MuxBase could not find an exact registered Claude session for this pane.',
      };
    }

    try {
      await assertClaudeFullscreenSupported();
    } catch (error) {
      return { eligible: false, reason: formatError(error) };
    }
    return { eligible: true, pane, sessionId: registeredSession.sessionId };
  }
}
