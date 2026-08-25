import { is } from '@electron-toolkit/utils';
import { BrowserWindow } from 'electron';
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'os';
import { basename, dirname, resolve } from 'path';
import {
  atomicWriteJsonSync,
  clearConflictMergeTransactionById,
  conflictMergeTransactionFromMetadata,
  disposeManagedConflictResolutionPane,
  hasManagedConflictPane,
  closePane,
  condenseTitleLocally,
  ensureTmuxPaneIncarnationOption,
  ensureMuxBaseGitignore,
  execAsync,
  getPaneActivityJournalPath,
  getConflictMergeTransaction,
  getProjectConfigPath,
  getRunningAgentPanes,
  getStatusDetector,
  isAgentRunningInPane,
  listConflictMergeTransactions,
  markConflictMergeResolvedAfterVerification,
  LogService,
  normalizeAutomaticPaneTitle,
  parseMuxBaseConfig,
  reconcilePaneWorktrees,
  registerConflictMergeTransaction,
  registerManagedConflictPane,
  releaseManagedConflictPane,
  removeCodexActivityHookSettings,
  removeOpenCodeActivityPlugin,
  removePaneActivityJournal,
  removePiActivityExtension,
  scanConflictMergeRecovery,
  startConflictMonitoring,
  StateManager,
  shQuote,
  type ActionContext,
  type AgentCapability,
  type AgentName,
  type MuxBaseConfig,
  type MuxBasePane,
  type PaneAgentProbe,
  PaneStreamStatusWatcher,
  type StatusUpdateEvent,
  TmuxService,
  triggerHook,
} from 'muxbase/core';
import { SESSION_PARSING_AGENTS } from '../../shared/agent-session-types.js';
import { IPC_EVENT } from '../../shared/ipc-channels.js';
import {
  shouldConsumeLifecycleAdapterEvents,
  type ActivitySnapshot,
  type PaneActivity,
  type PaneActivityChangedEvent,
} from '../../shared/pane-activity.js';
import type {
  AgentSessionSearchResult,
  ElectronSettings,
  PaneAttachWorktreeResponse,
  PaneCreateResponse,
  PaneCreateWorktreeResponse,
  PaneDuelCreateResponse,
  PaneDuelResolveResponse,
  PaneSendFixResponse,
  PaneSessionListResponse,
  PaneStartReviewResponse,
  SerializableActionResult,
  WorktreeInspectResponse,
  WorktreeOrphansListResponse,
  WorktreeRemovalState,
  WorktreeRemoveResponse,
} from '../../shared/ipc-types.js';
import type { PaneTopics } from '../../shared/topic-types.js';
import { formatError } from '../utils/formatError.js';
import { getTranscriptDir, setupTmuxTranscript } from '../utils/tmux-transcript.js';
import { ensureTmuxSession, publishSessionColorHint } from '../utils/tmuxSession.js';
import { ActionCallbackRegistry } from './ActionCallbackRegistry.js';
import { AgentCatalog } from './bridge/AgentCatalog.js';
import { DuelWorkflow, type DuelRequest } from './bridge/DuelWorkflow.js';
import { PaneActionWorkflow } from './bridge/PaneActionWorkflow.js';
import { PaneLaunchWorkflow, type PaneLaunchOptions } from './bridge/PaneLaunchWorkflow.js';
import { PaneSessionCatalog } from './bridge/PaneSessionCatalog.js';
import { ReviewWorkflow } from './bridge/ReviewWorkflow.js';
import { WorktreeWorkflow } from './bridge/WorktreeWorkflow.js';
import { AgentSessionService, type HarvestedTitle } from './agent-session/AgentSessionService.js';
import { AgentLivenessProbe } from './AgentLivenessProbe.js';
import { ClaudeCodeOtlpReceiver } from './agent-session/ClaudeCodeOtlpReceiver.js';
import { ElectronSettingsService } from './ElectronSettingsService.js';
import { ConfigBridge } from './ConfigBridge.js';
import { FileBrowserWatchService } from './FileBrowserWatchService.js';
import { KanbanPersistenceService } from './KanbanPersistenceService.js';
import { log } from './Logger.js';
import { PaneMonitor } from './PaneMonitor.js';
import { PaneActivityService } from './PaneActivityService.js';
import { PaneActivityJournalReader } from './PaneActivityJournalReader.js';
import { PaneActivityProjection } from './PaneActivityProjection.js';
import { DetachedTranscriptActivityTailer } from './DetachedTranscriptActivityTailer.js';
import { PaneSummaryService } from './PaneSummaryService.js';
import { PaneWatcher } from './PaneWatcher.js';
import { ProjectOperationCoordinator } from './ProjectOperationCoordinator.js';
import { discoverCurrentProject } from './ProjectDiscovery.js';
import { reapOrphanTranscripts, TRANSCRIPT_RETENTION_MS } from './transcript-reaper.js';
import { sweepTranscriptRollovers } from './transcript-rollover.js';
import { submitTerminalCommand } from './terminal-input.js';
import { displayPaneFormat } from './terminal-stream-state.js';
import { requestExperimentalOpenRouterTitle } from './title/ExperimentalOpenRouterTitle.js';
import { detachTerminalPane, getPreferredTerminalLaunchSize, getTerminalManager, resetTerminalManager } from './TerminalStreamService.js';

interface ProjectSwitchOptions {
  fresh?: boolean;
}

interface InitializeOptions {
  availableAgents?: AgentName[];
  signal?: AbortSignal;
}

const TRANSCRIPT_ROLLOVER_INTERVAL_MS = 60_000;

interface BootServicesOptions {
  availableAgents?: AgentName[];
  fresh?: boolean;
  signal?: AbortSignal;
}

const DEFAULT_CONTROL_PANE_SIZE = 40;
const ACTIVE_CONFLICT_PROJECT_SWITCH_MESSAGE = 'Resolve or abort active conflict merges before switching projects.';
const PANE_CURRENT_PATH_FORMAT = '#{pane_current_path}';
export class MuxBaseBridge {
  private static instance: MuxBaseBridge;
  private window: BrowserWindow | null = null;
  private tmuxService: TmuxService;
  private stateManager: StateManager;
  private readonly agentCatalog = new AgentCatalog();
  private readonly paneSessionCatalog = new PaneSessionCatalog();
  private controlPaneId: string | null = null;
  private projectRoot: string = '';
  private projectName: string = '';
  private sessionName: string = '';
  private configPath: string = '';
  private callbackRegistry: ActionCallbackRegistry;
  private readonly projectOperations = new ProjectOperationCoordinator();
  private switching = false;
  private paneMonitor: PaneMonitor | null = null;
  private paneActivityService: PaneActivityService | null = null;
  private activitySweepInterval: ReturnType<typeof setInterval> | null = null;
  private activityJournalInterval: ReturnType<typeof setInterval> | null = null;
  private activityLivenessInterval: ReturnType<typeof setInterval> | null = null;
  private transcriptRolloverInterval: ReturnType<typeof setInterval> | null = null;
  private transcriptRolloverSweep: Promise<void> | null = null;
  private readonly agentLivenessProbe = new AgentLivenessProbe();
  private readonly activityJournalReader = new PaneActivityJournalReader();
  private activityJournalReadInFlight = false;
  private readonly paneStreamStatusWatchers = new Map<string, PaneStreamStatusWatcher>();
  private readonly lastStreamActivityAt = new Map<string, number>();
  private readonly detachedTranscriptActivityTailer = new DetachedTranscriptActivityTailer();
  private paneWatcher: PaneWatcher | null = null;
  private configBridge: ConfigBridge | null = null;
  private agentSessionService: AgentSessionService | null = null;
  private otlpReceiver: ClaudeCodeOtlpReceiver | null = null;
  private inFlightHandoffIds = new Set<string>();
  private inFlightReviewSourceIds = new Set<string>();
  private inFlightFullscreenResumePaneIds = new Set<string>();
  private paneSummaryService: PaneSummaryService | null = null;
  private fileBrowserWatchService: FileBrowserWatchService;
  private corePaneCreationLogForwarder: ((entry: unknown) => void) | null = null;
  private worktreeMutationPaths = new Set<string>();
  private untrackablePanes = new Set<string>();
  private readonly paneActivityProjection: PaneActivityProjection;
  private readonly duelWorkflow: DuelWorkflow;
  private readonly paneActionWorkflow: PaneActionWorkflow;
  private readonly paneLaunchWorkflow: PaneLaunchWorkflow;
  private readonly reviewWorkflow: ReviewWorkflow;
  private readonly worktreeWorkflow: WorktreeWorkflow;

