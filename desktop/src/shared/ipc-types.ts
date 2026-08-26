import type {
  MuxBasePane,
  AgentCapability,
  SettingsScope,
  AgentName,
} from 'muxbase/core';
import type { TerminalAlternateScreenMode } from './terminal-scroll-protocol.js';
import type { TerminalThemePreference } from './theme-mode.js';

export type AppBootState =
  | { phase: 'starting'; revision: number }
  | { phase: 'ready'; revision: number }
  | { phase: 'blocked'; revision: number; errors: string[] }
  | { phase: 'failed'; revision: number; message: string };

export interface AppFileFlushRequest {
  requestId: string;
}

export interface AppFileFlushResultRequest extends AppFileFlushRequest {
  success: boolean;
}

export interface SerializableActionResult {
  type: 'success' | 'error' | 'confirm' | 'choice' | 'input' | 'info' | 'progress' | 'navigation';
  message: string;
  error?: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  callbackId?: string;
  options?: Array<{ id: string; label: string; description?: string; danger?: boolean; default?: boolean }>;
  placeholder?: string;
  defaultValue?: string;
  progress?: number;
  targetPaneId?: string;
  data?: unknown;
  dismissable?: boolean;
}

// --- LLM provider health ---

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'kimi' | 'glm';
export type ProviderHealthLevel = 'ok' | 'degraded' | 'down' | 'unknown';

export interface ProviderArenaEntry {
  rank: number;
  elo: number;
  ci: number;
  votes: number;
}

export interface ProviderModelScore {
  id?: string;
  name: string;
  score: number;
  status: 'good' | 'warning' | 'critical';
  trend: 'up' | 'down' | 'stable';
  history: number[];
  measuredAt?: number;
  arena?: ProviderArenaEntry;
}

export interface ProviderQuality {
  score: number | null;
  level: ProviderHealthLevel;
  trend: 'up' | 'down' | 'stable' | null;
  models: ProviderModelScore[];
  measuredAt: number | null;
  arenaTotal?: number;
  arenaUpdatedAt?: number;
}

export interface ProviderOperational {
  level: ProviderHealthLevel;
  description: string | null;
}

export interface ProviderStatus {
  provider: ProviderId;
  level: ProviderHealthLevel;
  quality: ProviderQuality;
  operational: ProviderOperational;
  sparkline: number[];
  updatedAt: number;
}

export type ProviderStatusMap = Partial<Record<ProviderId, ProviderStatus>>;

export interface ProviderStatusResponse {
  statuses: ProviderStatusMap;
  fetchedAt: number;
  error?: string;
}

// --- Agent CLI health (Margin Lab) ---

export type AgentHealthAgent = 'claude' | 'codex';

export interface AgentHealthSnapshot {
  agent: AgentHealthAgent;
  trackedModel: string;
  passRate: number;
  ciLower: number;
  ciUpper: number;
  passed: number;
  displayRunsCount: number;
  date: string;
  measuredAt: number;
  trackerUrl: string;
}

export type AgentHealthMap = Partial<Record<AgentHealthAgent, AgentHealthSnapshot>>;

export interface AgentHealthResponse {
  snapshots: AgentHealthMap;
  fetchedAt: number;
  error?: string;
}

// --- Request types ---

export interface PastSession {
  id: string;
  title: string;
  updatedAt: number;
}

export const PAST_SESSIONS_INITIAL_VISIBLE = 10;

export interface PaneSessionListRequest {
  agent: AgentName;
  projectRoot: string;
  /** Caps how many sessions are read; omit to read them all. */
  limit?: number;
}

export interface PaneSessionListResponse {
  sessions: PastSession[];
  /** Sessions the agent has for this project, whether or not `limit` truncated the read. */
  total?: number;
  error?: string;
}

export interface PaneCreateRequest {
  prompt: string;
  agent?: AgentName;
  projectRoot?: string;
  type?: 'agent' | 'shell';
  useWorktree?: boolean;
  paneName?: string;
  model?: string;
  effort?: string;
  resumeSessionId?: string;
  claudeRenderer?: 'classic';
}

