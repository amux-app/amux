import {
  assertClaudeFullscreenSupported,
  condenseTitleLocally,
  createPane as createCorePane,
  resolvePaneTerminalProfile,
  SettingsManager,
  triggerHook,
  AgentName,
  type AumxPane,
  type DuelMetadata,
  type ReviewMetadata,
} from 'aumx/core';
import { basename } from 'path';
import type { PaneCreateResponse } from '../../../shared/ipc-types.js';
import { formatError } from '../../utils/formatError.js';
import { ensureGitRepository } from '../GitRepositoryBootstrap.js';
import { log } from '../Logger.js';

const NO_ACTIVE_PROJECT_MESSAGE = 'Choose or create a project before starting panes.';

export interface PaneLaunchOptions {
  agentPrompt?: string;
  claudeRenderer?: 'classic';
  duel?: DuelMetadata;
  effort?: string;
  model?: string;
  paneTitle?: string;
  projectRoot?: string;
  readOnly?: boolean;
  resumeSessionId?: string;
  review?: ReviewMetadata;
  role?: 'review';
  sendPromptToAgent?: boolean;
  slugBase?: string;
  slugSuffix?: string;
  sourceBacklogId?: string;
  useWorktree?: boolean;
  worktreeSeedFile?: { content: string; relativePath: string };
  worktreeStartPoint?: string;
}

interface PaneLaunchWorkflowDependencies {
  createPaneCoordinated(
    prompt: string,
    agent?: AgentName,
    options?: PaneLaunchOptions,
  ): Promise<PaneCreateResponse>;
  decorateCreatedPane(
    pane: AumxPane,
    sourceBacklogId?: string,
    paneTitle?: string,
    localTitle?: string,
  ): AumxPane;
  detectAvailableAgents(): Promise<void>;
  emitEarlyPane(
    pane: AumxPane,
    sourceBacklogId?: string,
    paneTitle?: string,
    localTitle?: string,
  ): void;
  ensureValidControlPaneId(): Promise<boolean>;
  getAvailableAgents(): AgentName[];
  getConfigPath(): string;
  getControlPaneId(): string | undefined;
  getInitialTerminalSize(): { cols: number; rows: number } | undefined;
  getOtlpEndpoint(): string | undefined;
  getPanes(): AumxPane[];
  getProjectRoot(): string;
  getSessionName(): string;
  getTerminalTranscriptDir(): string | undefined;
  hasAvailableAgentsCache(): boolean;
  hasActiveProjectContext(): boolean;
  killPane(paneId: string): Promise<void>;
  lifecycleAdaptersEnabled(): boolean;
  maybeRequestExperimentalPaneTitle(paneId: string, sourceText: string): Promise<void>;
  newWindowPane(options: { cwd: string; sessionName: string }): Promise<string>;
  publishSessionColorHint(sessionName: string): Promise<void>;
  removeEarlyPane(paneId: string): void;
  resumePaneWatcher(): void;
  savePane(pane: AumxPane): void;
  sendProgress(action: string, active: boolean): void;
  sendToast(message: string, type: 'error' | 'info' | 'success' | 'warning'): void;
  setPaneTitleSafe(paneId: string, title: string): Promise<void>;
  setupTranscriptPiping(
    paneId: string,
    existingTranscriptPath?: string,
    filenamePrefix?: string,
  ): Promise<string | undefined>;
  startPaneMonitor(panes: AumxPane[]): Promise<boolean>;
  startSessionTracking(pane: AumxPane): void;
  suspendPaneWatcher(): void;
}

export class PaneLaunchWorkflow {
  constructor(private readonly dependencies: PaneLaunchWorkflowDependencies) {}