  private constructor() {
    this.tmuxService = TmuxService.getInstance();
    this.stateManager = StateManager.getInstance();
    this.callbackRegistry = new ActionCallbackRegistry();
    this.fileBrowserWatchService = new FileBrowserWatchService(this.window);
    this.paneActivityProjection = new PaneActivityProjection(() => this.paneActivityService);
    this.paneLaunchWorkflow = new PaneLaunchWorkflow({
      createPaneCoordinated: (prompt, agent, options) => this.createPane(prompt, agent, options),
      decorateCreatedPane: (pane, sourceBacklogId, paneTitle, localTitle) => (
        this.decorateCreatedPane(pane, sourceBacklogId, paneTitle, localTitle)
      ),
      detectAvailableAgents: async () => {
        await this.detectAvailableAgents(false);
      },
      emitEarlyPane: (pane, sourceBacklogId, paneTitle, localTitle) => (
        this.emitEarlyPane(pane, sourceBacklogId, paneTitle, localTitle)
      ),
      ensureValidControlPaneId: () => this.ensureValidControlPaneId(),
      getAvailableAgents: () => this.agentCatalog.getCached(),
      getConfigPath: () => this.configPath,
      getControlPaneId: () => this.controlPaneId || undefined,
      getInitialTerminalSize: () => getPreferredTerminalLaunchSize() ?? undefined,
      getOtlpEndpoint: () => this.getOtlpEndpoint(),
      getPanes: () => this.stateManager.getPanes(),
      getProjectRoot: () => this.projectRoot,
      getSessionName: () => this.sessionName,
      getTerminalTranscriptDir: () => this.getTerminalTranscriptDir(),
      hasActiveProjectContext: () => this.hasActiveProjectContext(),
      hasAvailableAgentsCache: () => this.agentCatalog.hasCached(),
      killPane: (paneId) => this.tmuxService.killPane(paneId),
      lifecycleAdaptersEnabled: () => this.areAgentLifecycleAdaptersEnabled(),
      maybeRequestExperimentalPaneTitle: (paneId, sourceText) => (
        this.maybeRequestExperimentalPaneTitle(paneId, sourceText)
      ),
      newWindowPane: (options) => this.tmuxService.newWindowPane(options),
      publishSessionColorHint: (sessionName) => publishSessionColorHint(sessionName),
      removeEarlyPane: (paneId) => this.removePaneFromConfigAndState(paneId),
      resumePaneWatcher: () => this.paneWatcher?.resumeSync(),
      savePane: (pane) => this.savePaneToConfig(pane),
      sendProgress: (action, active) => this.sendProgress(action, active),
      sendToast: (message, type) => this.sendToast(message, type),
      setPaneTitleSafe: (paneId, title) => this.setPaneTitleSafe(paneId, title),
      setupTranscriptPiping: (paneId, existingPath, prefix) => (
        this.setupTranscriptPiping(paneId, existingPath, prefix)
      ),
      startPaneMonitor: async (panes) => {
        if (!this.paneMonitor) return false;
        await this.paneMonitor.start(panes);
        return true;
      },
      startSessionTracking: (pane) => {
        this.agentSessionService?.onPaneCreated(pane).catch((error) => {
          log.debug('bridge', 'Agent session tracking failed to start', {
            error: String(error),
          });
        });
      },
      suspendPaneWatcher: () => this.paneWatcher?.suspendSync(),
    });
    this.duelWorkflow = new DuelWorkflow({
      buildActionContext: () => this.buildActionContext(),
      closePane: (pane, context) => closePane(pane, context),
      createPane: (prompt, agent, options) => this.createPane(prompt, agent, options),
      getPane: (paneId) => this.stateManager.getPaneById(paneId),
      getPanes: () => this.stateManager.getPanes(),
      getProjectRoot: () => this.projectRoot,
      hasActiveProjectContext: () => this.hasActiveProjectContext(),
      reapOrphanedTranscripts: () => this.reapOrphanedTranscripts(),
      replacePanesBestEffort: (panes) => {
        this.stateManager.updatePanes(panes);
        this.persistPanesToConfig(panes);
        this.notifyPaneListChanged();
      },
      setProgress: (action, active) => this.sendProgress(action, active),
    });
    this.paneActionWorkflow = new PaneActionWorkflow({
      addPaneToDone: (pane) => this.addPaneToDone(pane),
      buildActionContext: () => this.buildActionContext(),
      clearDuelMetadata: (paneIds) => this.duelWorkflow.clearMetadata(paneIds),
      getConfigPath: () => this.configPath,
      getPane: (paneId) => this.stateManager.getPaneById(paneId),
      getPaneCurrentCommand: (paneId) => this.tmuxService.getPaneCurrentCommand(paneId),
      getPanes: () => this.stateManager.getPanes(),
      getProjectRoot: () => this.projectRoot,
      paneExists: (paneId) => this.tmuxService.paneExists(paneId),
      persistPanesTransactionally: (panes) => {
        this.persistPanesToConfigOrThrow(panes);
        this.stateManager.updatePanes(panes);
        this.notifyPaneListChanged();
      },
      reapOrphanedTranscripts: () => this.reapOrphanedTranscripts(),
    }, this.inFlightFullscreenResumePaneIds);
    this.reviewWorkflow = new ReviewWorkflow({
      captureReadinessTokenFor: (paneId) => (
        this.paneActivityProjection.captureReadinessTokenFor(paneId)
      ),
      createPane: (prompt, agent, options) => this.createPane(prompt, agent, options),
      getAvailableAgents: () => this.agentCatalog.getCached(),
      getPane: (paneId) => this.stateManager.getPaneById(paneId),
      getPaneActivity: (paneId) => this.paneActivityProjection.getPaneActivity(paneId),
      getPanes: () => this.stateManager.getPanes(),
      getProjectRoot: () => this.projectRoot,
      getSession: (paneId) => this.agentSessionService?.getSession(paneId) ?? null,
      replacePanesBestEffort: (panes) => {
        this.stateManager.updatePanes(panes);
        this.persistPanesToConfig(panes);
        this.notifyPaneListChanged();
      },
      revalidateReadinessOrReject: (pane, token, blockReason, notFoundReason) => (
        this.paneActivityProjection.revalidateReadinessOrReject(
          pane,
          token,
          blockReason,
          notFoundReason,
        )
      ),
      sendPromptToPane: (paneId, prompt) => this.sendPromptToPane(paneId, prompt),
      setProgress: (action, active) => this.sendProgress(action, active),
    }, this.inFlightReviewSourceIds, this.inFlightHandoffIds);
    this.worktreeWorkflow = new WorktreeWorkflow({
      ensureValidControlPaneId: async () => {
        await this.ensureValidControlPaneId();
      },
      getPane: (paneId) => this.stateManager.getPaneById(paneId),
      getPanes: () => this.stateManager.getPanes(),
      getProjectName: () => this.projectName,
      getProjectRoot: () => this.projectRoot,
      getSessionName: () => this.sessionName,
      hasActiveProjectContext: () => this.hasActiveProjectContext(),
      killPane: (paneId) => this.tmuxService.killPane(paneId),
      newWindowPane: (options) => this.tmuxService.newWindowPane(options),
      replacePanesBestEffort: (panes) => {
        this.stateManager.updatePanes(panes);
        this.persistPanesToConfig(panes);
        this.notifyPaneListChanged();
      },
      resumePaneWatcher: () => this.paneWatcher?.resumeSync(),
      saveReopenedPane: (pane) => this.saveReopenedWorktreePaneToConfig(pane),
      sendProgress: (action, active) => this.sendProgress(action, active),
      sendShellCommand: (paneId, command) => this.tmuxService.sendShellCommand(paneId, command),
      sendTmuxKeys: (paneId, keys) => this.tmuxService.sendTmuxKeys(paneId, keys),
      sendToast: (message, type) => this.sendToast(message, type),
      setPaneTitleSafe: (paneId, title) => this.setPaneTitleSafe(paneId, title),
      setupTranscriptPiping: (paneId, existingPath, prefix) => (
        this.setupTranscriptPiping(paneId, existingPath, prefix)
      ),
      startPaneMonitor: async (panes) => {
        if (this.paneMonitor) await this.paneMonitor.start(panes);
      },
      suspendPaneWatcher: () => this.paneWatcher?.suspendSync(),
    }, this.worktreeMutationPaths);
  }

  static getInstance(): MuxBaseBridge {
    if (!MuxBaseBridge.instance) {
      MuxBaseBridge.instance = new MuxBaseBridge();
    }
    return MuxBaseBridge.instance;
  }

  setWindow(win: BrowserWindow): void {
    this.window = win;
    if (this.paneWatcher) this.paneWatcher.setWindow(win);
    if (this.configBridge) this.configBridge.setWindow(win);
    if (this.agentSessionService) this.agentSessionService.setWindow(win);
    this.fileBrowserWatchService.setWindow(win);
  }

  getWindow(): BrowserWindow | null {
    return this.window;
  }

  syncWindowVisibility(): void {
    this.agentSessionService?.syncWindowVisibility();
  }

  setTelemetryCostTrackingEnabled(enabled: boolean): void {
    if (!this.otlpReceiver) return;
    if (enabled) {
      this.otlpReceiver.start().catch((err) => {
        log.warn('bridge', 'Failed to start OTLP receiver', { error: String(err) });
      });
    } else {
      this.otlpReceiver.stop().catch((err) => {
        log.warn('bridge', 'Failed to stop OTLP receiver', { error: String(err) });
      });
    }
  }

  private getOtlpEndpoint(): string | undefined {
    const port = this.otlpReceiver?.getPort();
    return port ? `http://127.0.0.1:${port}` : undefined;
  }

  private areAgentLifecycleAdaptersEnabled(): boolean {
    try {
      return ElectronSettingsService.getInstance().get('enableAgentLifecycleAdapters') === true;
    } catch {
      return false;
    }
  }

  private initialAdapterHealth(pane: MuxBasePane): PaneActivity['adapterHealth'] {
    if (pane.agent === 'claude') return 'degraded';
    if ((pane.agent === 'codex' || pane.agent === 'opencode' || pane.agent === 'pi') && this.areAgentLifecycleAdaptersEnabled()) {
      return 'degraded';
    }
    return 'absent';
  }

  setAgentLifecycleAdaptersEnabled(enabled: boolean): void {
    if (enabled) return;
    removeCodexActivityHookSettings();
    removeOpenCodeActivityPlugin();
    removePiActivityExtension();
    for (const pane of this.stateManager.getPanes()) {
      if (pane.agent === 'claude') continue;
      this.paneActivityService?.setAdapterHealth(pane.id, 'absent');
    }
  }

  async syncPanes(): Promise<void> {
    await this.paneWatcher?.syncPanes();
  }