export interface PaneCreateResponse {
  success: boolean;
  pane?: MuxBasePane;
  needsAgentChoice?: boolean;
  availableAgents?: AgentName[];
  error?: string;
  claudeFullscreenPreflightFailed?: boolean;
}

export interface PaneCloseRequest {
  paneId: string;
}

export interface PaneMergeRequest {
  paneId: string;
}

export interface PaneRenameRequest {
  paneId: string;
  newName: string;
}

export interface PaneResumeFullscreenRequest {
  paneId: string;
}

export interface PaneJumpRequest {
  paneId: string;
}

export interface PaneSendKeysRequest {
  paneId: string;
  command: string;
}

export interface PaneGetContentRequest {
  paneId: string;
}

export interface PaneDuplicateRequest {
  paneId: string;
}

export interface DuelSideConfig {
  agent: AgentName;
  model?: string;
  effort?: string;
}

export interface PaneDuelCreateRequest {
  prompt: string;
  sides: [DuelSideConfig, DuelSideConfig];
  useWorktree?: boolean;
  projectRoot?: string;
  paneName?: string;
  claudeRenderer?: 'classic';
}

export interface PaneDuelCreateResponse {
  success: boolean;
  groupId?: string;
  paneA?: MuxBasePane;
  paneB?: MuxBasePane;
  survivorPaneId?: string;
  error?: string;
  claudeFullscreenPreflightFailed?: boolean;
}

export interface PaneDuelResolveRequest {
  winnerPaneId: string;
}

export interface PaneDuelResolveResponse {
  success: boolean;
  loserPaneId?: string;
  error?: string;
}

export interface PaneCreateWorktreeRequest {
  paneId: string;
}

export interface PaneCreateWorktreeResponse {
  success: boolean;
  worktreePath?: string;
  branchName?: string;
  error?: string;
}

export interface PaneStartReviewRequest {
  paneId: string;
  agent?: AgentName;
}

export interface PaneStartReviewResponse {
  success: boolean;
  reviewId?: string;
  pane?: MuxBasePane;
  error?: string;
}

export interface PaneSendFixRequest {
  reviewPaneId: string;
}

export type ReviewSnapshotDrift = 'changed' | 'unchanged' | 'unknown';

export interface PaneSendFixResponse {
  success: boolean;
  sourcePaneId?: string;
  snapshotDrift?: ReviewSnapshotDrift;
  /** True when the reviewer reported no actionable issues — UI should treat as a non-error info state. */
  noIssues?: boolean;
  error?: string;
}

export interface OrphanedWorktreeInfo {
  branch: string | null;
  gitStatus: 'clean' | 'dirty' | 'unavailable' | 'unchecked';
  lastModifiedMs: number;
  path: string;
  registration: 'registered' | 'unregistered' | 'unchecked';
  slug: string;
}

export interface WorktreeOrphansListResponse {
  success: boolean;
  worktrees: OrphanedWorktreeInfo[];
  error?: string;
}

export interface WorktreeInspectRequest {
  worktreePath: string;
}

export interface WorktreeInspectResponse {
  success: boolean;
  worktree?: OrphanedWorktreeInfo;
  error?: string;
}

export type WorktreeRemovalState = Pick<
  OrphanedWorktreeInfo,
  'branch' | 'gitStatus' | 'registration'
>;

export interface WorktreeRemoveRequest {
  allowDataLoss: boolean;
  expectedState: WorktreeRemovalState;
  worktreePath: string;
}

export interface WorktreeRemoveResponse {
  success: boolean;
  error?: string;
}

export interface WorktreeReopenRequest {
  worktreePath: string;
}

export interface PaneAttachWorktreeRequest {
  paneId: string;
  worktreePath: string;
}

export interface PaneAttachWorktreeResponse {
  success: boolean;
  worktreePath?: string;
  branchName?: string;
  error?: string;
}

export interface ActionCallbackRequest {
  callbackId: string;
  value?: string;
}

