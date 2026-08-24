/**
 * Hooks System
 *
 * Executes user-defined scripts at key lifecycle events.
 * Hook scripts are stored in the project-local Amux metadata directories and
 * receive context via environment variables.
 */

import { execFileSync, spawn } from 'child_process';
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { LogService } from '../services/LogService.js';
import type { AumxPane } from '../types.js';
import { EXAMPLE_HOOKS, HOOKS_DOCUMENTATION, HOOKS_README } from './hooksDocs.js';
import {
  getProjectHooksDir,
  getProjectHooksGitignoreEntry,
  getProjectMetadataDir,
  getProjectMetadataGitignoreEntry,
} from './worktreePaths.js';

const LOG_SCOPE = 'hooks';
const INHERITED_HOOK_ENV_KEYS = new Set([
  'COMSPEC',
  'HOME',
  'LOGNAME',
  'PATH',
  'SHELL',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERNAME',
  'WINDIR',
]);
const trackedHookCache = new Map<string, {
  gitMtimeMs: number;
  hookMtimeMs: number;
  tracked: boolean;
}>();

/**
 * Available hook types
 */
export type HookType =
  | 'before_pane_create'
  | 'pane_created'
  | 'pane_reopened'
  | 'worktree_created'
  | 'before_pane_close'
  | 'pane_closed'
  | 'before_worktree_remove'
  | 'worktree_removed'
  | 'pre_merge'
  | 'post_merge'
  | 'run_test'
  | 'run_dev';

/**
 * Environment data for hooks
 */
export interface HookEnvironment {
  // Always present
  AUMX_ROOT: string;

  // Pane-specific (present for most hooks)
  AUMX_PANE_ID?: string;
  AUMX_SLUG?: string;
  AUMX_PROMPT?: string;
  AUMX_AGENT?: string;
  AUMX_TMUX_PANE_ID?: string;

  // Worktree-specific
  AUMX_WORKTREE_PATH?: string;
  AUMX_BRANCH?: string;

  // Merge-specific
  AUMX_TARGET_BRANCH?: string;

  // Additional custom data
  [key: string]: string | undefined;
}

/**
 * Find a hook script with priority resolution:
 * 1. .amux-hooks/ (project-local hooks, gitignored by default)
 * 2. .amux/hooks/ (gitignored, local overrides)
 * 3. ~/.aumx/hooks/ (global user hooks)
 */
export function findHook(projectRoot: string, hookName: HookType): string | null {
  const searchPaths = [
    path.join(getProjectHooksDir(projectRoot), hookName),   // Project-local hooks
    path.join(getProjectMetadataDir(projectRoot), 'hooks', hookName), // Local override
    path.join(os.homedir(), '.aumx', 'hooks', hookName),    // Global hooks
  ];

  for (const hookPath of searchPaths) {
    if (existsSync(hookPath)) {
      try {
        accessSync(hookPath, constants.X_OK);
        if (isTrackedProjectHook(projectRoot, hookPath)) {
          const msg = `Hook "${hookName}" at ${hookPath} is tracked by git and will not run. Move it to an ignored local hook path.`;
          LogService.getInstance().warn(msg, LOG_SCOPE);
          continue;
        }
        return hookPath;
      } catch {
        const msg = `Hook "${hookName}" exists at ${hookPath} but is not executable. Run: chmod +x ${hookPath}`;
        LogService.getInstance().warn(msg, LOG_SCOPE);
      }
    }
  }

  return null;
}

/**
 * Build environment variables for a hook
 */