  private registerPersistedConflictMergeOwnership(): void {
    const panes = this.stateManager.getPanes();
    const context = this.buildActionContext();
    const registeredRepositories = new Set<string>();

    for (const pane of panes) {
      const metadata = pane.conflictMerge;
      if (!metadata) continue;
      const repositoryKey = resolve(metadata.repoPath);
      if (registeredRepositories.has(repositoryKey)) continue;
      registeredRepositories.add(repositoryKey);

      const transaction = getConflictMergeTransaction(metadata.repoPath)
        || registerConflictMergeTransaction(conflictMergeTransactionFromMetadata(metadata));
      if (hasManagedConflictPane(transaction.id)) continue;

      const creation = {
        pane,
        preparation: {
          repoPath: transaction.repoPath,
          sourceCommit: transaction.sourceCommit,
          targetCommit: transaction.targetCommit,
        },
      };
      const stopMonitoring = startConflictMonitoring({
        conflictPaneId: pane.paneId,
        expectedCommits: {
          sourceCommit: transaction.sourceCommit,
          targetCommit: transaction.targetCommit,
        },
        onResolved: async () => {
          if (!markConflictMergeResolvedAfterVerification(transaction.id)) return;
          const disposal = await disposeManagedConflictResolutionPane(transaction, false, {
            retainRegistration: true,
          });
          if (!disposal?.success) {
            this.sendToast(
              `Conflict merge completed, but pane cleanup failed: ${disposal?.error || 'managed owner unavailable'}`,
              'error',
            );
            return;
          }
          clearConflictMergeTransactionById(transaction.id);
          releaseManagedConflictPane(transaction.id);
          this.sendToast(
            `Conflict merge completed for ${pane.slug}. Merge the source pane to finish integration.`,
            'info',
          );
        },
        onAbandoned: async (reason) => {
          const disposal = await disposeManagedConflictResolutionPane(transaction, true);
          if (!disposal?.success) {
            this.sendToast(
              `Conflict resolution requires attention: ${disposal?.error || reason}`,
              'error',
            );
            return;
          }
          this.sendToast(`Conflict resolution closed safely: ${reason}`, 'warning');
        },
        repoPath: transaction.repoPath,
      });
      registerManagedConflictPane(transaction, { context, creation, stopMonitoring });
    }
  }

  async disposeConflictMergesForShutdown(): Promise<{
    success: boolean;
    failures: Array<{ transactionId: string; repoPath: string; error: string }>;
  }> {
    this.registerPersistedConflictMergeOwnership();
    const failures: Array<{ transactionId: string; repoPath: string; error: string }> = [];
    for (const transaction of listConflictMergeTransactions().filter((candidate) => candidate.state === 'active')) {
      const disposal = await disposeManagedConflictResolutionPane(transaction, true);
      if (!disposal?.success) {
        failures.push({
          transactionId: transaction.id,
          repoPath: transaction.repoPath,
          error: disposal?.error || 'Conflict pane owner is unavailable',
        });
      }
    }
    return { success: failures.length === 0, failures };
  }

  getActiveConflictMergeCount(): number {
    this.registerPersistedConflictMergeOwnership();
    return listConflictMergeTransactions().filter((candidate) => candidate.state === 'active').length;
  }

  async notifyConflictMergeRecovery(): Promise<void> {
    this.registerPersistedConflictMergeOwnership();
    const persistedRepositories = new Set(
      this.stateManager.getPanes()
        .flatMap((pane) => pane.conflictMerge ? [resolve(pane.conflictMerge.repoPath)] : []),
    );
    const recoveries = await scanConflictMergeRecovery(this.stateManager.getPanes());
    for (const recovery of recoveries) {
      if (persistedRepositories.has(resolve(recovery.repoPath))) continue;
      const files = recovery.unmergedFiles.length > 0
        ? ` Unresolved files: ${recovery.unmergedFiles.slice(0, 3).join(', ')}.`
        : '';
      this.sendToast(
        `Interrupted conflict merge detected for pane ${recovery.paneId}.${files} Use Merge to resume or Close to abort safely.`,
        'warning',
      );
      log.warn('bridge', 'Detected interrupted conflict merge during startup', recovery);
    }
  }

  async initialize(options: InitializeOptions = {}): Promise<void> {
    LogService.getInstance().setSuppressConsole(true);
    this.attachCorePaneCreationLogForwarder();

    if (is.dev) {
      process.env.MUXBASE_DEV = 'true';
    }

    log.info('bridge', 'Initializing MuxBaseBridge...');

    try {
      options.signal?.throwIfAborted();
      await this.discoverProject();
      options.signal?.throwIfAborted();
      log.info('bridge', 'Project discovered', {
        projectName: this.projectName,
        sessionName: this.sessionName,
        projectRoot: this.projectRoot,
        configPath: this.configPath,
      });

      if (!this.projectRoot) {
        log.info('bridge', 'No valid project detected; deferring service boot');
        return;
      }

      this.stateManager.updateProjectInfo(
        this.projectName,
        this.sessionName,
        this.projectRoot,
        this.configPath,
      );

      await this.bootServices({
        availableAgents: options.availableAgents,
        signal: options.signal,
      });
      options.signal?.throwIfAborted();

      log.info('bridge', 'MuxBaseBridge initialization complete');
    } catch (error) {
      try {
        await this.shutdown();
      } catch (shutdownError) {
        log.warn('bridge', 'Failed to roll back partial initialization', {
          error: String(shutdownError),
        });
      }
      throw error;
    }
  }

  async switchProject(newProjectRoot: string, options: ProjectSwitchOptions = {}): Promise<void> {
    await this.projectOperations.runSwitch(() => this.switchProjectUnlocked(newProjectRoot, options));
  }

  private async switchProjectUnlocked(
    newProjectRoot: string,
    options: ProjectSwitchOptions,
  ): Promise<void> {
    const fresh = options.fresh === true;
    if (!fresh && newProjectRoot === this.projectRoot) return;
    if (this.getActiveConflictMergeCount() > 0) {
      throw new Error(ACTIVE_CONFLICT_PROJECT_SWITCH_MESSAGE);
    }
    this.switching = true;
    log.info('bridge', 'Switching project', { fresh, from: this.projectRoot, to: newProjectRoot });

    try {
      // The switch coordinator is already held here, so active project
      // mutations have completed before their terminal streams are destroyed.
      resetTerminalManager();

      // 1. Tear down log forwarder + existing services
      await this.teardownProjectServices();

      // 2. Purge stale action callbacks
      this.callbackRegistry.cleanup();
      this.callbackRegistry = new ActionCallbackRegistry();
      this.worktreeMutationPaths.clear();
      this.untrackablePanes.clear();
      this.inFlightHandoffIds.clear();
      this.inFlightReviewSourceIds.clear();

      // 3. Update project fields
      this.projectRoot = newProjectRoot;
      this.projectName = basename(newProjectRoot);
      this.sessionName = `muxbase-${this.projectName}`;
      this.configPath = getProjectConfigPath(newProjectRoot);

      // 4. Update StateManager (bootServices reloads panes from the new config)
      this.stateManager.updatePanes([]);
      this.stateManager.updateProjectInfo(
        this.projectName,
        this.sessionName,
        this.projectRoot,
        this.configPath,
      );

      if (fresh) {
        await this.resetFreshTmuxSession();
      }

      // 5. Boot services (same flow as initialize)
      this.attachCorePaneCreationLogForwarder();
      await this.bootServices({ fresh });

      this.notifyPaneListChanged();
      log.info('bridge', 'Project switch complete', {
        projectName: this.projectName,
        sessionName: this.sessionName,
        paneCount: this.stateManager.getPanes().length,
      });
    } catch (error) {
      log.error('bridge', 'Project switch failed; clearing partial project state', {
        error,
        projectRoot: newProjectRoot,
      });
      try {
        await this.teardownProjectServices();
      } catch (cleanupError) {
        log.warn('bridge', 'Failed to fully clean up an incomplete project switch', {
          error: String(cleanupError),
        });
      }
      this.controlPaneId = null;
      this.agentCatalog.clear();
      this.clearProjectContext();
      this.stateManager.updatePanes([]);
      this.stateManager.updateProjectInfo('', '', '', '');
      this.notifyPaneListChanged();
      throw error;
    } finally {
      this.switching = false;
    }
  }

  private async teardownProjectServices(): Promise<void> {
    this.detachCorePaneCreationLogForwarder();
    if (this.paneMonitor) {
      await this.paneMonitor.stop();
      this.paneMonitor = null;
    }
    if (this.activitySweepInterval) {
      clearInterval(this.activitySweepInterval);
      this.activitySweepInterval = null;
    }
    if (this.activityJournalInterval) {
      clearInterval(this.activityJournalInterval);
      this.activityJournalInterval = null;
    }
    if (this.activityLivenessInterval) {
      clearInterval(this.activityLivenessInterval);
      this.activityLivenessInterval = null;
    }
    if (this.transcriptRolloverInterval) {
      clearInterval(this.transcriptRolloverInterval);
      this.transcriptRolloverInterval = null;
    }
    if (this.transcriptRolloverSweep) {
      await this.transcriptRolloverSweep;
    }
    this.agentLivenessProbe.reset();
    this.activityJournalReader.reset();
    this.detachedTranscriptActivityTailer.reset();
    this.paneStreamStatusWatchers.clear();
    this.lastStreamActivityAt.clear();
    this.paneActivityService?.dispose();
    this.paneActivityService = null;
    if (this.paneWatcher) {
      await this.paneWatcher.stop();
      this.paneWatcher = null;
    }
    if (this.configBridge) {
      await this.configBridge.stop();
      this.configBridge = null;
    }
    if (this.agentSessionService) {
      this.agentSessionService.shutdown();
      this.agentSessionService = null;
    }
    if (this.paneSummaryService) {
      await this.paneSummaryService.dispose();
      this.paneSummaryService = null;
    }
    if (this.otlpReceiver) {
      await this.otlpReceiver.stop();
      this.otlpReceiver = null;
    }
    await this.fileBrowserWatchService.stop();
  }