  async create(
    prompt: string,
    agent?: AgentName,
    options?: PaneLaunchOptions,
  ): Promise<PaneCreateResponse> {
    const requestedProjectRoot = options?.projectRoot?.trim() || undefined;
    const paneTitle = options?.paneTitle?.trim() || undefined;
    const localTitle = paneTitle ? undefined : condenseTitleLocally(prompt) || undefined;
    if (!this.dependencies.hasActiveProjectContext()) {
      log.warn('bridge', 'Pane creation blocked: no active project context', {
        requestedProjectRoot,
      });
      return { success: false, error: NO_ACTIVE_PROJECT_MESSAGE };
    }

    if (!agent && !this.dependencies.hasAvailableAgentsCache()) {
      await this.dependencies.detectAvailableAgents();
    }
    const cachedAgents = this.dependencies.getAvailableAgents();
    const createStartedAt = Date.now();
    const targetProjectRoot = requestedProjectRoot || this.dependencies.getProjectRoot();
    const projectRootSource = requestedProjectRoot ? 'request' : 'session-default';
    const settings = SettingsManager.getInstance(targetProjectRoot).getSettings();
    const initGitIfMissing = settings.initGitIfMissing ?? true;
    const useWorktree = options?.useWorktree ?? settings.useWorktree ?? false;
    const resolvedAgent = agent
      ?? (settings.defaultAgent && cachedAgents.includes(settings.defaultAgent)
        ? settings.defaultAgent
        : cachedAgents.length === 1 ? cachedAgents[0] : undefined);
    const terminalProfile = resolvePaneTerminalProfile(resolvedAgent, {
      ...settings,
      ...(options?.claudeRenderer === 'classic' ? { claudeFullscreenRendering: false } : {}),
    });
    if (terminalProfile.claudeRenderer === 'fullscreen') {
      try {
        await assertClaudeFullscreenSupported();
      } catch (error) {
        return {
          success: false,
          claudeFullscreenPreflightFailed: true,
          error: formatError(error),
        };
      }
    }

    if (requestedProjectRoot && requestedProjectRoot !== this.dependencies.getProjectRoot()) {
      log.info('bridge', 'Pane creation targeting non-session project root', {
        requestedProjectRoot,
        sessionProjectRoot: this.dependencies.getProjectRoot(),
      });
    }

    if (useWorktree) {
      const gitBootstrapStartedAt = Date.now();
      const gitRepository = await ensureGitRepository(targetProjectRoot, {
        initIfMissing: initGitIfMissing,
      });
      log.info('bridge', 'Git repository check complete', {
        durationMs: Date.now() - gitBootstrapStartedAt,
        initialized: gitRepository.initialized,
        isReady: gitRepository.isReady,
        targetProjectRoot,
      });
      if (!gitRepository.isReady) {
        const errorMessage = initGitIfMissing
          ? `Failed to initialize Git repository in "${targetProjectRoot}". Disable worktree or initialize Git manually.`
          : `Git worktree requires a Git repository. Initialize Git in "${targetProjectRoot}" or enable auto Git initialization in settings.`;
        log.warn('bridge', 'Pane creation blocked: target project cannot provide git repository', {
          initGitIfMissing,
          requestedUseWorktree: useWorktree,
          targetProjectRoot,
        });
        return { success: false, error: errorMessage };
      }
      if (gitRepository.initialized) {
        log.info('bridge', 'Initialized git repository for pane creation', { targetProjectRoot });
        this.dependencies.sendToast(
          `Initialized Git repository in "${targetProjectRoot}"`,
          'info',
        );
      }
    }

    log.info('bridge', 'Creating pane', {
      agent,
      projectRootSource,
      promptLength: prompt.length,
      promptPreview: prompt.slice(0, 100),
      requestedProjectRoot,
      sendPromptToAgent: options?.sendPromptToAgent,
      sessionProjectRoot: this.dependencies.getProjectRoot(),
      targetProjectRoot,
      useWorktree,
    });
    this.dependencies.sendProgress('Creating pane...', true);
    let watcherSuspended = false;

    try {
      const controlPaneRefreshed = await this.dependencies.ensureValidControlPaneId();
      if (!controlPaneRefreshed) {
        await this.dependencies.publishSessionColorHint(this.dependencies.getSessionName());
      }
      watcherSuspended = true;
      this.dependencies.suspendPaneWatcher();

      const coreCreateStartedAt = Date.now();
      const result = await createCorePane({
        agent,
        agentPrompt: options?.agentPrompt ?? (options?.sendPromptToAgent === false ? '' : prompt),
        claudeRenderer: options?.claudeRenderer,
        controlPaneId: this.dependencies.getControlPaneId(),
        directWorktreeCreation: true,
        duel: options?.duel,
        earlyEmit: {
          onReady: (readyPane) => this.dependencies.emitEarlyPane(
            readyPane,
            options?.sourceBacklogId,
            paneTitle,
            localTitle,
          ),
          onRollback: (paneId) => this.dependencies.removeEarlyPane(paneId),
        },
        effort: options?.effort,
        enableActivityAdapters: this.dependencies.lifecycleAdaptersEnabled(),
        existingPanes: this.dependencies.getPanes(),
        initialPromptMode: 'argument',
        initialTerminalSize: this.dependencies.getInitialTerminalSize(),
        layoutMode: 'window',
        model: options?.model,
        otlpEndpoint: this.dependencies.getOtlpEndpoint(),
        projectName: basename(targetProjectRoot),
        projectRoot: targetProjectRoot,
        prompt,
        readOnly: options?.readOnly,
        resumeSessionId: options?.resumeSessionId,
        review: options?.review,
        role: options?.role,
        sessionConfigPath: this.dependencies.getConfigPath(),
        sessionName: this.dependencies.getSessionName(),
        sessionProjectRoot: this.dependencies.getProjectRoot(),
        skipHooks: true,
        slugBase: options?.slugBase,
        slugSuffix: options?.slugSuffix,
        terminalTranscriptDir: this.dependencies.getTerminalTranscriptDir(),
        useWorktree,
        worktreeSeedFile: options?.worktreeSeedFile,
        worktreeStartPoint: options?.worktreeStartPoint,
      }, cachedAgents);
      log.info('bridge', 'Core createPane completed', {
        durationMs: Date.now() - coreCreateStartedAt,
        needsAgentChoice: result.needsAgentChoice,
        totalElapsedMs: Date.now() - createStartedAt,
      });

      if (result.needsAgentChoice) {
        log.info('bridge', 'Pane creation needs agent choice', { availableAgents: cachedAgents });
        return { success: false, needsAgentChoice: true, availableAgents: cachedAgents };
      }

      const pane = this.dependencies.decorateCreatedPane(
        result.pane,
        options?.sourceBacklogId,
        paneTitle,
        localTitle,
      );
      log.info('bridge', 'Pane created successfully', {
        agent: pane.agent,
        branchName: pane.branchName,
        id: pane.id,
        paneId: pane.paneId,
        slug: pane.slug,
        worktreePath: pane.worktreePath,
      });

      this.dependencies.savePane(pane);
      if (!pane.titleLocked) {
        void this.dependencies.maybeRequestExperimentalPaneTitle(pane.id, prompt);
      }
      const monitorStartedAt = Date.now();
      try {
        if (await this.dependencies.startPaneMonitor(this.dependencies.getPanes())) {
          log.info('bridge', 'Pane monitor refreshed after create', {
            durationMs: Date.now() - monitorStartedAt,
            paneId: pane.id,
          });
        }
      } catch (error) {
        log.warn('bridge', 'Pane monitor refresh failed after pane creation', {
          error: formatError(error),
          paneId: pane.id,
        });
      }

      triggerHook('pane_created', this.dependencies.getProjectRoot(), result.pane).catch((error) => {
        log.debug('bridge', 'pane_created hook failed', { error: String(error) });
      });
      if (result.pane.worktreePath) {
        triggerHook('worktree_created', this.dependencies.getProjectRoot(), result.pane)
          .catch((error) => {
            log.debug('bridge', 'worktree_created hook failed', { error: String(error) });
          });
      }
      this.dependencies.startSessionTracking(pane);
      log.info('bridge', 'Pane create flow complete', {
        paneId: pane.id,
        totalElapsedMs: Date.now() - createStartedAt,
      });
      return { success: true, pane };
    } catch (error) {
      log.error('bridge', 'Pane creation failed', {
        error,
        totalElapsedMs: Date.now() - createStartedAt,
      });
      return {
        success: false,
        claudeFullscreenPreflightFailed: error instanceof Error
          && error.name === 'ClaudeFullscreenVersionError',
        error: formatError(error),
      };
    } finally {
      if (watcherSuspended) this.dependencies.resumePaneWatcher();
      this.dependencies.sendProgress('Creating pane...', false);
    }
  }