export interface TerminalAttachRequest {
  cols?: number;
  /** Exact column width for a fixed-grid terminal. */
  fixedCols?: number;
  paneId: string;
  rows?: number;
  sessionName: string;
  skipScrollbackReplay?: boolean;
  streamId?: number;
  transcriptPath?: string;
}

export interface TerminalAttachResponse {
  success: boolean;
  cols?: number;
  rows?: number;
  streamId?: number;
  mode?: TerminalStreamMode;
  error?: string;
}

export interface TerminalDetachRequest {
  paneId: string;
}

export interface TerminalResizeRequest {
  paneId: string;
  cols: number;
  rows: number;
}

export interface TerminalResizeResponse {
  success: boolean;
  error?: string;
}

export interface TerminalSelectionExpandRequest {
  anchorText: string;
  currentText: string;
  direction: 'down' | 'up';
  paneId: string;
}

export type TerminalSelectionExpandResponse =
  | { status: 'expanded'; text: string }
  | { status: 'history-unavailable' }
  | { status: 'range-not-found' };

export type TerminalScrollResponse =
  | { success: true }
  | { success: false; error: string };

export interface TerminalScrollRequest {
  alternateScreenMode?: TerminalAlternateScreenMode;
  direction: 'down' | 'up';
  lines: number;
  paneId: string;
}

export interface TerminalWriteRequest {
  data: string;
  paneId: string;
  userInitiated?: boolean;
}

export interface TerminalUnlockStdinRequest {
  paneId: string;
}

export interface ProjectSwitchRequest {
  fresh?: boolean;
  projectRoot: string;
}

export interface ProjectSwitchResponse {
  success?: boolean;
  project?: ProjectInfo;
  error?: string;
}

export interface ProjectFileSearchRequest {
  query: string;
  rootPath?: string;
}

export interface ProjectFileSearchResult {
  rootPath: string;
  path: string;
  filename: string;
}

export interface ProjectTextSearchRequest {
  query: string;
  rootPath?: string;
}