  private async bootServices(options: BootServicesOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    await ensureMuxBaseGitignore(this.projectRoot);
    options.signal?.throwIfAborted();
    this.ensureConfigFile();

    const fresh = options.fresh === true;
    if (fresh) {
      this.resetConfigForFreshProject();
    }

    const cachedConfig = fresh ? null : this.readConfig();
    this.controlPaneId = cachedConfig?.controlPaneId ?? null;
    if (!this.controlPaneId) {
      this.controlPaneId = await this.queryControlPaneId();
      options.signal?.throwIfAborted();
    }
    await this.ensureValidControlPaneId({ reassertMetadata: true });
    options.signal?.throwIfAborted();
    log.info('bridge', 'Control pane ID', { controlPaneId: this.controlPaneId });

    // window-size manual is already set by ensureTmuxSession's setSessionMetadata
    // (invoked by ensureValidControlPaneId above), so no separate set-option here.

    if (options.availableAgents) {
      this.updateAvailableAgentsCache(options.availableAgents);
      log.info('bridge', 'Available agents reused from startup', { agents: this.agentCatalog.getCached() });
    } else {
      this.agentCatalog.clear();
      void this.detectAvailableAgents(false).then(
        (agents) => log.info('bridge', 'Available agents detected', { agents }),
        (error) => log.warn('bridge', 'Deferred agent discovery failed', { error: String(error) }),
      );
    }

    this.paneActivityService = new PaneActivityService();
    this.paneActivityService.on('changed', this.handlePaneActivityChanged);
    this.activitySweepInterval = setInterval(() => {
      this.paneActivityService?.sweep();
    }, 1_000);
    this.activitySweepInterval.unref?.();
    // Hooks append tiny, bounded records. A 10 Hz filesystem-only reader keeps
    // lifecycle latency under the adapter budget without increasing tmux load.
    this.activityJournalInterval = setInterval(() => {
      void this.readPaneActivityJournals();
    }, 100);
    this.activityJournalInterval.unref?.();
    this.activityLivenessInterval = setInterval(() => {
      void this.probePaneActivityLiveness();
    }, 2_000);
    this.activityLivenessInterval.unref?.();
    this.transcriptRolloverInterval = setInterval(() => {
      void this.rolloverOversizedTranscripts();
    }, TRANSCRIPT_ROLLOVER_INTERVAL_MS);
    this.transcriptRolloverInterval.unref?.();
    this.paneMonitor = new PaneMonitor(
      (event) => this.handleDetectedPaneStatus(event),
    );
    const bootConfigPath = this.configPath;
    this.paneWatcher = new PaneWatcher(
      this.window,
      this.configPath,
      this.controlPaneId,
      (paneId) => {
        this.agentSessionService?.onPaneDestroyed(paneId);
        getStatusDetector().removePane(paneId);
        this.untrackablePanes.delete(paneId);
        this.removePaneActivity(paneId);
      },
      (panes) => this.persistReboundPanes(panes, bootConfigPath),
    );
    this.configBridge = new ConfigBridge(this.window, this.configPath, this.paneWatcher);

    await this.paneWatcher.start();
    options.signal?.throwIfAborted();
    await this.configBridge.start();
    options.signal?.throwIfAborted();

    const configPanes = cachedConfig?.panes ?? [];
    let panes: MuxBasePane[];
    if (configPanes.length > 0) {
      const reconciled = await reconcilePaneWorktrees(configPanes, this.projectRoot);
      options.signal?.throwIfAborted();
      if (reconciled.attached > 0) {
        log.info('bridge', 'Reconciled orphaned panes to worktrees', { count: reconciled.attached });
      }
      panes = this.backfillMissingPaneTitles(await this.resurrectPanes(reconciled.panes));
      options.signal?.throwIfAborted();
      this.stateManager.updatePanes(panes);
      this.persistPanesToConfig(panes);
    } else {
      panes = this.stateManager.getPanes();
    }
    log.info('bridge', 'Panes loaded', { count: panes.length });

    await this.registerPaneActivity(panes);
    void this.probePaneActivityLiveness();

    if (panes.length > 0) {
      await this.paneMonitor.start(panes);
      options.signal?.throwIfAborted();
    }

    // Claude Code OTLP telemetry receiver — captures real cost from Claude Code's own metrics.
    let settings: ElectronSettings | null = null;
    try {
      settings = ElectronSettingsService.getInstance().getAll();
    } catch (err) {
      // Settings service unavailable in test contexts; telemetry defaults on, remote analysis off.
      log.debug('bridge', 'Settings unavailable, using boot defaults', { error: String(err) });
    }
    const telemetryEnabled = settings?.enableTelemetryCostTracking ?? true;
    // Stop any prior receiver (project switch / re-boot) before replacing it,
    // otherwise the previous localhost HTTP server keeps running and we leak ports.
    if (this.otlpReceiver) {
      await this.otlpReceiver.stop();
      options.signal?.throwIfAborted();
    }
    this.otlpReceiver = new ClaudeCodeOtlpReceiver();
    if (telemetryEnabled) {
      try {
        await this.otlpReceiver.start();
      } catch (err) {
        log.warn('bridge', 'Failed to start OTLP receiver', { error: String(err) });
      }
    }
    options.signal?.throwIfAborted();

    this.agentSessionService = new AgentSessionService(
      this.projectRoot,
      async (pane) => {
        if (!pane.paneId) return null;
        try {
          const cwd = await displayPaneFormat(pane.paneId, PANE_CURRENT_PATH_FORMAT);
          return cwd.trim() || null;
        } catch {
          return null;
        }
      },
      (paneId, sessionId) => {
        const current = this.stateManager.getPanes();
        const idx = current.findIndex(p => p.id === paneId);
        const pane = idx >= 0 ? current[idx] : undefined;
        if (pane?.agent && SESSION_PARSING_AGENTS.some((agent) => agent === pane.agent) && pane.agentSessionId !== sessionId) {
          const updated = current.map((p, i) =>
            i === idx ? { ...p, agentSessionId: sessionId } : p,
          );
          this.stateManager.updatePanes(updated);
          this.persistPanesToConfig(updated);
          log.info('bridge', 'Persisted agent session ID', { agent: pane.agent, paneId, sessionId });
        }
      },
      (paneId, harvested) => this.applyHarvestedPaneTitle(paneId, harvested),
      this.otlpReceiver,
      () => ElectronSettingsService.getInstance().get('enableConversationTopics'),
      (paneId, session) => this.paneActivityProjection.recordSessionActivity(paneId, session),
    );
    if (this.window) this.agentSessionService.setWindow(this.window);
    options.signal?.throwIfAborted();
    // Session-file discovery per pane does a tmux round-trip + disk scan and
    // nothing downstream in the switch awaits it (agentSessionId is persisted
    // asynchronously via the file watcher). Run it off the critical path so the
    // project switch returns immediately. Keep it sequential — claimedFiles /
    // findSessionFile races under concurrency — and stop early if a later
    // switch has already replaced the service.
    const sessionService = this.agentSessionService;
    void (async () => {
      for (const pane of panes) {
        if (this.agentSessionService !== sessionService) break;
        await sessionService.onPaneCreated(pane);
      }
    })().catch((err) => {
      log.warn('bridge', 'Deferred pane session tracking failed', { error: String(err) });
    });

    this.paneSummaryService = new PaneSummaryService({
      projectRoot: this.projectRoot,
      bridge: this,
      emit: (channel, payload) => {
        if (this.window && !this.window.isDestroyed()) {
          this.window.webContents.send(channel, payload);
        }
      },
    });

    void this.reapOrphanedTranscripts();
  }

  /** Backfills only legacy panes with no persisted label; callers persist the batch once. */
  private backfillMissingPaneTitles(panes: MuxBasePane[]): MuxBasePane[] {
    let backfilled = 0;
    const updated = panes.map((pane) => {
      if (pane.titleLocked || pane.title?.trim() || !pane.prompt.trim()) return pane;
      const title = condenseTitleLocally(pane.prompt);
      if (!title) return pane;
      backfilled++;
      return { ...pane, title };
    });

    if (backfilled > 0) {
      log.info('bridge', 'Backfilled missing pane titles', { count: backfilled });
      return updated;
    }
    return panes;
  }

  private handleDetectedPaneStatus(event: StatusUpdateEvent): void {
    this.paneActivityProjection.recordPollActivity(event.paneId, event.status);
    // A restatement carries no new information, so it must not re-run the
    // discovery below on every freshness tick.
    if (event.reasserted) return;
    // A working/analyzing delivery means something is actively running in the
    // pane - the right moment to re-probe a pane previously marked
    // untrackable, so a later manual agent launch in that pane isn't
    // permanently shut out of session tracking.
    if (event.status === 'working' || event.status === 'analyzing') {
      this.untrackablePanes.delete(event.paneId);
    }
    this.tryStartSessionTrackingForUntracked(event.paneId).catch((err) => {
      log.debug('bridge', 'Auto session tracking failed', { paneId: event.paneId, error: String(err) });
    });
  }

  private async discoverProject(): Promise<void> {
    const current = await discoverCurrentProject();

    if (current) {
      this.setProjectContext(current.projectRoot, current.projectName, current.sessionName);
      return;
    }

    const cwd = process.cwd();
    if (!this.isValidLaunchProjectRoot(cwd)) {
      this.clearProjectContext();
      return;
    }

    const projectName = basename(cwd) || 'muxbase';
    this.setProjectContext(cwd, projectName, `muxbase-${projectName}`);
  }

  private setProjectContext(projectRoot: string, projectName: string, sessionName: string): void {
    this.projectRoot = projectRoot;
    this.projectName = projectName;
    this.sessionName = sessionName;
    this.configPath = getProjectConfigPath(projectRoot);
  }

  private clearProjectContext(): void {
    this.projectRoot = '';
    this.projectName = '';
    this.sessionName = '';
    this.configPath = '';
  }

