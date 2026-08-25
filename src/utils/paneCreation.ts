import * as fs from 'fs';
import path from 'path';
import { assertNever, type AgentName } from '../agents/agent-contract.js';
import { findPiSessionFile } from '../agents/pi-runtime.js';
import {
  NO_INITIAL_PROMPT,
  type MuxBaseConfig,
  type MuxBasePane,
  type DuelMetadata,
  type ReviewMetadata,
} from '../types.js';
import { TmuxService } from '../services/TmuxService.js';
import {
  getTerminalDimensions,
} from './tmux.js';
import { recalculateAndApplyLayout } from './layoutManager.js';
import { SettingsManager } from './settingsManager.js';
import { generateLocalSlug, sanitizeSlug } from './slug.js';
import { triggerHook, initializeHooksDirectory } from './hooks.js';
import { TMUX_LAYOUT_APPLY_DELAY } from '../constants/timing.js';
import { upsertMuxBasePane } from './muxbaseConfigMutation.js';
import { LogService } from '../services/LogService.js';
import { appendSlugSuffix } from './agentLaunch.js';
import { buildWorktreePaneTitle } from './paneTitle.js';
import { isValidBranchName } from './git.js';
import { execFileAsync } from './execAsync.js';
import { launchAgentInPane } from './paneAgentLaunch.js';
import { resumeAgentInPane } from './paneAgentLifecycle.js';
import { assertClaudeFullscreenSupported } from './claudeVersion.js';
import { stampTmuxPaneIdOption, stampTmuxPaneIncarnationOption } from './paneRebinding.js';
import { getPaneActivityJournalPath } from './paneActivityJournal.js';
import {
  resizePaneBeforeAgentLaunch,
  resolvePaneBirthGeometry,
} from './paneTerminalGeometry.js';
import { resolvePaneTerminalProfile } from './paneTerminalProfile.js';
import {
  buildGitRefVerifyArgs,
  buildGitRefVerifyCommand,
  buildGitWorktreeAddArgs,
  buildGitWorktreeShellCommand,
  chooseAvailableSlug,
  getAllLocalBranches,
  getCheckedOutWorktreeBranches,
  gitCommandSucceeds,
  isWorktreeCollisionError,
  shouldFallbackDirectWorktreeToTmuxShell,
} from './paneCreationGit.js';
import {
  waitForAgentInputReady,
  waitForPaneReady,
  waitForShellReady,
} from './paneCreationReadiness.js';
import { PaneCreationRollback } from './paneCreationRollback.js';
import { allocateTmuxPane, resolveControlPane } from './paneCreationTmux.js';
import { shQuote } from './shellEscape.js';
import { destroyWelcomePaneCoordinated } from './welcomePaneManager.js';
import { getManagedWorktreePath, getProjectConfigPath } from './worktreePaths.js';
import { setupPaneTranscript } from './tmuxTranscript.js';

export { isAgentRunningInPane, resumeAgentInPane } from './paneAgentLifecycle.js';
export { buildGitRefVerifyArgs, buildGitRefVerifyCommand } from './paneCreationGit.js';
export { createWorktreeForPane } from './paneWorktree.js';

