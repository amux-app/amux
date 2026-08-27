/**
 * muxbase Core API Surface
 *
 * Barrel export for consumption by the desktop Electron app (and any future interfaces).
 * Desktop app imports: import { createPane, TmuxService, ... } from 'muxbase/core'
 */

// Types
export type {
  AgentStatus,
  MuxBasePane,
  DuelMetadata,
  PanePosition,
  ReviewMetadata,
  WindowDimensions,
  ProjectSettings,
  MuxBaseSettings,
  SettingsScope,
  SettingDefinition,
  MuxBaseAppProps,
  MuxBaseConfig,
} from './types.js';

// Pane Creation
export { createPane, createWorktreeForPane, resumeAgentInPane, isAgentRunningInPane } from './utils/paneCreation.js';
export { getPaneActivityJournalPath, removePaneActivityJournal } from './utils/paneActivityJournal.js';
export { ACTIVITY_ADAPTERS, getActivityAdapter } from './utils/activityAdapters.js';
export type {
  ActivityAdapter,
  ActivityAdapterCapability,
  AdapterInstallResult,
  AdapterRemovalResult,
  AdapterSupportLevel,
  PreparedActivityAdapter,
} from './utils/activityAdapters.js';
export { PaneStreamStatusWatcher } from './services/PaneStreamStatusWatcher.js';
export { removeCodexActivityHookSettings } from './utils/codexActivityRegistry.js';
export { removeOpenCodeActivityPlugin } from './utils/opencodeActivityRegistry.js';
export { removePiActivityExtension } from './utils/piActivityRegistry.js';
export type { CreatePaneOptions, CreatePaneResult } from './utils/paneCreation.js';
export { getRunningAgentPanes, type RunningAgentPaneResult } from './utils/paneAgentProcess.js';
export type { PaneAgentProbe } from './utils/paneAgentProcess.js';
export { isShellCommand } from './utils/agentCommandDetection.js';

// Pane Worktree Reconcile
export { reconcilePaneWorktrees } from './utils/paneWorktreeReconcile.js';
export type { ReconcileResult } from './utils/paneWorktreeReconcile.js';

// Tmux Service
export { TmuxService } from './services/TmuxService.js';

// Status Detection
export { StatusDetector, getStatusDetector, peekStatusDetector, resetStatusDetector } from './services/StatusDetector.js';
export type { StatusUpdateEvent } from './services/StatusDetector.js';

// Config Watcher
export { ConfigWatcher } from './services/ConfigWatcher.js';
export type { ConfigData } from './services/ConfigWatcher.js';

// Log Service
export { LogService } from './services/LogService.js';

// Lifecycle Manager
export { PaneLifecycleManager } from './services/PaneLifecycleManager.js';

// Pane Event Service
export { PaneEventService } from './services/PaneEventService.js';

// Preserved Worktrees
export {
  inspectPreservedWorktreeAsync,
  listPreservedWorktreesAsync,
  removePreservedWorktreeAsync,
  type PreservedWorktree,
  type PreservedWorktreeGitStatus,
  type PreservedWorktreeRegistration,
  type PreservedWorktreeRemovalState,
  type RemovePreservedWorktreeOptions,
} from './services/PreservedWorktreeService.js';

// State Manager (main-process only — renderer uses Zustand)
export { StateManager } from './shared/StateManager.js';

// Settings
export { SettingsManager, SETTING_DEFINITIONS } from './utils/settingsManager.js';
export { parseMuxBaseConfig, parseMuxBaseStoredSettings } from './utils/persistedStateValidation.js';
export { isSettingKey, validateSettingValue, validateSettingsPatch } from './utils/settingsSchema.js';
export {
  abortAllConflictMergeTransactions,
  conflictMergeTransactionFromMetadata,
  clearConflictMergeTransactionById,
  findConflictMergeTransactionByPane,
  getConflictMergeTransaction,
  markConflictMergeResolved,
  markConflictMergeResolvedAfterVerification,
  registerConflictMergeTransaction,
  listConflictMergeTransactions,
  scanConflictMergeRecovery,
} from './utils/conflictMergeTransaction.js';
export type { ConflictMergeMetadata } from './types.js';
export { startConflictMonitoring } from './utils/conflictMonitor.js';
export {
  disposeManagedConflictResolutionPane,
  hasManagedConflictPane,
  registerManagedConflictPane,
  releaseManagedConflictPane,
} from './actions/merge/conflictPaneOwnership.js';

