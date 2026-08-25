import type { AgentName } from './agents/agent-contract.js';

export const NO_INITIAL_PROMPT = 'No initial prompt';

export type AgentStatus = 'idle' | 'analyzing' | 'waiting' | 'working';

export interface ConflictMergeMetadata {
  transactionId: string;
  repoPath: string;
  mainRepoPath?: string;
  sourcePaneId: string;
  conflictPaneId: string;
  sourceBranch: string;
  targetBranch: string;
  sourceCommit: string;
  targetCommit: string;
}

export interface MuxBasePane {
  id: string;
  slug: string;
  title?: string;
  titleLocked?: boolean;
  branchName?: string;
  prompt: string;
  paneId: string;
  /**
   * Optional path to a local ANSI transcript file containing the pane's raw
   * terminal output (including control sequences). Desktop/Electron uses this
   * to faithfully replay full-screen TUIs (Claude Code/Codex) without losing
   * terminal modes (mouse reporting, alternate screen, etc).
   */
  terminalTranscriptPath?: string;
  projectRoot?: string;
  projectName?: string;
  type?: 'worktree' | 'shell';
  shellType?: string;
  worktreePath?: string;
  /** Backlog item that launched this pane, used by kanban views to avoid duplicate in-flight cards. */
  sourceBacklogId?: string;
  testWindowId?: string;
  testStatus?: 'running' | 'passed' | 'failed';
  testOutput?: string;
  devWindowId?: string;
  devStatus?: 'running' | 'stopped';
  devUrl?: string;
  agent?: AgentName;
  /** Whether this fresh agent launch intentionally submitted no initial message. */
  startedWithoutInitialPrompt?: boolean;
  /**
   * Which renderer a Claude pane was launched with. 'classic' is an explicit,
   * fixed-width compatibility profile; 'fullscreen' is the default and lets
   * Claude own conversation rendering on the alternate screen with 1:1 sizing.
   * Undefined for opencode/codex/shells.
   */
  claudeRenderer?: 'fullscreen' | 'classic';
  /** Exact tmux/PTY column contract established before launch, when applicable. */
  terminalFixedCols?: number;
  agentStatus?: AgentStatus;
  lastAgentCheck?: number;
  lastDeterministicStatus?: 'ambiguous' | 'working';
  optionsQuestion?: string;
  agentSessionId?: string;
  role?: 'review';
  review?: ReviewMetadata;
  conflictMerge?: ConflictMergeMetadata;
  duel?: DuelMetadata;
  model?: string;
  effort?: string;
}

export interface ReviewMetadata {
  sourcePaneId: string;
  sourceSlug: string;
  sourceWorktreePath?: string;
  reviewId: string;
  changedFiles: number;
  startedAt: number;
  handedOffAt?: number;
}

export interface DuelMetadata {
  groupId: string;
  role: 'a' | 'b';
  prompt: string;
  siblingPaneId?: string;
}

export interface PanePosition {
  paneId: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface WindowDimensions {
  width: number;
  height: number;
}

export interface ProjectSettings {
  testCommand?: string;
  devCommand?: string;
  firstTestRun?: boolean;
  firstDevRun?: boolean;
}

export interface MuxBaseSettings {
  // Agent permission mode
  // '' = agent default behavior, auto = safe workspace automation
  // acceptEdits/plan/bypassPermissions are legacy values normalized to auto for implementation panes
  permissionMode?: '' | 'auto' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  // Agent selection
  defaultAgent?: AgentName;
  // Tmux hooks for event-driven updates (low CPU)
  // true = use hooks, false = use polling, undefined = not yet asked
  useTmuxHooks?: boolean;
  // Base branch for new worktrees (e.g. 'main', 'master', 'develop')
  // When set, worktrees branch from this instead of the current HEAD
  baseBranch?: string;
  // Prefix for branch names (e.g. 'feat/' produces 'feat/fix-auth')
  branchPrefix?: string;
  // Create git worktrees for branch isolation per pane (opt-in; default: false)
  useWorktree?: boolean;
  initGitIfMissing?: boolean;
  // Claude Code model — '' lets Claude use its default; 'opus' tracks latest Opus
  claudeModel?: '' | 'opus' | 'sonnet' | 'haiku' | 'fable';
  // Claude Code reasoning effort — '' lets Claude use its default. 'ultracode' is a muxbase harness
  // marker that maps to CLI '--effort xhigh' plus MUXBASE_ULTRACODE=1 env hint for the spawned session.
  claudeEffort?: '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode';
  // Render Claude Code on its alternate-screen conversation renderer by default. Explicit false
  // keeps the known-lossy classic compatibility profile; see claudeRenderer on MuxBasePane.
  claudeFullscreenRendering?: boolean;
  // Codex model — '' lets muxbase defer to ~/.codex/config.toml
  codexModel?: '' | 'gpt-5-codex' | 'gpt-5' | 'o4-mini' | 'o3' | 'gpt-4.1';
  // Codex reasoning effort — '' lets Codex use its built-in default
  codexEffort?: '' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  // OpenCode --variant (provider-specific reasoning effort)
  opencodeVariant?: '' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  // Pi model accepts the documented provider/model form; empty uses Pi's configured default.
  piModel?: string;
  // Pi --thinking override; empty uses Pi's configured default.
  piThinking?: '' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  // Opt-in: use OpenCode's compact --mini TUI to preserve native terminal
  // scrollback and text selection. Standard OpenCode rendering is the default.
  opencodeScrollbackMode?: boolean;
}

export type SettingsScope = 'global' | 'project';

export interface SettingDefinition {
  key: keyof MuxBaseSettings | string;
  label: string;
  description: string;
  type: 'boolean' | 'select' | 'text' | 'action';
  options?: Array<{ value: string; label: string }>;
  /** Optional section for visual grouping inside a category (e.g. 'General', 'Claude Code', 'Codex', 'OpenCode'). */
  section?: string;
}

export interface MuxBaseAppProps {
  panesFile: string;
  projectName: string;
  sessionName: string;
  projectRoot?: string;
  settingsFile: string;
  autoUpdater?: unknown;
  controlPaneId?: string;
}

export interface MuxBaseConfig {
  projectName: string;
  projectRoot: string;
  panes: MuxBasePane[];
  settings: MuxBaseSettings;
  lastUpdated: string;
  controlPaneId?: string;
  controlPaneSize?: number;
  welcomePaneId?: string;
}

export type {
  LogEntry,
} from './services/LogService.js';