  private isValidLaunchProjectRoot(projectRoot: string): boolean {
    const resolvedRoot = resolve(projectRoot);
    if (resolvedRoot === dirname(resolvedRoot) || resolvedRoot === homedir()) return false;
    if (!existsSync(resolvedRoot)) return false;

    try {
      if (!statSync(resolvedRoot).isDirectory()) return false;
      accessSync(resolvedRoot, fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  private readConfig(): MuxBaseConfig | null {
    try {
      return parseMuxBaseConfig(JSON.parse(readFileSync(this.configPath, 'utf-8')));
    } catch (error) {
      log.warn('bridge', 'Ignoring invalid persisted project config', {
        configPath: this.configPath,
        error: formatError(error),
      });
      return null;
    }
  }

  private async setupTranscriptPiping(
    tmuxPaneId: string,
    existingTranscriptPath?: string,
    filenamePrefix?: string,
  ): Promise<string | undefined> {
    try {
      return await setupTmuxTranscript({
        existingTranscriptPath,
        filenamePrefix,
        logDir: log.getLogDir(),
        tmuxPaneId,
      });
    } catch (error) {
      log.warn('bridge', 'Failed to enable terminal transcript; falling back to capture mode', { tmuxPaneId, error });
      return existingTranscriptPath;
    }
  }

  private async setPaneTitleSafe(paneId: string, title: string): Promise<void> {
    try {
      await this.tmuxService.setPaneTitle(paneId, title);
    } catch (error) {
      log.debug('bridge', 'setPaneTitle failed', { paneId, title, error: String(error) });
    }
  }

  private async resurrectPanes(panes: MuxBasePane[]): Promise<MuxBasePane[]> {
    this.paneWatcher?.suspendSync();

    try {
      const batched = await this.tmuxService.listAllPanes();
      const liveIds = batched
        ? new Set(batched.map((p) => p.paneId))
        : await this.probeLivePanes(panes);
      const runningAgentPanes = await this.resolveRunningAgents(panes, batched, liveIds);

      // Dead panes are recreated in tmux, which mutates control-pane/session
      // state — resolve it once up front so the per-pane work stays pure and
      // safe to run concurrently.
      const hasDeadPane = panes.some((pane) => !liveIds.has(pane.paneId));
      if (hasDeadPane) {
        await this.ensureValidControlPaneId();
      }

      const results = await Promise.all(
        panes.map((pane) =>
          liveIds.has(pane.paneId)
            ? this.resurrectLivePane(pane, runningAgentPanes.has(pane.paneId))
            : this.resurrectDeadPane(pane),
        ),
      );

      return results.filter((pane): pane is MuxBasePane => pane !== null);
    } finally {
      this.paneWatcher?.resumeSync();
    }
  }

  /**
   * Per-pane liveness fallback (retried paneExists) used when the batched
   * listAllPanes fails, so a transient tmux hiccup never makes us treat live
   * panes as dead — which would delete config panes and orphan running agents.
   */
  private async probeLivePanes(panes: MuxBasePane[]): Promise<Set<string>> {
    log.warn('bridge', 'listAllPanes failed; falling back to per-pane liveness checks');
    const checks = await Promise.all(
      panes.map(async (pane) => ({
        paneId: pane.paneId,
        alive: await this.tmuxService.paneExists(pane.paneId),
      })),
    );
    return new Set(checks.filter((c) => c.alive).map((c) => c.paneId));
  }

  /**
   * Which live panes have their agent running. Fast path uses the batched
   * pid/command data via getRunningAgentPanes (one shared `ps`). When the batch
   * was unavailable, fall back to the per-pane check so agents aren't wrongly
   * reported idle on the degraded path.
   */
  private async resolveRunningAgents(
    panes: MuxBasePane[],
    batched: Awaited<ReturnType<TmuxService['listAllPanes']>>,
    liveIds: Set<string>,
  ): Promise<Set<string>> {
    const agentPanes = panes.filter((pane) => pane.agent && pane.type !== 'shell' && liveIds.has(pane.paneId));

    if (batched) {
      const byId = new Map(batched.map((p) => [p.paneId, p]));
      const probes: PaneAgentProbe[] = agentPanes.map((pane) => {
        const live = byId.get(pane.paneId)!;
        return { paneId: pane.paneId, pid: live.pid, currentCommand: live.currentCommand, agent: pane.agent! };
      });
      const result = await getRunningAgentPanes(probes);
      // Compatibility with test doubles from the pre-tri-state API. Runtime
      // always uses the structured result, preserving indeterminate failures.
      return result instanceof Set ? result : result.running;
    }

    const checks = await Promise.all(
      agentPanes.map(async (pane) => ({
        paneId: pane.paneId,
        running: await isAgentRunningInPane(pane.paneId, pane.agent!),
      })),
    );
    return new Set(checks.filter((c) => c.running).map((c) => c.paneId));
  }

  private async resurrectLivePane(pane: MuxBasePane, agentRunning: boolean): Promise<MuxBasePane> {
    if (pane.type === 'shell') {
      const transcriptPath = await this.setupTranscriptPiping(pane.paneId, pane.terminalTranscriptPath, 'shell');
      return { ...pane, terminalTranscriptPath: transcriptPath };
    }

    if (!agentRunning) {
      log.info('bridge', 'Restoring live pane without auto-resume command', { paneId: pane.paneId, agent: pane.agent });
      const transcriptPath = await this.setupTranscriptPiping(pane.paneId, pane.terminalTranscriptPath, 'resumed');
      return { ...pane, terminalTranscriptPath: transcriptPath };
    }

    const transcriptPath = pane.terminalTranscriptPath
      ?? (await this.setupTranscriptPiping(pane.paneId, undefined, 'resumed'));
    return { ...pane, terminalTranscriptPath: transcriptPath };
  }

  private async resurrectDeadPane(pane: MuxBasePane): Promise<MuxBasePane | null> {
    if (!pane.worktreePath || !existsSync(pane.worktreePath)) {
      log.info('bridge', 'Dropping dead pane (no worktree)', { id: pane.id, slug: pane.slug });
      return null;
    }

    log.info('bridge', 'Recreating dead tmux pane', { id: pane.id, slug: pane.slug });

    const newPaneId = await this.tmuxService.newWindowPane({
      sessionName: this.sessionName,
      cwd: pane.worktreePath,
    });

    const transcriptPath = await this.setupTranscriptPiping(newPaneId, pane.terminalTranscriptPath);
    return {
      ...pane,
      paneId: newPaneId,
      terminalTranscriptPath: transcriptPath,
    };
  }

  private async queryControlPaneId(): Promise<string | null> {
    try {
      const output = await execAsync(
        `tmux list-panes -t ${shQuote(this.sessionName)} -F "#{pane_id}"`,
        { silent: true },
      );
      const ids = output.split('\n').filter(Boolean);
      return ids[0] || null;
    } catch {
      return null;
    }
  }

  getControlPaneId(): string | null {
    return this.controlPaneId;
  }

  /**
   * Validate the cached control pane, creating/refreshing the tmux session when
   * needed.
   *
   * Fast path (default): if the cached control pane is still alive, a live pane
   * implies a live session, so one `paneExists` check suffices and we skip the
   * full ensureTmuxSession.
   *
   * `reassertMetadata: true` forces the full ensureTmuxSession (session
   * re-create + @muxbase_project_* / window-size metadata). Boot/resume must use it
   * so untagged pre-existing sessions still get their metadata written; the
   * per-createPane callers rely on that having already happened and use the
   * fast path.
   *
   * Returns true when the full ensureTmuxSessionReady path ran (which already
   * republishes COLORFGBG via setSessionMetadata), false when the fast path
   * was taken and the caller must republish it itself.
   */
  private async ensureValidControlPaneId(options: { reassertMetadata?: boolean } = {}): Promise<boolean> {
    if (!options.reassertMetadata
      && this.controlPaneId
      && await this.tmuxService.paneExists(this.controlPaneId)) {
      return false;
    }

    const sessionPaneId = await this.ensureTmuxSessionReady();

    if (this.controlPaneId) {
      try {
        const exists = await this.tmuxService.paneExists(this.controlPaneId);
        if (exists) return true;
      } catch {
        // Fall through to re-query
      }
      log.warn('bridge', 'Control pane is stale, re-querying', { staleId: this.controlPaneId });
    }

    this.controlPaneId = sessionPaneId;
    log.info('bridge', 'Control pane ID refreshed', { controlPaneId: this.controlPaneId });
    return true;
  }

  private async ensureTmuxSessionReady(): Promise<string> {
    const result = await ensureTmuxSession(this.sessionName, this.projectRoot, this.projectName);

    if (result.sessionName !== this.sessionName) {
      this.sessionName = result.sessionName;
      this.stateManager.updateProjectInfo(this.projectName, this.sessionName, this.projectRoot, this.configPath);
      log.info('bridge', 'Session name changed due to collision', { sessionName: this.sessionName });
    }

    log.info('bridge', 'Tmux session ready', {
      sessionName: this.sessionName,
      controlPaneId: result.paneId,
      created: result.created,
    });

    return result.paneId;
  }

  async getAvailableAgents(capability?: AgentCapability): Promise<AgentName[]> {
    return this.agentCatalog.getAvailable(capability);
  }

  async refreshAvailableAgents(capability?: AgentCapability): Promise<AgentName[]> {
    return this.agentCatalog.refresh(capability);
  }

  updateAvailableAgentsCache(agents: readonly AgentName[]): void {
    this.agentCatalog.replace(agents);
  }

  private detectAvailableAgents(refreshIdentity: boolean): Promise<AgentName[]> {
    return this.agentCatalog.detect(refreshIdentity);
  }

  getPanes(): MuxBasePane[] {
    return this.stateManager.getPanes();
  }

  getProjectRoot(): string {
    return this.projectRoot;
  }

  getProjectName(): string {
    return this.projectName;
  }

  getSessionName(): string {
    return this.sessionName;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getTmuxService(): TmuxService {
    return this.tmuxService;
  }

  getStateManager(): StateManager {
    return this.stateManager;
  }

  getPaneActivitySnapshot(): ActivitySnapshot {
    if (!this.paneActivityService) {
      return { epochId: 'unavailable', panes: {}, revision: 0 };
    }
    return this.paneActivityService.getSnapshot() as ActivitySnapshot;
  }

  private handlePaneActivityChanged = (event: PaneActivityChangedEvent): void => {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(IPC_EVENT.PANE_ACTIVITY_CHANGED, event);
    }
  };

  private async registerPaneActivity(panes: readonly MuxBasePane[], starting = false): Promise<void> {
    const service = this.paneActivityService;
    if (!service) return;
    await Promise.all(panes.map(async (pane) => {
      try {
        const incarnationId = await ensureTmuxPaneIncarnationOption(pane.paneId);
        if (starting) this.activityJournalReader.markLive(getPaneActivityJournalPath(incarnationId));
        service.registerPane(pane.id, incarnationId, {
          adapterHealth: this.initialAdapterHealth(pane),
          starting: starting && pane.agent !== undefined,
        });
      } catch (error) {
        // A failed tmux option read must not reuse a previous pane incarnation.
        const incarnationId = randomUUID();
        if (starting) this.activityJournalReader.markLive(getPaneActivityJournalPath(incarnationId));
        log.warn('bridge', 'Could not persist pane activity incarnation', { paneId: pane.id, error: String(error) });
        service.registerPane(pane.id, incarnationId, {
          adapterHealth: this.initialAdapterHealth(pane),
          starting: starting && pane.agent !== undefined,
        });
      }
    }));
  }

  private removePaneActivity(paneId: string): void {
    const service = this.paneActivityService;
    if (service) {
      try {
        const activity = service.getSnapshot(paneId).activity;
        const journalPath = getPaneActivityJournalPath(activity.paneIncarnationId);
        this.activityJournalReader.remove(journalPath);
        removePaneActivityJournal(journalPath);
      } catch {
        // The activity record may already have been removed by another close signal.
      }
      service.removePane(paneId);
    }
    this.agentLivenessProbe.removePane(paneId);
    this.paneStreamStatusWatchers.delete(paneId);
    this.lastStreamActivityAt.delete(paneId);
    void this.detachedTranscriptActivityTailer.remove(paneId);
  }

  recordTerminalActivity(paneId: string, data: string, source: 'live' | 'replay'): void {
    if (source !== 'live') return;
    const pane = this.stateManager.getPaneById(paneId);
    if (!pane?.agent) return;
    let watcher = this.paneStreamStatusWatchers.get(paneId);
    if (!watcher) {
      watcher = new PaneStreamStatusWatcher(pane.agent);
      this.paneStreamStatusWatchers.set(paneId, watcher);
    }
    if (!watcher.observe(data)) return;
    const now = Date.now();
    const previousEvidenceAt = this.lastStreamActivityAt.get(paneId) ?? Number.NEGATIVE_INFINITY;
    if (now - previousEvidenceAt < 250) return;
    this.lastStreamActivityAt.set(paneId, now);
    getStatusDetector().notePaneActivity(paneId);
    const service = this.paneActivityService;
    if (!service) return;
    try {
      const activity = service.getSnapshot(paneId).activity;
      service.ingest({
        eventId: `stream:${paneId}:${randomUUID()}`,
        kind: 'turn_start_candidate',
        origin: 'stream',
        paneId,
        paneIncarnationId: activity.paneIncarnationId,
        receivedAt: now,
        sessionId: activity.sessionId,
        turnId: activity.turnId,
      });
    } catch {
      // Pane disappeared while a transport callback was in flight.
    }
  }

  private async probePaneActivityLiveness(): Promise<void> {
    const service = this.paneActivityService;
    const agentPanes = this.stateManager.getPanes().filter((pane) => pane.agent && pane.type !== 'shell');
    if (!service || agentPanes.length === 0) return;
    try {
      const livePanes = await this.tmuxService.listAllPanes();
      if (!livePanes) {
        for (const pane of agentPanes) service.setLiveness(pane.id, 'unknown');
        return;
      }
      const byTmuxPaneId = new Map(livePanes.map((pane) => [pane.paneId, pane]));
      const observablePanes = agentPanes.filter((pane) => byTmuxPaneId.has(pane.paneId));
      const probes: PaneAgentProbe[] = observablePanes.map((pane) => {
        const livePane = byTmuxPaneId.get(pane.paneId)!;
        return {
          agent: pane.agent!,
          currentCommand: livePane.currentCommand,
          paneId: pane.id,
          pid: livePane.pid,
        };
      });
      const rawResult = await getRunningAgentPanes(probes);
      const result = rawResult instanceof Set
        ? { indeterminate: new Set<string>(), running: rawResult }
        : rawResult;
      const launchedTooRecently = new Set<string>();
      const now = Date.now();
      for (const pane of observablePanes) {
        const activity = this.paneActivityProjection.getPaneActivity(pane.id);
        if (activity?.state === 'starting' && now - activity.sinceWallMs < 5_000) {
          launchedTooRecently.add(pane.id);
          service.setLiveness(pane.id, 'unknown');
        }
      }
      const observedPaneIds = observablePanes
        .map((pane) => pane.id)
        .filter((paneId) => !launchedTooRecently.has(paneId));
      for (const [paneId, liveness] of this.agentLivenessProbe.resolve(observedPaneIds, result)) {
        service.setLiveness(paneId, liveness);
      }
      for (const pane of agentPanes) {
        if (!byTmuxPaneId.has(pane.paneId)) service.setLiveness(pane.id, 'unknown');
      }
    } catch (error) {
      log.debug('bridge', 'Activity liveness probe failed', { error: String(error) });
      for (const pane of agentPanes) service.setLiveness(pane.id, 'unknown');
    }
  }

  private async readPaneActivityJournals(): Promise<void> {
    if (this.activityJournalReadInFlight) return;
    this.activityJournalReadInFlight = true;
    const service = this.paneActivityService;
    try {
      if (!service) return;
      const receivedAt = Date.now();
      const panes = this.stateManager.getPanes();
      await this.detachedTranscriptActivityTailer.sync(panes);
      for (const activity of await this.detachedTranscriptActivityTailer.readNewData()) {
        this.recordTerminalActivity(activity.paneId, activity.data, 'live');
      }
      for (const pane of panes) {
        let activity: PaneActivity;
        try {
          activity = service.getSnapshot(pane.id).activity;
        } catch {
          continue;
        }
        const journalPath = getPaneActivityJournalPath(activity.paneIncarnationId);
        const read = await this.activityJournalReader.read(journalPath, receivedAt);
        if (!shouldConsumeLifecycleAdapterEvents(pane.agent, this.areAgentLifecycleAdaptersEnabled())) continue;
        for (const batch of read.batches) {
          for (const event of batch.events) {
            if (batch.replay) service.replay(event);
            else service.ingest(event);
          }
        }
      }
    } finally {
      this.activityJournalReadInFlight = false;
    }
  }

  /** Submit a complete command without allowing terminal scroll/resize work to split it from Enter. */
  async sendCommandToPane(paneId: string, command: string): Promise<void> {
    const pane = this.stateManager.getPanes().find((candidate) => candidate.id === paneId);
    if (!pane) throw new Error(`Unknown pane: ${paneId}`);

    const submitted = await getTerminalManager(this).submitCommand(pane.id, pane.paneId, command);
    if (submitted) return;

    // A pane can receive a command before its renderer terminal attaches. The
    // shared helper keeps command text and its real Enter key consecutive in
    // one tmux command list even on this unmanaged path.
    await this.cancelCopyModeBeforeCommand(pane.paneId);
    await submitTerminalCommand(pane.paneId, command);
  }

  private getTerminalTranscriptDir(): string | undefined {
    return getTranscriptDir();
  }

  private async reapOrphanedTranscripts(): Promise<void> {
    const terminalDir = this.getTerminalTranscriptDir();
    if (!terminalDir) return;

    const livePaths = new Set(
      this.stateManager.getPanes()
        .map((pane) => pane.terminalTranscriptPath)
        .filter((path): path is string => !!path),
    );
    const deleted = await reapOrphanTranscripts(
      terminalDir,
      livePaths,
      Date.now(),
      TRANSCRIPT_RETENTION_MS,
    );
    if (deleted > 0) {
      log.info('bridge', 'Reaped orphaned terminal transcripts', { deleted });
    }
  }

  private rolloverOversizedTranscripts(): Promise<void> {
    if (this.transcriptRolloverSweep) return this.transcriptRolloverSweep;

    const sweep = sweepTranscriptRollovers([...this.stateManager.getPanes()], {
      isPaneAlive: (tmuxPaneId) => this.tmuxService.paneExists(tmuxPaneId),
    })
      .then(() => undefined)
      .catch((error: unknown) => {
        log.warn('terminal', 'Live transcript rollover sweep failed', { error });
      })
      .finally(() => {
        if (this.transcriptRolloverSweep === sweep) {
          this.transcriptRolloverSweep = null;
        }
      });
    this.transcriptRolloverSweep = sweep;
    return sweep;
  }

  getCallbackRegistry(): ActionCallbackRegistry {
    return this.callbackRegistry;
  }

  runProjectMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.projectOperations.runMutation(operation);
  }

  executeActionCallback(callbackId: string, value?: string): Promise<SerializableActionResult> {
    return this.runProjectMutation(() => this.callbackRegistry.execute(callbackId, value));
  }

  getAgentSession(paneId: string) {
    return this.agentSessionService?.getSession(paneId) ?? null;
  }

  getPaneSummaryService(): PaneSummaryService | null {
    return this.paneSummaryService;
  }

  async searchAgentSessions(query: string): Promise<AgentSessionSearchResult[]> {
    return this.agentSessionService?.searchSessions(query) ?? [];
  }

  async listPaneSessions(
    agent: AgentName,
    projectRoot: string,
    limit?: number,
  ): Promise<PaneSessionListResponse> {
    return this.paneSessionCatalog.list(agent, projectRoot, limit);
  }

  getAllTopics(): PaneTopics[] {
    return this.agentSessionService?.getAllTopics() ?? [];
  }

  private applyHarvestedPaneTitle(paneId: string, harvested: HarvestedTitle): void {
    this.commitPaneTitle(paneId, harvested.title, 'native');
  }

  private commitPaneTitle(paneId: string, rawTitle: string, source: 'experimental' | 'native'): boolean {
    const current = this.stateManager.getPanes();
    const idx = current.findIndex((p) => p.id === paneId);
    const pane = idx >= 0 ? current[idx] : undefined;
    const title = normalizeAutomaticPaneTitle(rawTitle);
    if (!pane || pane.titleLocked || !title || pane.title === title) {
      log.debug('bridge', 'Automatic pane title skipped', {
        paneId,
        source,
        outcome: !pane ? 'missing-pane' : pane.titleLocked ? 'locked' : !title ? 'invalid' : 'unchanged',
        candidateLength: title?.length ?? 0,
      });
      return false;
    }
    const updated = current.map((p, i) => (i === idx ? { ...p, title } : p));
    this.stateManager.updatePanes(updated);
    this.persistPanesToConfig(updated);
    this.notifyPaneListChanged();
    log.info('bridge', 'Persisted automatic pane title', {
      paneId,
      source,
      outcome: 'updated',
      candidateLength: title.length,
    });
    return true;
  }

  private async maybeRequestExperimentalPaneTitle(paneId: string, sourceText: string): Promise<void> {
    if (process.env.MUXBASE_EXPERIMENTAL_OPENROUTER_TITLES !== '1') return;
    const apiKey = process.env.OPENROUTER_API_KEY?.trim() ?? '';
    const model = process.env.MUXBASE_EXPERIMENTAL_OPENROUTER_TITLE_MODEL?.trim() ?? '';
    if (!apiKey || !model) return;

    const pane = this.stateManager.getPanes().find((candidate) => candidate.id === paneId);
    if (!pane || pane.titleLocked) return;

    const startedAt = Date.now();
    const title = await requestExperimentalOpenRouterTitle({ apiKey, model, sourceText });
    const applied = title ? this.commitPaneTitle(paneId, title, 'experimental') : false;
    log.debug('bridge', 'Experimental pane title completed', {
      paneId,
      source: 'experimental',
      outcome: applied ? 'updated' : title ? 'dropped' : 'unavailable',
      candidateLength: title?.length ?? 0,
      elapsedMs: Date.now() - startedAt,
    });
  }

  async createPane(
    prompt: string,
    agent?: AgentName,
    options?: PaneLaunchOptions,
  ): Promise<PaneCreateResponse> {
    return this.projectOperations.runMutation(() => this.createPaneUnlocked(prompt, agent, options));
  }

  private async createPaneUnlocked(
    prompt: string,
    agent?: AgentName,
    options?: PaneLaunchOptions,
  ): Promise<PaneCreateResponse> {
    return this.paneLaunchWorkflow.create(prompt, agent, options);
  }
  async createTerminalPane(projectRoot?: string): Promise<PaneCreateResponse> {
    return this.paneLaunchWorkflow.createTerminal(projectRoot);
  }
  async createDuelPanes(request: DuelRequest): Promise<PaneDuelCreateResponse> {
    return this.duelWorkflow.create(request);
  }

  async resolveDuel(winnerPaneId: string): Promise<PaneDuelResolveResponse> {
    return this.duelWorkflow.resolve(winnerPaneId);
  }

  async duplicatePane(paneId: string): Promise<PaneCreateResponse> {
    return this.paneLaunchWorkflow.duplicate(paneId);
  }

  async startReviewAction(sourcePaneId: string, reviewAgent?: AgentName): Promise<PaneStartReviewResponse> {
    return this.reviewWorkflow.startReview(sourcePaneId, reviewAgent);
  }

  async startFixHandoffAction(reviewPaneId: string): Promise<PaneSendFixResponse> {
    return this.reviewWorkflow.startFixHandoff(reviewPaneId);
  }

  /** Type a prompt into a running pane's agent and submit it. */
  private async sendPromptToPane(paneId: string, prompt: string): Promise<void> {
    await this.sendCommandToPane(paneId, prompt);
  }

  private async cancelCopyModeBeforeCommand(tmuxPaneId: string): Promise<void> {
    try {
      await this.tmuxService.sendTmuxKeys(tmuxPaneId, '-X cancel');
    } catch (error) {
      log.debug('bridge', 'Copy-mode cancel before command skipped', {
        error: formatError(error),
        tmuxPaneId,
      });
    }
  }

  async listOrphanedWorktrees(): Promise<WorktreeOrphansListResponse> {
    return this.worktreeWorkflow.list();
  }

  async inspectPreservedWorktree(worktreePath: string): Promise<WorktreeInspectResponse> {
    return this.worktreeWorkflow.inspect(worktreePath);
  }

  async removePreservedWorktree(
    worktreePath: string,
    allowDataLoss: boolean,
    expectedState: WorktreeRemovalState,
  ): Promise<WorktreeRemoveResponse> {
    return this.worktreeWorkflow.remove(worktreePath, allowDataLoss, expectedState);
  }

  async reopenWorktreePane(worktreePath: string): Promise<PaneCreateResponse> {
    return this.worktreeWorkflow.reopen(worktreePath);
  }

  async closePaneAction(paneId: string): Promise<SerializableActionResult> {
    return this.callbackRegistry.serializeActionResult(await this.paneActionWorkflow.close(paneId));
  }

  async mergePaneAction(paneId: string): Promise<SerializableActionResult> {
    return this.callbackRegistry.serializeActionResult(await this.paneActionWorkflow.merge(paneId));
  }

  private addPaneToDone(pane: MuxBasePane): void {
    try {
      const service = KanbanPersistenceService.getInstance();
      service.addDoneItem(pane.projectRoot ?? this.projectRoot, {
        id: randomUUID(),
        slug: pane.slug,
        prompt: pane.prompt,
        mergedAt: Date.now(),
        branchName: pane.branchName,
        agent: pane.agent,
      });
      const win = this.getWindow?.();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC_EVENT.KANBAN_CHANGED);
      }
      log.info('bridge', 'Added merged pane to kanban done', { slug: pane.slug });
    } catch (error) {
      log.warn('bridge', 'Failed to add pane to kanban done', error);
    }
  }