  async createTerminal(projectRoot?: string): Promise<PaneCreateResponse> {
    const requestedProjectRoot = projectRoot?.trim() || undefined;
    if (!this.dependencies.hasActiveProjectContext()) {
      log.warn('bridge', 'Terminal creation blocked: no active project context', {
        requestedProjectRoot,
      });
      return { success: false, error: NO_ACTIVE_PROJECT_MESSAGE };
    }

    const targetProjectRoot = requestedProjectRoot || this.dependencies.getProjectRoot();
    const targetProjectName = basename(targetProjectRoot);
    log.info('bridge', 'Creating terminal-only pane');
    this.dependencies.sendProgress('Creating terminal...', true);
    let allocatedPaneId: string | undefined;
    let panePersisted = false;
    let watcherSuspended = false;

    try {
      await this.dependencies.ensureValidControlPaneId();
      watcherSuspended = true;
      this.dependencies.suspendPaneWatcher();

      const slug = `shell-${Date.now()}`;
      const paneId = await this.dependencies.newWindowPane({
        cwd: targetProjectRoot,
        sessionName: this.dependencies.getSessionName(),
      });
      allocatedPaneId = paneId;
      const transcriptPath = await this.dependencies.setupTranscriptPiping(
        paneId,
        undefined,
        'shell',
      );
      await this.dependencies.setPaneTitleSafe(paneId, slug);
      const pane: AumxPane = {
        id: `aumx-${Date.now()}`,
        paneId,
        projectName: targetProjectName,
        projectRoot: targetProjectRoot,
        prompt: '',
        slug,
        terminalTranscriptPath: transcriptPath,
        type: 'shell',
      };

      this.dependencies.savePane(pane);
      panePersisted = true;
      try {
        await this.dependencies.startPaneMonitor(this.dependencies.getPanes());
      } catch (error) {
        log.warn('bridge', 'Pane monitor refresh failed after terminal creation', {
          error: formatError(error),
          paneId,
        });
      }
      return { success: true, pane };
    } catch (error) {
      log.error('bridge', 'Terminal pane creation failed', error);
      if (allocatedPaneId && !panePersisted) {
        try {
          await this.dependencies.killPane(allocatedPaneId);
        } catch (cleanupError) {
          log.warn('bridge', 'Failed to clean up uncommitted terminal pane', {
            error: formatError(cleanupError),
            paneId: allocatedPaneId,
          });
        }
      }
      return { success: false, error: formatError(error) };
    } finally {
      if (watcherSuspended) this.dependencies.resumePaneWatcher();
      this.dependencies.sendProgress('Creating terminal...', false);
    }
  }

  async duplicate(paneId: string): Promise<PaneCreateResponse> {
    const pane = this.dependencies.getPanes().find((candidate) => candidate.id === paneId);
    if (!pane) return { success: false, error: 'Pane not found' };
    log.info('bridge', 'Duplicating pane', {
      agent: pane.agent,
      paneId,
      slug: pane.slug,
    });
    return this.dependencies.createPaneCoordinated(
      pane.prompt || '',
      pane.agent as AgentName | undefined,
    );
  }
}