export async function buildHookEnvironment(
  projectRoot: string,
  pane?: AumxPane,
  extraData?: Record<string, string>
): Promise<HookEnvironment> {
  const env: HookEnvironment = {
    ...getInheritedHookEnvironment(),
    AUMX_HOOKS_DIR: getProjectHooksDir(projectRoot),
    AUMX_METADATA_DIR: getProjectMetadataDir(projectRoot),
    AUMX_ROOT: projectRoot,
  };

  // Add pane-specific data
  if (pane) {
    env.AUMX_PANE_ID = pane.id;
    env.AUMX_SLUG = pane.slug;
    env.AUMX_PROMPT = pane.prompt;
    env.AUMX_AGENT = pane.agent || 'unknown';
    env.AUMX_TMUX_PANE_ID = pane.paneId;

    if (pane.worktreePath) {
      env.AUMX_WORKTREE_PATH = pane.worktreePath;
      env.AUMX_BRANCH = pane.branchName || pane.slug; // Branch name (may differ from slug with prefix)
    }
  }

  // Add any extra data
  if (extraData) {
    Object.assign(env, extraData);
  }

  return env;
}

function getInheritedHookEnvironment(): Partial<HookEnvironment> {
  const env: Partial<HookEnvironment> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && shouldInheritHookEnv(key)) {
      env[key] = value;
    }
  }

  return env;
}

function shouldInheritHookEnv(key: string): boolean {
  return key.startsWith('AUMX_') || INHERITED_HOOK_ENV_KEYS.has(key.toUpperCase());
}

function isTrackedProjectHook(projectRoot: string, hookPath: string): boolean {
  if (!existsSync(path.join(projectRoot, '.git'))) {
    return false;
  }

  const relativeHookPath = path.relative(projectRoot, hookPath);
  if (!relativeHookPath || relativeHookPath.startsWith('..') || path.isAbsolute(relativeHookPath)) {
    return false;
  }

  const cacheKey = `${projectRoot}\0${hookPath}`;
  const hookMtimeMs = getMtimeMs(hookPath);
  const gitMtimeMs = getGitMetadataMtimeMs(projectRoot);
  const cached = trackedHookCache.get(cacheKey);
  if (cached && cached.hookMtimeMs === hookMtimeMs && cached.gitMtimeMs === gitMtimeMs) {
    return cached.tracked;
  }

  let tracked = false;
  try {
    execFileSync('git', ['-C', projectRoot, 'ls-files', '--error-unmatch', '--', relativeHookPath], {
      stdio: 'ignore',
    });
    tracked = true;
  } catch {
  }

  trackedHookCache.set(cacheKey, { gitMtimeMs, hookMtimeMs, tracked });
  return tracked;
}