  async renamePaneAction(paneId: string, newName: string): Promise<SerializableActionResult> {
    return this.callbackRegistry.serializeActionResult(
      await this.paneActionWorkflow.rename(paneId, newName),
    );
  }

  async resumePaneInFullscreenAction(paneId: string): Promise<SerializableActionResult> {
    return this.callbackRegistry.serializeActionResult(
      await this.paneActionWorkflow.resumeInFullscreen(paneId),
    );
  }

  async createWorktreeForPaneAction(paneId: string): Promise<PaneCreateWorktreeResponse> {
    return this.worktreeWorkflow.createForPane(paneId);
  }

  async attachWorktreeToPaneAction(paneId: string, worktreePath: string): Promise<PaneAttachWorktreeResponse> {
    return this.worktreeWorkflow.attachToPane(paneId, worktreePath);
  }

  private buildActionContext(): ActionContext {
    return {
      panes: this.stateManager.getPanes(),
      sessionName: this.sessionName,
      projectName: this.projectName,
      otlpEndpoint: this.getOtlpEndpoint(),
      terminalTranscriptDir: this.getTerminalTranscriptDir(),
      skipLastPaneWelcome: true,
      savePanes: async (panes: MuxBasePane[]) => {
        // Action workflows use persistence as a transaction boundary. Write
        // first so an I/O failure cannot expose a pane in memory or notify the
        // renderer about state that will disappear on restart.
        this.persistPanesToConfigOrThrow(panes);
        this.stateManager.updatePanes(panes);
        this.notifyPaneListChanged();
      },
      onPaneUpdate: (pane: MuxBasePane) => {
        const current = this.stateManager.getPanes();
        const idx = current.findIndex((p) => p.id === pane.id);
        if (idx >= 0) {
          current[idx] = pane;
          this.stateManager.updatePanes(current);
          this.persistPanesToConfig(current);
          this.notifyPaneListChanged();
        }
      },
      onPaneRemove: (paneId: string) => {
        const removedPane = this.stateManager.getPanes().find((p) => p.id === paneId);
        detachTerminalPane(paneId);
        const current = this.stateManager.getPanes().filter((p) => p.id !== paneId);
        this.stateManager.updatePanes(current);
        this.persistPanesToConfig(current);
        this.notifyPaneListChanged();
        this.agentSessionService?.onPaneDestroyed(paneId);
        getStatusDetector().removePane(paneId);
        this.untrackablePanes.delete(paneId);
        this.removePaneActivity(paneId);
        void this.paneSummaryService?.removeForPane(paneId);

        if (removedPane) {
          triggerHook('pane_closed', this.projectRoot, removedPane).catch(() => {});
          if (removedPane.worktreePath) {
            triggerHook('worktree_removed', this.projectRoot, removedPane).catch(() => {});
          }
        }
      },
    };
  }