export interface CreatePaneOptions {
  prompt: string;
  /**
   * Optional: initial message sent to the agent after launch.
   *
   * - Defaults to `prompt` (backward compatible)
   * - Set to '' to start the agent "fresh" while still using `prompt` for
   *   naming/slug/worktree metadata.
   */
  agentPrompt?: string;
  agent?: AgentName;
  slugSuffix?: string;
  slugBase?: string;
  projectName: string;
  existingPanes: MuxBasePane[];
  projectRoot?: string; // Target repository root for the new pane
  sessionConfigPath?: string; // Shared muxbase config file for the current session
  sessionProjectRoot?: string; // Session root that owns sidebar/welcome pane state
  controlPaneId?: string; // Pre-resolved control pane ID (skips getCurrentPaneIdSync when provided, needed for Electron)
  sessionName?: string; // Target tmux session name (needed when creating detached windows)
  initialPromptMode?: 'argument' | 'input'; // Desktop can send prompt as input for interactive CLIs
  layoutMode?: 'sidebar' | 'window'; // Sidebar layout for TUI, window-per-pane for desktop/headless
  useWorktree?: boolean; // Override worktree setting for this pane (reads from settings when omitted)
  /**
   * Optional directory for writing a raw ANSI transcript of the tmux pane's
   * output. When provided, muxbase will start `tmux pipe-pane` before launching
   * the agent, so downstream viewers (Electron) can replay the exact terminal
   * stream (including mode toggles like mouse reporting).
   */
  terminalTranscriptDir?: string;
  /** Create worktree directly from Node.js instead of through tmux shell (skips polling) */
  directWorktreeCreation?: boolean;
  /** Skip lifecycle hooks (desktop has its own hook management) */
  skipHooks?: boolean;
  /** Commit-ish (branch or SHA) used as the start point when creating the worktree branch */
  worktreeStartPoint?: string;
  /** Launch the agent in read-only mode (review panes never edit files) */
  readOnly?: boolean;
  /** Seed a file into the new worktree before the agent launches (e.g. a review rubric the agent reads) */
  worktreeSeedFile?: { relativePath: string; content: string };
  /** Pane role: 'review' marks a read-only reviewer pane */
  role?: 'review';
  /** Review linkage metadata, set when role is 'review' */
  review?: ReviewMetadata;
  /** Duel linkage metadata, set when this pane is one side of a comparison */
  duel?: DuelMetadata;
  /** OTLP endpoint URL injected into Claude pane env so Claude Code reports telemetry to MuxBase. */
  otlpEndpoint?: string;
  /** Explicit user consent for installing lifecycle adapters that write agent configuration. */
  enableActivityAdapters?: boolean;
  /** Per-pane override: model alias/id (Claude: opus|sonnet|haiku|fable; Codex: any model id) */
  model?: string;
  /** Per-pane override: reasoning effort level (Claude: low|medium|high|xhigh|max; Codex: minimal|low|medium|high|xhigh) */
  effort?: string;
  /** When set, resumes this session ID instead of launching a new agent session */
  resumeSessionId?: string;
  /** Explicit per-pane renderer override used by the classic compatibility choice. */
  claudeRenderer?: 'classic';
  /** Best-known visible terminal geometry to apply before launching an agent. */
  initialTerminalSize?: { cols: number; rows: number };
  /**
   * Optimistic emit: `onReady` receives the fully-built pane BEFORE the agent
   * launches so the caller can render it immediately; `onRollback` retracts that
   * emit if the launch then fails. Grouping the two makes the pairing a type
   * invariant — you can't supply one without the other.
   */
  earlyEmit?: {
    onReady: (pane: MuxBasePane) => void;
    onRollback: (paneId: string) => void;
  };
}

export type CreatePaneResult =
  | { pane: MuxBasePane; needsAgentChoice: false }
  | { pane: null; needsAgentChoice: true };

const MIN_INITIAL_TERMINAL_COLS = 2;
const MIN_INITIAL_TERMINAL_ROWS = 2;
const MAX_INITIAL_TERMINAL_COLS = 1000;
const MAX_INITIAL_TERMINAL_ROWS = 500;

interface InitialTerminalSize {
  cols: number;
  rows: number;
}