export interface ProjectTextSearchResult {
  rootPath: string;
  path: string;
  filename: string;
  lineNumber: number;
  lineContent: string;
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface FileListRequest {
  rootPath: string;
  dirPath?: string;
}

export interface FileListResponse {
  entries: FileEntry[];
  error?: string;
}

export interface FileReadRequest {
  rootPath: string;
  relativePath: string;
}

export type FileEol = 'lf' | 'crlf' | 'cr';

export type FileReadResponse =
  | {
      kind: 'editable-text';
      content: string;
      contentVersion: string;
      encoding: 'utf8';
      hasBom: boolean;
      eol: FileEol;
    }
  | {
      kind: 'readonly-text';
      reason: 'truncated' | 'mixed-eol';
      content: string;
      encoding: 'utf8';
      hasBom: boolean;
      sizeBytes: number;
    }
  | {
      kind: 'unsupported';
      reason: 'binary' | 'invalid-utf8';
      sizeBytes: number;
    }
  | {
      kind: 'error';
      code: 'NOT_FOUND' | 'NOT_AUTHORIZED' | 'IO_ERROR';
      message: string;
    };

export interface FileReadBinaryRequest {
  rootPath: string;
  relativePath: string;
}

export interface FileReadBinaryResponse {
  data: string;
  mimeType: string;
  error?: string;
}

interface FileWriteRequestBase {
  rootPath: string;
  relativePath: string;
  editorSessionId: string;
  saveSequence: number;
  documentVersion: number;
  content: string;
  hasBom: boolean;
  eol: FileEol;
}

export type FileWriteRequest = FileWriteRequestBase & (
  | {
      expectedMissing: true;
      expectedContentVersion: null;
    }
  | {
      expectedMissing?: false;
      expectedContentVersion: string;
    }
);

interface FileWriteResponseIdentity {
  editorSessionId: string;
  saveSequence: number;
  documentVersion: number;
}

export type FileWriteResponse = FileWriteResponseIdentity & (
  | { success: true; contentVersion: string }
  | {
      success: false;
      conflict?: boolean;
      conflictType?: FileMutationConflictType;
      currentContentVersion?: string;
      error: string;
    }
);

export interface FileCreateRequest {
  rootPath: string;
  relativePath: string;
}

export interface FileDeleteRequest {
  rootPath: string;
  relativePath: string;
}

export interface FileRenameRequest {
  rootPath: string;
  oldPath: string;
  newPath: string;
}

export interface FileCopyRequest {
  sourceRootPath: string;
  sourcePath: string;
  destRootPath: string;
  destDir: string;
}

export type FileMoveMode = 'move' | 'copy';

export type FileMoveErrorCode =
  | 'DUPLICATE_TARGET'
  | 'EACCES'
  | 'EEXIST'
  | 'ENOENT'
  | 'INVALID'
  | 'UNKNOWN';

export interface FileMoveRequest {
  rootPath: string;
  sourcePaths: string[];
  destDir: string;
  mode: FileMoveMode;
}

/**
 * A discriminated union, not a bag of optionals: `finalPath` is guaranteed present exactly when a
 * target exists, so a remap can never be handed an undefined destination.
 */
export type FileMoveItemResult =
  | { sourcePath: string; status: 'succeeded'; finalPath: string }
  | { sourcePath: string; status: 'partial'; finalPath: string; code: FileMoveErrorCode; error: string }
  | { sourcePath: string; status: 'failed'; code: FileMoveErrorCode; error: string };

/**
 * Applied and rejected are mutually exclusive: a request that changed the filesystem reports only
 * results, and one rejected in preflight reports only why. Mixing them would let a caller act on a
 * mutation that its own verdict says never happened.
 *
 * A rejection carries no results, expressed as `[]` so the exclusivity holds at compile time.
 * That makes `results` a union of array types, so readers widen it once before filtering.
 */
export type FileMoveResponse =
  | { results: FileMoveItemResult[]; code?: never; error?: never }
  | { results: []; code: FileMoveErrorCode; error: string };

export type FileMutationConflictType = 'deleted' | 'modified';

export interface FileMutationResponse {
  success: boolean;
  conflict?: boolean;
  conflictType?: FileMutationConflictType;
  currentMtimeMs?: number;
  mtimeMs?: number;
  error?: string;
}

export interface FileWatchRootRequest {
  rootPath?: string;
  dirPaths?: string[];
}

export type FileChangedEventType = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';

export interface FileChangedEvent {
  changeType: FileChangedEventType;
  relativePath: string;
  rootPath: string;
}

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

export interface FormatDocumentRequest {
  content: string;
  documentVersion: number;
  editorSessionId: string;
  eol: FileEol;
  fileKey: string;
  relativePath: string;
  requestId: string;
  rootPath: string;
}

export interface FormatDocumentCancelRequest {
  requestId: string;
}

interface FormatDocumentResponseIdentity {
  documentVersion: number;
  editorSessionId: string;
  fileKey: string;
  requestId: string;
}

export type FormatDocumentResponse = FormatDocumentResponseIdentity & (
  | {
      success: true;
      status: 'formatted' | 'ignored' | 'unchanged';
      changes: TextChange[];
    }
  | {
      success: false;
      code: 'CANCELLED' | 'SUPERSEDED' | 'TIMEOUT' | 'CRASHED' | 'INVALID_RESPONSE' | 'FORMAT_ERROR';
      error: string;
    }
);

export interface SettingsGetRequest {
  projectRoot?: string;
}

export interface SettingsUpdateRequest {
  key: string;
  value: unknown;
  scope: SettingsScope;
}

export interface GitDiffRequest {
  worktreePath: string;
  diffMode?: GitDiffMode;
}

export interface GitFileDiffRequest {
  worktreePath: string;
  diffMode?: GitDiffMode;
  path: string;
  oldPath?: string;
}

export type GitDiffMode = 'working' | 'branch' | 'commit';

export type GitChangedFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'untracked'
  | 'conflict'
  | 'unknown';

export interface GitDiffFileEntry {
  path: string;
  oldPath?: string;
  status: GitChangedFileStatus;
  staged: boolean;
  unstaged: boolean;
  additions: number;
  deletions: number;
  patch?: string;
  isBinary?: boolean;
  tooLarge?: boolean;
}

interface GitRepoState {
  isGitRepo: boolean;
  branch?: string;
  detachedHead?: boolean;
  repoRoot?: string;
  isWorktree?: boolean;
}

export interface GitDiffResponse {
  diff: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  changedFiles?: string[];
  untrackedFiles?: string[];
  files?: GitDiffFileEntry[];
  repo?: GitRepoState;
  commitsAhead?: number | null;
  recentCommits?: { sha: string; message: string }[];
  error?: string;
}

export interface GitFileDiffResponse {
  path: string;
  patch?: string;
  isBinary?: boolean;
  tooLarge?: boolean;
  error?: string;
}

export interface GitStatusRequest {
  worktreePath: string;
}

export interface LspAcquireRequest {
  editorSessionId: string;
  relativePath: string;
  rootPath: string;
}

export type LspAcquireResponse =
  | { success: true; rootId: string }
  | {
      success: false;
      code:
        | 'CIRCUIT_OPEN'
        | 'CLASSIC_PLUGIN'
        | 'CLASSIC_TYPESCRIPT'
        | 'DISABLED'
        | 'RESOURCE_LIMIT'
        | 'START_FAILED'
        | 'UNSUPPORTED_LANGUAGE'
        | 'UNTRUSTED';
      error: string;
    };

export interface LspReleaseRequest {
  editorSessionId: string;
  rootId: string;
}

export interface LspSendRequest extends LspReleaseRequest {
  message: string;
}

export type LspEvent =
  | { type: 'message'; rootId: string; message: string }
  | {
      type: 'status';
      rootId: string;
      status: 'crashed' | 'restarting' | 'started' | 'stopped';
      detail?: string;
    };

export interface GitStatusResponse {
  hasChanges?: boolean;
  commitsAhead?: number | null;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  error?: string;
}

export interface GitBranchesRequest {
  projectRoot: string;
}

// --- Push event payloads ---

export interface TerminalDataEvent {
  paneId: string;
  data: string;
  source?: TerminalDataSource;
  streamId: number;
}

export interface TerminalStreamModeChangedEvent {
  paneId: string;
  streamId: number;
  mode: TerminalStreamMode;
}

export type TerminalDataSource = 'live' | 'replay';

export type TerminalStreamMode = 'capture' | 'control' | 'pty' | 'transcript';

export type TerminalTransportMode = 'classic' | 'control' | 'pty';

type TerminalOsc52ClipboardMode = 'allow' | 'off';

export interface ToastEvent {
  message: string;
  severity: 'success' | 'error' | 'info' | 'warning';
}

export interface ProgressEvent {
  action: string;
  active: boolean;
}

// --- Project discovery ---

export interface ProjectInfo {
  name: string;
  root: string;
  sessionName: string;
  configPath: string;
  paneCount: number;
}

// --- Session info ---

export interface SessionInfoResult {
  logDir?: string | null;
  logFile?: string | null;
  sessionName: string;
  projectName: string;
  projectRoot: string;
  homeDir: string;
}

export interface SupportBundleResult {
  includedFiles: string[];
  path: string;
}

export interface SupportBundlePreviewFile {
  category: 'log' | 'metadata' | 'transcript';
  name: string;
  sizeBytes: number;
}

export interface SupportBundlePreview {
  files: SupportBundlePreviewFile[];
  includeTranscripts: boolean;
  redactionNote: string;
  totalBytes: number;
}

export interface AppInfoResult {
  isPackaged: boolean;
  version: string;
  buildNumber?: string;
  buildVersion: string;
}

/**
 * A code editor detected on the user's system. `command` is the CLI binary
 * (or a `cmd arg…` shell-style token list) used to launch it.
 *
 * `system` represents the "let the OS decide" option — uses $EDITOR if set,
 * else falls back to `code` (existing behavior). Always present so the user
 * can pick the historical default explicitly.
 */
export interface EditorDescriptor {
  id: string;        // 'vscode' | 'cursor' | 'windsurf' | 'zed' | 'sublime' | 'idea' | 'webstorm' | 'pycharm' | 'system' | string
  label: string;     // 'VS Code'
  command: string;   // 'code' or '/Applications/Cursor.app/…/cursor'
  /** Origin of the entry — useful for sorting/grouping. */
  source: 'path' | 'app' | 'env' | 'fallback';
}

export interface ListEditorsResponse {
  editors: EditorDescriptor[];
}

// --- System check ---

export interface SystemCheckResult {
  tmux: { available: boolean; version?: string };
  git: { available: boolean; version?: string };
  agents: AgentName[];
}

// --- Electron-specific settings (stored via electron-store) ---

export type SidebarOrganize = 'project' | 'flat';
export type SidebarSort = 'priority' | 'updated' | 'manual';

export interface ElectronSettings {
  // Appearance
  theme: 'dark' | 'light' | 'colorful' | 'dark-colorful' | 'system';
  terminalFontFamily: string;
  terminalFontSize: number;
  uiZoom: number;
  compactMode: boolean;
  // Terminal
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
  scrollbackLines: number;
  copyOnSelect: boolean;
  opencodeMousePassthrough: boolean;
  terminalBell: boolean;
  terminalOsc52Clipboard: TerminalOsc52ClipboardMode;
  terminalPreferredLaunchCols: number;
  terminalPreferredLaunchRows: number;
  terminalTheme: TerminalThemePreference;
  terminalTransport: TerminalTransportMode;
  // Sidebar
  sidebarCollapsed: boolean;
  sidebarOrganize: SidebarOrganize;
  sidebarSort: SidebarSort;
  sidebarWidth: number;
  // Window
  alwaysOnTop: boolean;
  windowOpacity: number;
  // Advanced
  debugLogging: boolean;
  enableKanbanBoard: boolean;
  enablePaneSummary: boolean;
  enableTelemetryCostTracking: boolean;
  costCurrency: 'USD' | 'EUR-hai' | 'EUR-market';
  enableConversationTopics: boolean;
  /** Explicit consent to let MuxBase install local agent lifecycle hook adapters. */
  enableAgentLifecycleAdapters: boolean;
  enableReviewAgent: boolean;
  enableLanguageIntelligence: boolean;
  pollingInterval: number;
  showPerformanceMetrics: boolean;
  showArenaScores: boolean;
  showAgentHealthTracker: boolean;
  disableExternalNetwork: boolean;
}

export interface ElectronSettingsUpdateRequest {
  key: keyof ElectronSettings;
  value: ElectronSettings[keyof ElectronSettings];
}

export interface PerformanceMetricsEvent {
  activity: {
    rates: {
      gitStatusPollsPerSecond: number;
      statusCaptureRequestsPerSecond: number;
      statusTmuxInvocationsPerSecond: number;
      terminalOutputEventsPerSecond: number;
      terminalOutputKBPerSecond: number;
    };
    totals: {
      gitStatusPolls: number;
      statusCaptureRequests: number;
      statusTmuxInvocations: number;
      terminalOutputBytes: number;
      terminalOutputEvents: number;
    };
  };
  cpuPercent: number;
  memoryMB: number;
  details: Array<{ type: string; cpu: number; memory: number }>;
}

export type RendererLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RendererLogRequest {
  level: RendererLogLevel;
  scope: string;
  message: string;
  data?: unknown;
}

// --- Agent defaults ---

export interface AgentListRequest {
  capability?: AgentCapability;
}

export interface AgentDefaultSlice {
  model?: string;
  effort?: string;
}

export interface OpencodeDefaults extends AgentDefaultSlice {
  modelByMode?: Record<string, string>;
  availableModels?: string[];
}

export interface AgentDefaultsResponse {
  claude: AgentDefaultSlice;
  codex: AgentDefaultSlice;
  opencode: OpencodeDefaults;
  pi: AgentDefaultSlice;
}

// --- Agent session ---

export interface AgentSessionGetRequest {
  paneId: string;
}

export interface AgentSessionSearchRequest {
  query: string;
}

export interface AgentSessionSearchResult {
  paneId: string;
  paneSlug: string;
  messageId: string;
  messageType: string;
  snippet: string;
  timestamp?: number;
}

export interface AgentSessionUpdatedEvent {
  paneId: string;
  session: import('./agent-session-types').NormalizedSession;
}

export interface AgentSessionRemovedEvent {
  paneId: string;
}

// --- Workspace history ---

export interface WorkspaceHistoryEntry {
  name: string;
  root: string;
  lastOpened: number;
  paneCount: number;
}

export interface WorkspaceHistoryTouchRequest {
  name: string;
  root: string;
  paneCount: number;
}

export interface WorkspaceHistoryRemoveRequest {
  root: string;
}

export interface WorkspaceOpenFolderResponse {
  canceled: boolean;
  path?: string;
}

export interface WorkspaceNewProjectResponse {
  canceled: boolean;
  path?: string;
  error?: string;
}

export interface WorkspaceCreateSessionRequest {
  folderPath: string;
}

export interface WorkspaceCreateSessionResponse {
  success: boolean;
  project?: ProjectInfo;
  error?: string;
}

// --- Preload API exposed to renderer via contextBridge ---

/**
 * Persisted appearance settings read synchronously during preload so the first
 * renderer frame is painted in the user's theme instead of the async default.
 */
export interface MuxBaseBootSettings {
  terminalSelectionIntegrationEnabled: boolean;
  theme: ElectronSettings['theme'];
  terminalTheme: ElectronSettings['terminalTheme'];
  sidebarCollapsed: ElectronSettings['sidebarCollapsed'];
  sidebarOrganize: ElectronSettings['sidebarOrganize'];
  sidebarSort: ElectronSettings['sidebarSort'];
  sidebarWidth: ElectronSettings['sidebarWidth'];
}

export interface MuxBaseElectronAPI {
  bootSettings: MuxBaseBootSettings;
  invoke: <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>;
  on: (channel: string, callback: (...args: unknown[]) => void) => () => void;
}

// --- Marketplace ---

export interface MarketplaceSourceAddRequest {
  url: string;
}

export interface MarketplaceSourceAddResponse {
  success: boolean;
  source?: import('muxbase/core').MarketplaceSource;
  error?: string;
}

export interface MarketplaceSourceRemoveRequest {
  url: string;
}

export interface MarketplaceSourceUpdateRequest {
  url: string;
}

export interface MarketplaceBrowseRequest {
  sourceUrl: string;
}

export interface MarketplaceBrowseResponse {
  plugins: import('muxbase/core').DetectedPlugin[];
  error?: string;
}

export type MarketplaceInstallIntent =
  | {
      mode: 'selected';
      selectedSkills: string[];
      selectedMcpServers: string[];
      selectedAgents: string[];
    }
  | {
      mode: 'full';
      selectedSkills?: never;
      selectedMcpServers?: never;
      selectedAgents?: never;
    };

export interface MarketplaceRequestIdentity {
  pluginId: string;
  sourceUrl: string;
}

export type MarketplacePreviewRequest = MarketplaceRequestIdentity & MarketplaceInstallIntent;

export interface MarketplacePreviewResponse {
  success: boolean;
  preview?: import('muxbase/core').MarketplaceInstallPreview;
  error?: string;
  errorCode?: import('muxbase/core').MarketplaceErrorCode;
  affectedPaths?: string[];
}

export type MarketplaceInstallRequest = MarketplaceRequestIdentity & MarketplaceInstallIntent & {
  previewDigest: string;
};

export interface MarketplaceInstallResponse {
  success: boolean;
  result?: import('muxbase/core').InstallResult;
  error?: string;
  errorCode?: import('muxbase/core').MarketplaceErrorCode;
  affectedPaths?: string[];
}

export interface MarketplaceUninstallRequest {
  pluginId: string;
  sourceUrl: string;
}

export interface MarketplaceUninstallResponse {
  success: boolean;
  error?: string;
  errorCode?: MarketplaceInstallResponse['errorCode'];
  affectedPaths?: string[];
  /** Owned artifacts retained because their bytes no longer match the manifest. */
  preservedArtifacts?: string[];
}