  private ensureConfigFile(): void {
    if (existsSync(this.configPath)) return;
    const dir = dirname(this.configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const initialConfig: MuxBaseConfig = {
      projectName: this.projectName,
      projectRoot: this.projectRoot,
      panes: [],
      settings: {},
      lastUpdated: new Date().toISOString(),
      controlPaneId: undefined,
      controlPaneSize: DEFAULT_CONTROL_PANE_SIZE,
    };
    atomicWriteJsonSync(this.configPath, initialConfig);
    log.info('bridge', 'Created initial config file', { path: this.configPath });
  }

  private resetConfigForFreshProject(): void {
    const previousConfig = this.readConfig();
    const freshConfig: MuxBaseConfig = {
      projectName: this.projectName,
      projectRoot: this.projectRoot,
      panes: [],
      settings: previousConfig?.settings ?? {},
      lastUpdated: new Date().toISOString(),
      controlPaneId: undefined,
      controlPaneSize: previousConfig?.controlPaneSize ?? DEFAULT_CONTROL_PANE_SIZE,
    };
    atomicWriteJsonSync(this.configPath, freshConfig);
    log.info('bridge', 'Reset project config for fresh start', { path: this.configPath });
  }

  private async resetFreshTmuxSession(): Promise<void> {
    await execAsync(`tmux kill-session -t ${shQuote(this.sessionName)}`, { silent: true });
    this.controlPaneId = null;
    log.info('bridge', 'Reset tmux session for fresh project start', { sessionName: this.sessionName });
  }

  private savePaneToConfig(pane: MuxBasePane): void {
    // Core createPane already writes the pane to the config file.
    // Read back the latest config to avoid duplicates, then ensure state is in sync.
    try {
      this.ensureConfigFile();
      const config = this.readConfig()!;
      const configPanes = config.panes || [];

      // Only add if not already present (core may have already saved it)
      const paneIndex = configPanes.findIndex((p) => p.id === pane.id);
      const exists = paneIndex >= 0;
      if (!exists) {
        configPanes.push(this.serializePaneForConfig(pane));
        config.panes = configPanes;
        config.lastUpdated = new Date().toISOString();
        atomicWriteJsonSync(this.configPath, config);
        log.info('bridge', 'Pane added to config (was not yet present)', { id: pane.id });
      } else {
        const persistedPane = configPanes[paneIndex];
        const normalized = this.serializePaneForConfig({
          ...persistedPane,
          // Core's first-content-pane write persists the undecorated pane, so
          // backfill sourceBacklogId from the decorated pane when missing —
          // otherwise the kanban backlog link is lost.
          sourceBacklogId: persistedPane?.sourceBacklogId ?? pane.sourceBacklogId,
          title: pane.title ?? persistedPane?.title,
          titleLocked: pane.titleLocked ?? persistedPane?.titleLocked,
        });

        const changed =
          configPanes[paneIndex]?.sourceBacklogId !== normalized.sourceBacklogId
          || configPanes[paneIndex]?.title !== normalized.title
          || configPanes[paneIndex]?.titleLocked !== normalized.titleLocked
          || this.hasRuntimeActivityFields(configPanes[paneIndex]);

        if (changed) {
          configPanes[paneIndex] = normalized;
          config.panes = configPanes;
          config.lastUpdated = new Date().toISOString();
          atomicWriteJsonSync(this.configPath, config);
          log.info('bridge', 'Normalized created pane runtime state from config snapshot', {
            id: pane.id,
            activity: 'omitted',
          });
        } else {
          log.debug('bridge', 'Pane already in config (saved by core)', { id: pane.id });
        }
      }

      this.stateManager.updatePanes(configPanes);
      this.notifyPaneListChanged();
    } catch (error) {
      log.warn('bridge', 'Failed to save pane to config', error);
      // Fallback: add to in-memory state at minimum
      const panes = [...this.stateManager.getPanes(), pane];
      this.stateManager.updatePanes(panes);
      this.notifyPaneListChanged();
    }
  }

  private decorateCreatedPane(
    pane: MuxBasePane,
    sourceBacklogId?: string,
    paneTitle?: string,
    localTitle?: string,
  ): MuxBasePane {
    return {
      ...pane,
      sourceBacklogId,
      ...(paneTitle
        ? { title: paneTitle, titleLocked: true }
        : localTitle ? { title: localTitle } : {}),
    };
  }

  private emitEarlyPane(
    pane: MuxBasePane,
    sourceBacklogId?: string,
    paneTitle?: string,
    localTitle?: string,
  ): void {
    const decorated = this.decorateCreatedPane(pane, sourceBacklogId, paneTitle, localTitle);
    log.info('bridge', 'Emitting pane before agent launch', { id: decorated.id, slug: decorated.slug });
    this.savePaneToConfig(decorated);
    void this.registerPaneActivity([decorated], true);
  }

  private removePaneFromConfigAndState(paneId: string): void {
    log.info('bridge', 'Retracting early-emitted pane after launch failure', { paneId });
    try {
      const config = this.readConfig();
      if (config?.panes) {
        const nextPanes = config.panes.filter((p) => p.id !== paneId);
        if (nextPanes.length !== config.panes.length) {
          config.panes = nextPanes;
          config.lastUpdated = new Date().toISOString();
          atomicWriteJsonSync(this.configPath, config);
        }
      }
    } catch (error) {
      log.warn('bridge', 'Failed to retract early pane from config', { paneId, error });
    }
    const panes = this.stateManager.getPanes().filter((p) => p.id !== paneId);
    this.stateManager.updatePanes(panes);
    this.removePaneActivity(paneId);
    this.notifyPaneListChanged();
  }

  private serializePaneForConfig(pane: MuxBasePane): MuxBasePane {
    const {
      agentStatus: _agentStatus,
      lastAgentCheck: _lastAgentCheck,
      lastDeterministicStatus: _lastDeterministicStatus,
      optionsQuestion: _optionsQuestion,
      ...persistedPane
    } = pane;
    return persistedPane;
  }

  private hasRuntimeActivityFields(pane: MuxBasePane | undefined): boolean {
    // Persistence-boundary validation intentionally detects legacy runtime fields before they are
    // stripped; live application decisions must continue to use PaneActivity instead.
    return pane?.agentStatus !== undefined
      || pane?.lastAgentCheck !== undefined
      || pane?.lastDeterministicStatus !== undefined
      || pane?.optionsQuestion !== undefined;
  }

  private saveReopenedWorktreePaneToConfig(pane: MuxBasePane): void {
    try {
      this.ensureConfigFile();
      const config = this.readConfig()!;
      const nextPanes = [
        ...this.withoutMatchingPaneOrWorktree(config.panes || [], pane),
        this.serializePaneForConfig(pane),
      ];

      config.panes = nextPanes;
      config.lastUpdated = new Date().toISOString();
      atomicWriteJsonSync(this.configPath, config);
      this.stateManager.updatePanes(nextPanes);
      this.notifyPaneListChanged();
      log.info('bridge', 'Reopened worktree pane saved to config', { id: pane.id, worktreePath: pane.worktreePath });
    } catch (error) {
      log.error('bridge', 'Failed to persist reopened worktree pane to config', { error, id: pane.id });
      this.sendToast(
        `Reopened "${pane.slug}" but failed to save to disk. Restart will not restore it.`,
        'warning',
      );
      const panes = [
        ...this.withoutMatchingPaneOrWorktree(this.stateManager.getPanes(), pane),
        pane,
      ];
      this.stateManager.updatePanes(panes);
      this.notifyPaneListChanged();
    }
  }

  private withoutMatchingPaneOrWorktree(panes: MuxBasePane[], pane: MuxBasePane): MuxBasePane[] {
    return panes.filter(existingPane => (
      existingPane.id !== pane.id
      && !this.sameWorktreePath(existingPane, pane)
    ));
  }

  private sameWorktreePath(left: MuxBasePane, right: MuxBasePane): boolean {
    if (!left.worktreePath || !right.worktreePath) return false;
    return resolve(left.worktreePath) === resolve(right.worktreePath);
  }

  /**
   * A sync started before a project switch can resolve after it. Persisting then
   * would write the old project's panes through the live config path and the live
   * project identity, so the stale rebind is dropped — bootServices re-persists
   * the new project's panes anyway.
   */
  private persistReboundPanes(panes: MuxBasePane[], bootConfigPath: string): void {
    if (this.configPath !== bootConfigPath) {
      log.debug('bridge', 'Skipped pane rebind persist from a switched-away project', { bootConfigPath });
      return;
    }
    this.persistPanesToConfig(panes);
  }

  private persistPanesToConfig(panes: MuxBasePane[]): void {
    try {
      this.persistPanesToConfigOrThrow(panes);
    } catch (error) {
      log.warn('bridge', 'Failed to persist panes to config', error);
    }
  }

  private persistPanesToConfigOrThrow(panes: MuxBasePane[]): void {
    this.ensureConfigFile();
    const config = this.readConfig()!;
    config.panes = panes.map((pane) => this.serializePaneForConfig(pane));
    config.lastUpdated = new Date().toISOString();
    atomicWriteJsonSync(this.configPath, config);
    log.debug('bridge', 'Panes persisted to config', { count: panes.length });
  }

  private notifyPaneListChanged(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(IPC_EVENT.PANE_LIST_CHANGED, this.stateManager.getPanes());
    }
  }