function normalizeInitialTerminalSize(size?: InitialTerminalSize): InitialTerminalSize | null {
  if (!size) return null;
  if (!Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return null;

  const cols = Math.floor(size.cols);
  const rows = Math.floor(size.rows);
  if (cols < MIN_INITIAL_TERMINAL_COLS || rows < MIN_INITIAL_TERMINAL_ROWS) return null;
  if (cols > MAX_INITIAL_TERMINAL_COLS || rows > MAX_INITIAL_TERMINAL_ROWS) return null;

  return { cols, rows };
}

/**
 * Core pane creation logic that can be used by both TUI and API
 * Returns the newly created pane and whether agent choice is needed
 */
export async function createPane(
  options: CreatePaneOptions,
  availableAgents: AgentName[]
): Promise<CreatePaneResult> {
  const t0 = Date.now();
  const elapsed = () => `${Date.now() - t0}ms`;
  const log = LogService.getInstance();

  const {
    prompt,
    agentPrompt: optionsAgentPrompt,
    projectName,
    existingPanes,
    slugSuffix,
    slugBase,
    sessionConfigPath: optionsSessionConfigPath,
    sessionProjectRoot: optionsSessionProjectRoot,
    controlPaneId: optionsControlPaneId,
    sessionName: optionsSessionName,
    initialPromptMode: optionsPromptMode,
    layoutMode: optionsLayoutMode,
    useWorktree: optionsUseWorktree,
    terminalTranscriptDir,
    directWorktreeCreation,
    skipHooks,
    worktreeStartPoint,
    readOnly,
    worktreeSeedFile,
    role,
    review,
    duel,
  } = options;
  const { resumeSessionId } = options;
  const initialTerminalSize = normalizeInitialTerminalSize(options.initialTerminalSize);
  let { agent, projectRoot: optionsProjectRoot } = options;

  // Backward compatible default: if agentPrompt isn't provided, use prompt.
  const agentPrompt = optionsAgentPrompt ?? prompt;

  log.info(`[createPane] START prompt="${prompt.slice(0, 50)}" agent=${agent}`, 'paneCreation');

  // Get project root (handle git worktrees correctly)
  let projectRoot: string;
  if (optionsProjectRoot) {
    projectRoot = optionsProjectRoot;
  } else {
    try {
      // For git worktrees, we need to get the main repository root, not the worktree root
      // git rev-parse --git-common-dir gives us the main .git directory
      const gitCommonDir = await execFileAsync('git', ['rev-parse', '--git-common-dir']);

      // If it's a worktree, gitCommonDir will be an absolute path to main .git
      // If it's the main repo, it will be just '.git'
      if (gitCommonDir === '.git') {
        // We're in the main repo
        projectRoot = await execFileAsync('git', ['rev-parse', '--show-toplevel']);
      } else {
        // We're in a worktree, get the parent directory of the .git directory
        projectRoot = path.dirname(gitCommonDir);
      }
    } catch {
      projectRoot = process.cwd();
    }
  }

  const settingsManager = new SettingsManager(projectRoot);
  const settings = settingsManager.getSettings();
  const useWorktree = optionsUseWorktree ?? settings.useWorktree ?? false;

  const sessionProjectRoot = optionsSessionProjectRoot
    || (optionsSessionConfigPath ? path.dirname(path.dirname(optionsSessionConfigPath)) : projectRoot);
  const paneProjectName = path.basename(projectRoot);
  const promptMode: 'argument' | 'input' = optionsPromptMode || 'argument';
  const layoutMode: 'sidebar' | 'window' = optionsLayoutMode || 'sidebar';

  // If no agent specified, check settings for default agent
  if (!agent && settings.defaultAgent) {
    // Only use default if it's available
    if (availableAgents.includes(settings.defaultAgent)) {
      agent = settings.defaultAgent;
    }
  }

  // Determine if we need agent choice
  if (!agent && availableAgents.length > 1) {
    // Need to ask which agent to use
    return {
      pane: null,
      needsAgentChoice: true,
    };
  }

  // Auto-select agent if only one is available or if not specified
  if (!agent && availableAgents.length === 1) {
    agent = availableAgents[0];
  }

  const startedWithoutInitialPrompt = agent && !resumeSessionId
    ? agentPrompt.trim().length === 0
    : undefined;

  const effectiveSettings = {
    ...applyPerPaneOverride(settings, agent, options.model, options.effort),
    ...(options.claudeRenderer === 'classic' ? { claudeFullscreenRendering: false } : {}),
  };
  const terminalProfile = resolvePaneTerminalProfile(agent, effectiveSettings);
  if (terminalProfile.claudeRenderer === 'fullscreen') {
    await assertClaudeFullscreenSupported();
  }

  if (!skipHooks) {
    await triggerHook('before_pane_create', projectRoot, undefined, {
      MUXBASE_PROMPT: prompt,
      MUXBASE_AGENT: agent || 'unknown',
    });
  }

  const existingSlugs = new Set(existingPanes.map((p) => p.slug));
  const branchPrefix = settings.branchPrefix || '';

  if (useWorktree && branchPrefix && !isValidBranchName(branchPrefix)) {
    throw new Error(`Invalid branch prefix: ${branchPrefix}`);
  }

  // Generate slug (filesystem-safe directory name)
  // Uses fast local extraction — no network calls, instant result.
  // Sanitize any externally-supplied slugBase (dialog Name, review prefix) so
  // it can't smuggle spaces or special chars into git branch / worktree paths.
  // If sanitisation strips everything, fall back to keyword-extraction.
  const sanitizedBase = slugBase ? sanitizeSlug(slugBase) : '';
  const generatedSlug = sanitizedBase || generateLocalSlug(prompt);
  const initialSlug = appendSlugSuffix(generatedSlug, slugSuffix);
  // When a start point is provided the worktree branch must be brand-new, so
  // reject any slug whose branch already exists (including orphaned branches left
  // by a removed worktree), not just branches currently checked out.
  const checkedOutBranches = (useWorktree && directWorktreeCreation)
    ? worktreeStartPoint
      ? await getAllLocalBranches(projectRoot)
      : await getCheckedOutWorktreeBranches(projectRoot)
    : new Set<string>();

  let slug = chooseAvailableSlug(initialSlug, (candidateSlug) => {
    if (existingSlugs.has(candidateSlug)) {
      return true;
    }

    if (!useWorktree || !directWorktreeCreation) {
      return false;
    }

    const candidateWorktreePath = getManagedWorktreePath(projectRoot, candidateSlug);
    if (fs.existsSync(candidateWorktreePath)) {
      return true;
    }

    const candidateBranch = branchPrefix ? `${branchPrefix}${candidateSlug}` : candidateSlug;
    return checkedOutBranches.has(candidateBranch);
  });

  if (slug !== initialSlug) {
    log.info(
      `[createPane] slug adjusted "${initialSlug}" -> "${slug}" to avoid worktree collisions [${elapsed()}]`,
      'paneCreation'
    );
  }
  existingSlugs.add(slug);

  const tmuxService = TmuxService.getInstance();

  // Branch name and worktree path only needed when useWorktree is true
  let branchName: string | undefined;
  let worktreePath: string | undefined;

  if (useWorktree) {
    branchName = branchPrefix ? `${branchPrefix}${slug}` : slug;
    worktreePath = getManagedWorktreePath(projectRoot, slug);
  }

  // Get the original pane ID — use pre-resolved controlPaneId if provided (Electron runs outside tmux)
  const originalPaneId = optionsControlPaneId || tmuxService.getCurrentPaneIdSync();

  const configPath = optionsSessionConfigPath
    || getProjectConfigPath(sessionProjectRoot);
  let controlPaneId = await resolveControlPane({
    configPath,
    log,
    originalPaneId,
    providedControlPaneId: optionsControlPaneId,
    tmuxService,
  });
  log.info(`[createPane] config: loaded [${elapsed()}]`, 'paneCreation');

  // Enable pane borders to show titles (sidebar only — window mode has no borders)
  if (layoutMode === 'sidebar') {
    try {
      tmuxService.setGlobalOptionSync('pane-border-status', 'top');
    } catch {
      // Ignore if already set or fails
    }
  }

  // Determine if this is the first content pane
  // Check existingPanes instead of contentPaneIds, because contentPaneIds includes the welcome pane
  const isFirstContentPane = existingPanes.length === 0;

  let paneInfo: string;
  let usedWindowFallback = false;
  let worktreeCreatedDirectly = false;
  const rollback = new PaneCreationRollback(log);

  try {
    // Direct worktree creation: create worktree from Node.js BEFORE the tmux pane,
    // so the pane can start directly in the worktree directory (no polling needed).
    if (directWorktreeCreation && useWorktree && worktreePath && branchName) {
      const baseBranch = settings.baseBranch || '';
      if (baseBranch && !isValidBranchName(baseBranch)) {
        throw new Error(`Invalid base branch name: ${baseBranch}`);
      }

      const maxDirectAttempts = 3;

      for (let attempt = 1; attempt <= maxDirectAttempts; attempt += 1) {
        try {
          const [branchExists, baseExists] = await Promise.all([
            gitCommandSucceeds(
              `git show-ref --verify --quiet ${shQuote(`refs/heads/${branchName}`)}`,
              projectRoot,
            ),
            baseBranch
              ? gitCommandSucceeds(
                buildGitRefVerifyCommand(baseBranch),
                projectRoot,
              )
              : Promise.resolve(true),
          ]);
          log.info(
            `[createPane] worktree-direct: git pre-checks done (attempt ${attempt}, branchExists=${branchExists}, baseExists=${baseExists}) [${elapsed()}]`,
            'paneCreation'
          );

          if (baseBranch && !baseExists) {
            throw new Error(
              `Base branch "${baseBranch}" does not exist. Update the baseBranch setting to a valid branch name.`
            );
          }

          const startPointRef = worktreeStartPoint || baseBranch;
          const worktreeAddArgs = buildGitWorktreeAddArgs({
            branchName,
            createBranch: !branchExists || Boolean(worktreeStartPoint),
            startPoint: startPointRef || undefined,
            worktreePath,
          });

          const worktreeStart = Date.now();
          await execFileAsync('git', worktreeAddArgs, { cwd: projectRoot, timeout: 60000 });
          worktreeCreatedDirectly = true;
          rollback.trackWorktree({
            branchName,
            deleteBranch: !branchExists,
            projectRoot,
            worktreePath,
          });
          checkedOutBranches.add(branchName);
          log.info(
            `[createPane] worktree-direct: worktree created in ${Date.now() - worktreeStart}ms (attempt ${attempt}) [${elapsed()}]`,
            'paneCreation'
          );
          break;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);

          if (isWorktreeCollisionError(errorMsg) && attempt < maxDirectAttempts) {
            const previousSlug = slug;
            existingSlugs.add(previousSlug);
            slug = chooseAvailableSlug(initialSlug, (candidateSlug) => {
              if (existingSlugs.has(candidateSlug)) {
                return true;
              }

              const candidateWorktreePath = getManagedWorktreePath(projectRoot, candidateSlug);
              if (fs.existsSync(candidateWorktreePath)) {
                return true;
              }

              const candidateBranch = branchPrefix ? `${branchPrefix}${candidateSlug}` : candidateSlug;
              return checkedOutBranches.has(candidateBranch);
            });
            branchName = branchPrefix ? `${branchPrefix}${slug}` : slug;
            worktreePath = getManagedWorktreePath(projectRoot, slug);
            existingSlugs.add(slug);

            log.warn(
              `[createPane] worktree-direct: collision for "${previousSlug}" (${errorMsg}); retrying with "${slug}" [${elapsed()}]`,
              'paneCreation'
            );
            continue;
          }

          if (shouldFallbackDirectWorktreeToTmuxShell(errorMsg)) {
            // The shell fallback only branches from settings.baseBranch and never
            // seeds files. Refusing to fall back keeps callers that depend on
            // either invariant (e.g. review panes pinned to a snapshot SHA) from
            // silently getting a worktree against the wrong base with no rubric.
            if (worktreeStartPoint || worktreeSeedFile) {
              throw new Error(
                `Cannot create worktree for "${branchName}" without git in PATH: ${errorMsg}`,
              );
            }
            log.warn(
              `[createPane] worktree-direct: failed (${errorMsg}), falling back to tmux shell [${elapsed()}]`,
              'paneCreation'
            );
            worktreeCreatedDirectly = false;
            break;
          }

          throw new Error(`Failed to create worktree "${branchName}": ${errorMsg}`);
        }
      }
    }

    // Use worktreePath as cwd when worktree was created directly
    const paneCwd = (worktreeCreatedDirectly && worktreePath) ? worktreePath : projectRoot;

    if (worktreeSeedFile && worktreeCreatedDirectly && worktreePath) {
      const seedPath = path.join(worktreePath, worktreeSeedFile.relativePath);
      fs.mkdirSync(path.dirname(seedPath), { recursive: true });
      fs.writeFileSync(seedPath, worktreeSeedFile.content, { encoding: 'utf-8', mode: 0o600 });
      log.info(`[createPane] seeded worktree file ${worktreeSeedFile.relativePath} [${elapsed()}]`, 'paneCreation');
    }

    const allocation = await allocateTmuxPane({
      configPath,
      controlPaneId,
      existingPaneIds: existingPanes.map((pane) => pane.paneId),
      isFirstContentPane,
      layoutMode,
      log,
      originalPaneId,
      paneCwd,
      requestedSessionName: optionsSessionName,
      tmuxService,
    });
    controlPaneId = allocation.controlPaneId;
    paneInfo = allocation.paneId;
    usedWindowFallback = allocation.usedWindowFallback;

    // Window mode returns only after tmux has created the pane, so no polling is needed.
    if (layoutMode !== 'window') {
      await waitForPaneReady(tmuxService, paneInfo);
    }
    log.info(`[createPane] tmux-pane: created [${elapsed()}]`, 'paneCreation');
    rollback.trackTmuxPane(paneInfo);
    const birthGeometry = layoutMode === 'window'
      ? resolvePaneBirthGeometry(terminalProfile, initialTerminalSize)
      : null;
    if (birthGeometry) {
      await resizePaneBeforeAgentLaunch(paneInfo, birthGeometry);
    }

    // Set pane title (project-tagged for collision-safe rebinding across projects)
    // Window mode: desktop renderer displays pane.slug from Zustand, not tmux titles
    if (layoutMode !== 'window') {
      try {
        const paneTitle = projectRoot === sessionProjectRoot
          ? slug
          : buildWorktreePaneTitle(slug, projectRoot, paneProjectName);
        await tmuxService.setPaneTitle(paneInfo, paneTitle);
      } catch {
        // Ignore if setting title fails
      }
    }

    // Apply optimal layout using the layout manager (sidebar mode only)
    if (controlPaneId && layoutMode === 'sidebar' && !usedWindowFallback) {
      const dimensions = getTerminalDimensions();
      const allContentPaneIds = [...existingPanes.map(p => p.paneId), paneInfo];

      await recalculateAndApplyLayout(
        controlPaneId,
        allContentPaneIds,
        dimensions.width,
        dimensions.height
      );

      // Refresh tmux to apply changes
      await tmuxService.refreshClient();
    }

    const muxbasePaneId = `muxbase-${Date.now()}`;
    await stampTmuxPaneIdOption(paneInfo, muxbasePaneId);
    const activityIncarnationId = await stampTmuxPaneIncarnationOption(paneInfo);

    if (!skipHooks) {
      await triggerHook('pane_created', projectRoot, undefined, {
        MUXBASE_PANE_ID: muxbasePaneId,
        MUXBASE_SLUG: slug,
        MUXBASE_PROMPT: prompt,
        MUXBASE_AGENT: agent || 'unknown',
        MUXBASE_TMUX_PANE_ID: paneInfo,
      });
    }

    const isHooksEditingSession = useWorktree && !!prompt && (
      /(create|edit|modify).*(muxbase|\.)?.*(hooks)/i.test(prompt)
      || /\.(?:muxbase|muxbase)-hooks/i.test(prompt)
    );

    if (useWorktree && worktreePath && branchName && !worktreeCreatedDirectly) {
      // Tmux-shell worktree path: send git commands through the pane's shell and poll for completion.
      // This path is used by TUI mode (directWorktreeCreation is false/undefined).
      let shellBranchExisted = true;
      try {
        try {
          await execFileAsync('git', ['worktree', 'prune'], { cwd: projectRoot });
        } catch {
          // Ignore prune errors
        }

        let branchExists = false;
        try {
          await execFileAsync(
            'git',
            ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
            { cwd: projectRoot },
          );
          branchExists = true;
        } catch {
          // Branch doesn't exist
        }
        shellBranchExisted = branchExists;

        const baseBranch = settings.baseBranch || '';
        if (baseBranch && !isValidBranchName(baseBranch)) {
          throw new Error(`Invalid base branch name: ${baseBranch}`);
        }
        if (baseBranch) {
          try {
            await execFileAsync('git', buildGitRefVerifyArgs(baseBranch), { cwd: projectRoot });
          } catch {
            throw new Error(
              `Base branch "${baseBranch}" does not exist. Update the baseBranch setting to a valid branch name.`
            );
          }
        }

        const worktreeCmd = buildGitWorktreeShellCommand({
          branchName,
          createBranch: !branchExists,
          projectRoot,
          startPoint: baseBranch || undefined,
          worktreePath,
        });

        await tmuxService.sendShellCommand(paneInfo, worktreeCmd);
        await tmuxService.sendTmuxKeys(paneInfo, 'Enter');

        const maxWaitTime = 5000;
        const checkInterval = 100;
        const startTime = Date.now();

        while (!fs.existsSync(worktreePath) && (Date.now() - startTime) < maxWaitTime) {
          await new Promise((resolve) => setTimeout(resolve, checkInterval));
        }

        if (!fs.existsSync(worktreePath)) {
          throw new Error(`Worktree directory not created at ${worktreePath} after ${maxWaitTime}ms`);
        }

        const shellReady = await waitForShellReady(tmuxService, paneInfo, 12000);
        if (!shellReady) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }

        if (directWorktreeCreation) {
          const paneCurrentPath = await execFileAsync(
            'tmux',
            ['display-message', '-t', paneInfo, '-p', '#{pane_current_path}'],
            { timeout: 3000 },
          );
          if (paneCurrentPath.trim() !== worktreePath) {
            throw new Error(
              `Worktree command did not switch to ${worktreePath} (current: ${paneCurrentPath.trim() || 'unknown'})`,
            );
          }
        }

        if (isHooksEditingSession) {
          initializeHooksDirectory(worktreePath);
        }

        rollback.trackWorktree({
          branchName,
          deleteBranch: !branchExists,
          projectRoot,
          worktreePath,
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log.error(`[createPane] worktree-shell: failed (${errorMsg}) [${elapsed()}]`, 'paneCreation');
        if (directWorktreeCreation && worktreePath && branchName && fs.existsSync(worktreePath)) {
          rollback.trackWorktree({
            branchName,
            deleteBranch: !shellBranchExisted,
            projectRoot,
            worktreePath,
          });
        }
        await tmuxService.sendShellCommand(
          paneInfo,
          `echo ${shQuote(`Failed to create worktree: ${errorMsg}`)}`
        );
        await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
        await tmuxService.sendShellCommand(
          paneInfo,
          `echo ${shQuote(`Tip: Try running: git worktree prune && git branch -D ${branchName}`)}`
        );
        await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
        await new Promise((resolve) => setTimeout(resolve, TMUX_LAYOUT_APPLY_DELAY));
        worktreePath = undefined;
        branchName = undefined;
        if (directWorktreeCreation) {
          throw new Error(`Failed to create worktree via fallback shell: ${errorMsg}`);
        }
      }
    } else if (worktreeCreatedDirectly && worktreePath && isHooksEditingSession) {
      initializeHooksDirectory(worktreePath);
    }

    // Optional: start piping raw pane output to a transcript file BEFORE launching
    // the agent. This preserves the full terminal byte stream (including hidden
    // mode toggles that capture-pane cannot reproduce).
    let terminalTranscriptPath: string | undefined;
    if (terminalTranscriptDir) {
      try {
        terminalTranscriptPath = await setupPaneTranscript({
          filenamePrefix: slug,
          paneId: paneInfo,
          transcriptDir: terminalTranscriptDir,
        });
        rollback.trackTranscript(terminalTranscriptPath);
        log.info(`[createPane] Transcript enabled path="${terminalTranscriptPath}" [${elapsed()}]`, 'paneCreation');
      } catch (e) {
        terminalTranscriptPath = undefined;
        log.warn(`[createPane] Failed to enable transcript piping: ${e}`, 'paneCreation');
      }
    }

    // Create the pane object. Every field is known before the agent launches
    // (paneId, worktree, transcript are all set above), so we build it here and
    // let the caller emit it optimistically — the renderer can mount the pane
    // and start streaming while the agent's TUI cold-boots (2-4s) instead of
    // waiting for launch to finish. If launch throws, onPaneRollback undoes it.
    const newPane: MuxBasePane = {
      id: muxbasePaneId,
      slug,
      branchName: branchName && branchName !== slug ? branchName : undefined,
      prompt: prompt || NO_INITIAL_PROMPT,
      paneId: paneInfo,
      terminalTranscriptPath,
      projectRoot,
      projectName: paneProjectName,
      worktreePath,
      agent,
      startedWithoutInitialPrompt,
      ...terminalProfile,
      role,
      review,
      duel,
      model: options.model,
      effort: options.effort,
      agentSessionId: resumeSessionId,
    };

    if (options.earlyEmit) {
      const { onReady, onRollback } = options.earlyEmit;
      rollback.trackCallback(`early pane emit ${newPane.id}`, () => onRollback(newPane.id));
      onReady(newPane);
    }

    if (resumeSessionId && agent) {
      const piSessionPath = agent === 'pi' && worktreePath
        ? await findPiSessionFile(projectRoot, resumeSessionId)
        : null;
      await resumeAgentInPane(
        paneInfo,
        agent,
        effectiveSettings,
        resumeSessionId,
        newPane.claudeRenderer,
        {
          piSessionMode: agent === 'pi' && worktreePath ? 'fork' : 'resume',
          piSessionPath: piSessionPath ?? undefined,
          muxbasePaneId,
          activityJournal: getPaneActivityJournalPath(activityIncarnationId),
          activityIncarnationId,
          enableActivityAdapters: options.enableActivityAdapters,
        },
      );
    } else {
      await launchAgentInPane({
        agent,
        agentPrompt,
        muxbasePaneId,
        activityJournal: getPaneActivityJournalPath(activityIncarnationId),
        activityIncarnationId,
        enableActivityAdapters: options.enableActivityAdapters,
        cwd: paneCwd,
        paneId: paneInfo,
        projectRoot,
        promptMode,
        readOnly,
        settings: effectiveSettings,
        slug,
        terminalProfile,
        tmuxService,
        otlpEndpoint: options.otlpEndpoint,
      });

      // The early pane is already idle because no task was submitted. For
      // fresh OpenCode/Pi launches, finish creation only after the composer is
      // genuinely ready so terminal input is available with the final update.
      if ((agent === 'opencode' || agent === 'pi') && startedWithoutInitialPrompt) {
        const readyForInput = await waitForAgentInputReady(tmuxService, paneInfo, agent);
        void readyForInput;
      }
    }

    log.info(`[createPane] agent-launch: command sent [${elapsed()}]`, 'paneCreation');

    // Keep focus on the new pane (window mode: panes are in separate windows, no selection needed)
    if (layoutMode !== 'window') {
      await tmuxService.selectPane(paneInfo);
    }

    // CRITICAL: Save the pane to config IMMEDIATELY before destroying welcome pane
    // This is the event that triggers welcome pane destruction (event-based, no polling)
    if (isFirstContentPane) {
      upsertMuxBasePane(configPath, newPane);
      rollback.trackConfigPane(configPath, newPane.id);

      try {
        destroyWelcomePaneCoordinated(sessionProjectRoot);
      } catch (error) {
        log.warn(`[createPane] Welcome pane cleanup failed: ${error instanceof Error ? error.message : String(error)}`, 'paneCreation');
      }
    }

    if (useWorktree && !skipHooks) {
      await triggerHook('worktree_created', projectRoot, newPane);
    }

    // Switch back to the original pane and re-set its title (sidebar only — window mode has no sidebar)
    if (layoutMode !== 'window') {
      await tmuxService.selectPane(originalPaneId);
      try {
        await tmuxService.setPaneTitle(originalPaneId, `muxbase-${projectName}`);
      } catch {
        // Ignore if setting title fails
      }
    }

    log.info(`[createPane] DONE [${elapsed()}]`, 'paneCreation');

    rollback.disarm();
    return {
      pane: newPane,
      needsAgentChoice: false,
    };
  } catch (error) {
    await rollback.run();
    throw error;
  }
}

type AgentLaunchSettings = MuxBaseConfig['settings'] & { opencodeModel?: string };

function applyPerPaneOverride(
  settings: AgentLaunchSettings,
  agent: AgentName | undefined,
  model: string | undefined,
  effort: string | undefined,
): AgentLaunchSettings {
  if (!agent || (model === undefined && effort === undefined)) return settings;

  type S = AgentLaunchSettings;
  switch (agent) {
    case 'claude': return {
      ...settings,
      ...(model !== undefined ? { claudeModel: model as S['claudeModel'] } : {}),
      ...(effort !== undefined ? { claudeEffort: effort as S['claudeEffort'] } : {}),
    };
    case 'codex': return {
      ...settings,
      ...(model !== undefined ? { codexModel: model as S['codexModel'] } : {}),
      ...(effort !== undefined ? { codexEffort: effort as S['codexEffort'] } : {}),
    };
    case 'opencode': return {
      ...settings,
      ...(model !== undefined ? { opencodeModel: model } : {}),
      ...(effort !== undefined ? { opencodeVariant: effort as S['opencodeVariant'] } : {}),
    };
    case 'pi': return {
      ...settings,
      ...(model !== undefined ? { piModel: model } : {}),
      ...(effort !== undefined ? { piThinking: effort as S['piThinking'] } : {}),
    };
    default: return assertNever(agent);
  }
}