// Git Utilities
export {
  getMainBranchAsync,
  getMainBranch,
  getCurrentBranchAsync,
  getCurrentBranch,
  hasUncommittedChangesAsync,
  hasUncommittedChanges,
  getConflictedFilesAsync,
  getConflictedFiles,
  getOrphanedWorktreesAsync,
  getOrphanedWorktrees,
  isValidBranchName,
  getPaneBranchName,
  ensureMuxBaseGitignore,
  isGitObjectId,
} from './utils/git.js';
export {
  getProjectConfigPath,
  getProjectHooksDir,
  getProjectMetadataDir,
  getProjectMetadataPath,
} from './utils/worktreePaths.js';

// Slug Generation
export {
  generateAiSlug,
  generateDefaultSlug,
  generateLocalSlug,
  generateSlug,
} from './utils/slug.js';
export {
  condenseTitleLocally,
  normalizeAutomaticPaneTitle,
} from './utils/paneDisplayTitle.js';

// Agent Detection
export { getAvailableAgents } from './utils/agentDetection.js';

// Canonical agent contract
export {
  AGENT_DEFINITIONS,
  AGENT_CAPABILITIES,
  AGENT_IDS,
  agentHasCapability,
  assertNever,
  getAgentBinary,
  getAgentsWithCapability,
  isAgentName,
} from './agents/agent-contract.js';
export type {
  AgentCapabilities,
  AgentCapability,
  AgentName,
} from './agents/agent-contract.js';
export {
  findPiSessionFile,
  resolvePiDefaultSessionDirectory,
  resolvePiSessionDirectoryForProject,
  resolvePiSessionDirectorySync,
} from './agents/pi-runtime.js';
export type { PiSessionDirectory } from './agents/pi-runtime.js';

// Agent Launch
export {
  getAgentLabel,
  getAgentSlugSuffix,
  appendSlugSuffix,
  buildAgentLaunchOptions,
  getPermissionFlags,
} from './utils/agentLaunch.js';
export {
  CLAUDE_TERMINAL_COLS,
  claudeUsesFullscreen,
  hasValidPaneTerminalProfile,
  resolveClaudeRendererEnvironment,
  resolvePaneTerminalProfile,
} from './utils/paneTerminalProfile.js';
export type { PaneTerminalProfile } from './utils/paneTerminalProfile.js';
export {
  CLAUDE_FULLSCREEN_MINIMUM_VERSION,
  ClaudeFullscreenVersionError,
  assertClaudeFullscreenSupported,
  compareClaudeVersions,
  parseClaudeVersion,
} from './utils/claudeVersion.js';
export type { ClaudeVersion, ClaudeVersionPreflightResult } from './utils/claudeVersion.js';
export type { AgentLaunchOption } from './utils/agentLaunch.js';

export {
  AGENT_TERMINAL_ENVIRONMENT,
  AGENT_TERMINAL_ENV_UNSETS,
  withAgentTerminalEnvironment,
  withHiddenAgentTerminalEnvironment,
} from './utils/agentTerminalEnvironment.js';

export {
  deleteRegisteredSession,
  readRegisteredSession,
} from './utils/claudeSessionRegistry.js';

// Prompt Store
export {
  writePromptFile,
  deletePromptFile,
  buildPromptReadAndDeleteSnippet,
} from './utils/promptStore.js';

// AI Merge
export {
  getComprehensiveDiff,
  generateCommitMessage,
} from './utils/aiMerge.js';

// Merge commit primitives
export {
  commitChanges,
  stageAllChanges,
} from './utils/mergeValidation.js';

export { callOpenRouter } from './utils/openrouter.js';

// Shell Escaping
export { shQuote } from './utils/shellEscape.js';

// Pane Project
export { deriveProjectRootFromWorktreePath, getPaneProjectName, getPaneProjectRoot } from './utils/paneProject.js';

// Atomic Write
export {
  atomicWriteFileSync,
  atomicWriteFile,
  atomicWriteJsonSync,
  atomicWriteJson,
} from './utils/atomicWrite.js';