function getMtimeMs(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function getGitMetadataMtimeMs(projectRoot: string): number {
  const gitPath = path.join(projectRoot, '.git');
  const gitDir = resolveGitDirectory(projectRoot, gitPath);
  const indexPath = gitDir ? path.join(gitDir, 'index') : path.join(gitPath, 'index');
  return getMtimeMs(indexPath) || getMtimeMs(gitDir ?? gitPath);
}

function resolveGitDirectory(projectRoot: string, gitPath: string): string | null {
  try {
    const gitStat = statSync(gitPath);
    if (gitStat.isDirectory()) {
      return gitPath;
    }
    const content = readFileSync(gitPath, 'utf-8').trim();
    const gitDirPrefix = 'gitdir:';
    if (!content.startsWith(gitDirPrefix)) {
      return null;
    }
    const gitDir = content.slice(gitDirPrefix.length).trim();
    return path.isAbsolute(gitDir) ? gitDir : path.resolve(projectRoot, gitDir);
  } catch {
    return null;
  }
}

function openHookLog(projectRoot: string, hookName: HookType, hookPath: string): number {
  const logDir = path.join(getProjectMetadataDir(projectRoot), 'hook-logs');
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${hookName}.log`);
  const fd = openSync(logPath, 'a');
  writeFileSync(fd, `\n[${new Date().toISOString()}] ${hookPath}\n`, { encoding: 'utf-8' });
  return fd;
}

/**
 * Execute a hook script asynchronously
 *
 * Hooks run in the background and don't block aumx operations.
 * Errors are logged but don't crash the application.
 */
export async function triggerHook(
  hookName: HookType,
  projectRoot: string,
  pane?: AumxPane,
  extraData?: Record<string, string>
): Promise<void> {
  const hookPath = findHook(projectRoot, hookName);

  if (!hookPath) {
    // No hook script found, that's fine
    return;
  }

  // Build environment
  const env = await buildHookEnvironment(projectRoot, pane, extraData);

  const startMsg = `Executing ${hookName} hook: ${hookPath}`;
  LogService.getInstance().debug(startMsg, LOG_SCOPE);

  let logFd: number | null = null;
  try {
    logFd = openHookLog(projectRoot, hookName, hookPath);
    const child = spawn(hookPath, [], {
      env: env as NodeJS.ProcessEnv,
      cwd: projectRoot,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    closeSync(logFd);
    logFd = null;

    child.unref();

    child.on('exit', (code) => {
      if (code === 0) {
        const msg = `${hookName} completed successfully`;
        LogService.getInstance().debug(msg, LOG_SCOPE);
      } else if (code !== null) {
        const msg = `${hookName} exited with code ${code}`;
        LogService.getInstance().error(msg, LOG_SCOPE);
      }
    });

    child.on('error', (error) => {
      const msg = `${hookName} failed to start: ${error.message}`;
      LogService.getInstance().error(msg, LOG_SCOPE, undefined, error instanceof Error ? error : undefined);
    });
  } catch (error) {
    if (logFd !== null) {
      closeSync(logFd);
    }
    const msg = `Failed to execute ${hookName}`;
    LogService.getInstance().error(msg, LOG_SCOPE, undefined, error instanceof Error ? error : undefined);
  }
}

/**
 * Execute a hook synchronously (blocking)
 *
 * Use sparingly - only for hooks that MUST complete before proceeding.
 * Most hooks should use triggerHook() instead.
 */
export async function triggerHookSync(
  hookName: HookType,
  projectRoot: string,
  pane?: AumxPane,
  extraData?: Record<string, string>,
  timeoutMs: number = 30000
): Promise<{ success: boolean; output?: string; error?: string }> {
  const hookPath = findHook(projectRoot, hookName);

  if (!hookPath) {
    return { success: true }; // No hook = success
  }

  const env = await buildHookEnvironment(projectRoot, pane, extraData);

  const startMsg = `Executing ${hookName} hook (sync): ${hookPath}`;
  LogService.getInstance().debug(startMsg, LOG_SCOPE);

  try {
    const output = execFileSync(hookPath, [], {
      env: env as NodeJS.ProcessEnv,
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: 'pipe',
    });

    const successMsg = `${hookName} completed successfully`;
    LogService.getInstance().debug(successMsg, LOG_SCOPE);
    return { success: true, output };
  } catch (error) {
    const execError = error as Error & { stdout?: Buffer | string };
    const errorMsg = execError.message || String(error);
    const msg = `${hookName} failed: ${errorMsg}`;
    LogService.getInstance().error(msg, LOG_SCOPE, undefined, error instanceof Error ? error : undefined);
    return {
      success: false,
      error: errorMsg,
      output: execError.stdout?.toString() || '',
    };
  }
}

/**
 * Check if a hook exists for a given hook type
 */
export function hasHook(projectRoot: string, hookName: HookType): boolean {
  return findHook(projectRoot, hookName) !== null;
}

/**
 * List all available hooks in the project
 */
export function listAvailableHooks(projectRoot: string): HookType[] {
  const allHooks: HookType[] = [
    'before_pane_create',
    'pane_created',
    'pane_reopened',
    'worktree_created',
    'before_pane_close',
    'pane_closed',
    'before_worktree_remove',
    'worktree_removed',
    'pre_merge',
    'post_merge',
    'run_test',
    'run_dev',
  ];

  return allHooks.filter((hook) => hasHook(projectRoot, hook));
}

function ensureAumxMetadataGitignore(projectRoot: string): void {
  if (!existsSync(path.join(projectRoot, '.git'))) {
    return;
  }

  const gitignorePath = path.join(projectRoot, '.gitignore');

  try {
    const content = existsSync(gitignorePath)
      ? readFileSync(gitignorePath, 'utf-8')
      : '';
    const existingEntries = new Set(content.split('\n').map((line) => line.trim()));
    const metadataEntries = [
      getProjectMetadataGitignoreEntry(projectRoot),
      getProjectHooksGitignoreEntry(projectRoot),
    ];
    const missingEntries = metadataEntries.filter((entry) => !existingEntries.has(entry));

    if (missingEntries.length === 0) {
      return;
    }

    const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    writeFileSync(gitignorePath, `${content}${separator}${missingEntries.join('\n')}\n`, 'utf-8');
  } catch (error) {
    LogService.getInstance().warn(
      `Failed to update .gitignore: ${error instanceof Error ? error.message : String(error)}`,
      LOG_SCOPE
    );
  }
}

/**
 * Initialize the project-local hooks directory with documentation and examples.
 * This gets called the first time hooks are accessed or when user explicitly initializes
 */
export function initializeHooksDirectory(projectRoot: string): void {
  ensureAumxMetadataGitignore(projectRoot);

  const hooksDir = getProjectHooksDir(projectRoot);
  const hooksDirName = path.basename(hooksDir);
  const agentsPath = path.join(hooksDir, 'AGENTS.md');
  const claudePath = path.join(hooksDir, 'CLAUDE.md');
  const readmePath = path.join(hooksDir, 'README.md');
  const examplesDir = path.join(hooksDir, 'examples');
  const examplePaths = Object.keys(EXAMPLE_HOOKS).map((filename) =>
    path.join(examplesDir, filename)
  );

  // Fast path for the common case: everything already initialized
  if (
    existsSync(agentsPath)
    && existsSync(claudePath)
    && existsSync(readmePath)
    && existsSync(examplesDir)
    && examplePaths.every((examplePath) => existsSync(examplePath))
  ) {
    return;
  }

  const initMsg = `Initializing ${hooksDirName}/ directory (or repairing missing docs)...`;
  LogService.getInstance().debug(initMsg, LOG_SCOPE);

  try {
    let madeChanges = false;

    // Create main hooks directory
    if (!existsSync(hooksDir)) {
      mkdirSync(hooksDir, { recursive: true });
      madeChanges = true;
    }

    // Ensure AGENTS.md (complete reference)
    if (!existsSync(agentsPath)) {
      writeFileSync(
        agentsPath,
        HOOKS_DOCUMENTATION,
        'utf-8'
      );
      madeChanges = true;
    }

    // Ensure CLAUDE.md (prefer AGENTS.md content if present)
    if (!existsSync(claudePath)) {
      let claudeContent = HOOKS_DOCUMENTATION;
      try {
        claudeContent = readFileSync(agentsPath, 'utf-8');
      } catch {
        // Keep default HOOKS_DOCUMENTATION fallback
      }

      writeFileSync(
        claudePath,
        claudeContent,
        'utf-8'
      );
      madeChanges = true;
    }

    // Ensure README.md
    if (!existsSync(readmePath)) {
      writeFileSync(
        readmePath,
        HOOKS_README,
        'utf-8'
      );
      madeChanges = true;
    }

    // Ensure examples directory
    if (!existsSync(examplesDir)) {
      mkdirSync(examplesDir, { recursive: true });
      madeChanges = true;
    }

    // Ensure example hooks
    for (const [filename, content] of Object.entries(EXAMPLE_HOOKS)) {
      const examplePath = path.join(examplesDir, filename);
      if (!existsSync(examplePath)) {
        writeFileSync(examplePath, content, 'utf-8');
        madeChanges = true;
      }

      try {
        execFileSync('chmod', ['+x', examplePath], { stdio: 'pipe' });
      } catch {
        // Ignore chmod errors (Windows, etc.)
      }
    }

    if (madeChanges) {
      LogService.getInstance().debug(`Initialized ${hooksDirName}/ with documentation and examples`, LOG_SCOPE);
      LogService.getInstance().debug('Read AGENTS.md or CLAUDE.md to get started', LOG_SCOPE);
    }
  } catch (error) {
    const errMsg = `Failed to initialize ${hooksDirName}/ directory: ${error instanceof Error ? error.message : String(error)}`;
    LogService.getInstance().warn(errMsg, LOG_SCOPE);
    // Don't throw - hooks initialization is not critical
  }
}