  private attachCorePaneCreationLogForwarder(): void {
    if (this.corePaneCreationLogForwarder) return;

    this.corePaneCreationLogForwarder = (entry: unknown) => {
      const logEntry = entry as {
        level?: 'debug' | 'info' | 'warn' | 'error';
        message?: string;
        source?: string;
        paneId?: string;
      };

      if (!logEntry || logEntry.source !== 'paneCreation' || typeof logEntry.message !== 'string') {
        return;
      }

      const data = logEntry.paneId ? { paneId: logEntry.paneId } : undefined;
      switch (logEntry.level) {
        case 'debug':
          log.debug('core:paneCreation', logEntry.message, data);
          break;
        case 'warn':
          log.warn('core:paneCreation', logEntry.message, data);
          break;
        case 'error':
          log.error('core:paneCreation', logEntry.message, data);
          break;
        case 'info':
        default:
          log.info('core:paneCreation', logEntry.message, data);
          break;
      }
    };

    LogService.getInstance().on('log-added', this.corePaneCreationLogForwarder);
  }

  private detachCorePaneCreationLogForwarder(): void {
    if (!this.corePaneCreationLogForwarder) return;
    LogService.getInstance().off('log-added', this.corePaneCreationLogForwarder);
    this.corePaneCreationLogForwarder = null;
  }

  private sendProgress(action: string, active: boolean): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(IPC_EVENT.PROGRESS, { action, active });
    }
  }

  sendToast(message: string, severity: 'success' | 'error' | 'info' | 'warning'): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(IPC_EVENT.TOAST, { message, severity });
    }
  }

  private hasActiveProjectContext(): boolean {
    return Boolean(this.projectRoot && this.projectName && this.sessionName && this.configPath);
  }

  private async tryStartSessionTrackingForUntracked(paneId: string): Promise<void> {
    if (!this.agentSessionService) return;
    if (this.agentSessionService.hasContext(paneId)) return;
    if (this.untrackablePanes.has(paneId)) return;

    const pane = this.stateManager.getPaneById(paneId);
    if (!pane || !pane.paneId) return;

    for (const agentType of SESSION_PARSING_AGENTS) {
      const running = await isAgentRunningInPane(pane.paneId, agentType);
      if (running) {
        await this.agentSessionService.ensureTracking(pane, agentType);
        log.info('bridge', 'Auto-started session tracking for detected agent', { paneId, agent: agentType });
        return;
      }
    }

    this.untrackablePanes.add(paneId);
  }

  async shutdown(): Promise<void> {
    log.info('bridge', 'Shutting down MuxBaseBridge...');
    await this.teardownProjectServices();
    this.worktreeMutationPaths.clear();
    this.untrackablePanes.clear();
    this.inFlightHandoffIds.clear();
    this.inFlightReviewSourceIds.clear();
    this.callbackRegistry.cleanup();
    log.info('bridge', 'MuxBaseBridge shutdown complete');
  }

  async setFileWatchRoot(
    rootPath: string | null,
    dirPaths: string[] = [],
    eventRootPath = rootPath,
  ): Promise<void> {
    await this.fileBrowserWatchService.watchRoot(rootPath, dirPaths, eventRootPath);
  }
}