// Exec Async
export { execAsync, execFileAsync, getEnhancedPath, getEnhancedPathAsync } from './utils/execAsync.js';
export type { ExecAsyncOptions, ExecFileAsyncOptions } from './utils/execAsync.js';

// System Check
export {
  validateRequiredSystemRequirements,
  validateSystemRequirements,
} from './utils/systemCheck.js';
export { loadSystemRequirements } from './utils/systemRequirements.js';
export type { SystemRequirements, TmuxRequirement } from './utils/systemRequirements.js';
export { compareTmuxVersions, isSupportedTmuxVersion, parseTmuxVersion } from './utils/tmuxVersion.js';
export type { TmuxVersion } from './utils/tmuxVersion.js';
export { resolveTmuxProvider, selectAndFreezeTmuxProvider } from './utils/tmuxProvider.js';
export type { TmuxProviderResult, TmuxProviderStatus } from './utils/tmuxProvider.js';

// Action System
export type {
  ActionResultType,
  ActionOption,
  ActionResult,
  ActionContext,
  ActionFunction,
  ActionMetadata,
} from './actions/types.js';
export { PaneAction, ACTION_REGISTRY, getAvailableActions } from './actions/types.js';

// Action Implementations
export {
  viewPane,
  closePane,
  mergePane,
  renamePane,
  copyPath,
  openInEditor,
} from './actions/paneActions.js';

// Pane Sync Utilities (used by PaneWatcher in desktop)
export {
  MUXBASE_PANE_ID_OPTION,
  MUXBASE_PANE_INCARNATION_OPTION,
  ensureTmuxPaneIncarnationOption,
  rebindPaneByTitle,
  stampTmuxPaneIdOption,
  stampTmuxPaneIncarnationOption,
} from './utils/paneRebinding.js';
export { getUntrackedPanes, createShellPane, detectShellType, getNextMuxBaseId } from './utils/shellPaneDetection.js';
export { buildWorktreePaneTitle, getPaneTmuxTitle } from './utils/paneTitle.js';
export { destroyWelcomePaneCoordinated, createWelcomePaneCoordinated, ensureWelcomePane } from './utils/welcomePaneManager.js';

// Hooks
export {
  triggerHook,
  triggerHookSync,
  findHook,
  hasHook,
  listAvailableHooks,
  buildHookEnvironment,
} from './utils/hooks.js';
export type { HookType } from './utils/hooks.js';

// Timing Constants
export { TMUX_LAYOUT_APPLY_DELAY, TMUX_SPLIT_DELAY, TMUX_SHELL_READY_DELAY } from './constants/timing.js';

// Marketplace
export {
  AgentTranslator,
  assertSafeCloneTarget,
  canonicalizeSourceUrl,
  deriveCloneDirName,
  FormatDetector,
  GitOperations,
  HookTranslator,
  InstalledScanner,
  isBlockedHost,
  isMarketplaceErrorCode,
  isPrivateIp,
  MarketplaceInstaller,
  MarketplaceIntegrityInstaller,
  MarketplaceIntegrityError,
  MarketplaceRegistry,
  MarketplaceSourceTreeError,
  MarketplaceTransaction,
  digestPath,
  McpTranslator,
  SkillTranslator,
  buildSnapshot,
  diffAgainstSnapshot,
  validateSourceUrl,
} from './services/marketplace/index.js';
export type {
  DetectedPlugin,
  HookEntry,
  InstallResult,
  MarketplaceInstallPreview,
  MarketplacePreviewAgent,
  MarketplacePreviewArtifact,
  InstallStatus,
  InstalledPlugin,
  InstalledItem,
  InstalledItemType,
  JsPluginEntry,
  AgentEntry,
  MarketplaceFormat,
  MarketplaceRegistryData,
  MarketplaceSource,
  McpServerEntry,
  NativeMarketplaceConfig,
  NewArtifact,
  InstallSelection,
  MarketplaceInstallMode,
  MarketplaceErrorCode,
  MarketplaceIntegrityErrorCode,
  MarketplaceSourceTreeErrorCode,
  MarketplaceSourceSnapshot,
  MarketplaceTransactionalOptions,
  MarketplaceTransactionalResult,
  MarketplaceTransactionalUninstallResult,
  SkillEntry,
  SourceArtifactSnapshot,
  SourceUpdate,
  TranslationResult,
} from './services/marketplace/index.js';
