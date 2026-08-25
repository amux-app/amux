import { LogService } from '../services/LogService.js';
import { TmuxService } from '../services/TmuxService.js';
import type { MuxBasePane } from '../types.js';
import {
  abortConflictMerge,
  inspectMergeHead,
  type ConflictMergePreparation,
  prepareConflictMerge,
} from './conflictMergePreparation.js';
import type { ExecAsyncResult } from './execAsync.js';
import { launchAgentInPane } from './paneAgentLaunch.js';
import { assertClaudeFullscreenSupported } from './claudeVersion.js';
import { resizePaneBeforeAgentLaunch } from './paneTerminalGeometry.js';
import { resolvePaneTerminalProfile } from './paneTerminalProfile.js';
import { sanitizeSlug } from './slug.js';
import { SettingsManager } from './settingsManager.js';
import { removePaneTranscript, setupPaneTranscript } from './tmuxTranscript.js';

const log = LogService.getInstance();

export interface ConflictResolutionPaneOptions {
  /** Pane whose tmux session owns the new isolated conflict window. */
  sourceTmuxPaneId: string;
  sourceBranch: string;
  targetBranch: string;
  targetRepoPath: string;
  mainRepoPath?: string;
  /** Main project root that owns settings, prompts, and pane metadata. */
  projectRoot: string;
  terminalTranscriptDir?: string;
  agent: NonNullable<MuxBasePane['agent']>;
  otlpEndpoint?: string;
}

export interface ConflictResolutionPaneCreation {
  pane: MuxBasePane;
  preparation: ConflictMergePreparation;
}

/**
 * Create an isolated conflict-resolution window and launch its agent through
 * the same production pipeline as every other pane.
 */
export async function createConflictResolutionPane(
  options: ConflictResolutionPaneOptions,
): Promise<ConflictResolutionPaneCreation> {
  const {
    agent,
    otlpEndpoint,
    projectRoot,
    sourceBranch,
    sourceTmuxPaneId,
    targetBranch,
    targetRepoPath,
    terminalTranscriptDir,
  } = options;
  const tmuxService = TmuxService.getInstance();
  const sessionName = await tmuxService.getPaneSessionName(sourceTmuxPaneId);
  if (!sessionName) {
    throw new Error(`Cannot resolve tmux session for source pane ${sourceTmuxPaneId}`);
  }

  const settings = new SettingsManager(projectRoot).getSettings();
  const terminalProfile = resolvePaneTerminalProfile(agent, settings);
  if (terminalProfile.claudeRenderer === 'fullscreen') {
    await assertClaudeFullscreenSupported();
  }
  const slug = sanitizeSlug(`merge-${sourceBranch}-into-${targetBranch}`).slice(0, 50);
  const id = `muxbase-${Date.now()}`;
  const prompt = `There are conflicts merging ${targetBranch} into ${sourceBranch}. Both are valid changes, so please keep both feature sets and merge them intelligently. Check git status to see the conflicting files, then resolve each conflict to preserve both sets of changes. Once all conflicts are resolved, commit the merge.`;

  let paneId = '';
  let terminalTranscriptPath: string | undefined;

  try {
    const preparation = await prepareConflictMerge(targetRepoPath, targetBranch);

    paneId = await tmuxService.newWindowPane({
      cwd: targetRepoPath,
      name: slug,
      sessionName,
    });

    await tmuxService.setPaneTitle(paneId, slug);

    if (terminalProfile.terminalFixedCols !== undefined) {
      await resizePaneBeforeAgentLaunch(paneId, {
        cols: terminalProfile.terminalFixedCols,
      });
    }

    if (terminalTranscriptDir) {
      terminalTranscriptPath = await setupPaneTranscript({
        filenamePrefix: slug,
        paneId,
        transcriptDir: terminalTranscriptDir,
      });
    }

    await launchAgentInPane({
      agent,
      agentPrompt: prompt,
      muxbasePaneId: id,
      cwd: targetRepoPath,
      otlpEndpoint,
      paneId,
      projectRoot,
      promptMode: 'argument',
      settings,
      slug,
      terminalProfile,
      tmuxService,
    });

    return {
      pane: {
        id,
        slug,
        prompt,
        paneId,
        agent,
        projectRoot,
        terminalTranscriptPath,
        ...terminalProfile,
      },
      preparation,
    };
  } catch (error) {
    return rollbackConflictCreation(
      tmuxService,
      targetRepoPath,
      paneId,
      terminalTranscriptPath,
      error,
    );
  }
}

async function rollbackConflictCreation(
  tmuxService: TmuxService,
  repoPath: string,
  paneId: string,
  terminalTranscriptPath: string | undefined,
  originalError: unknown,
): Promise<never> {
  const rollbackErrors: Error[] = [];

  if (paneId) {
    try {
      await tmuxService.killPane(paneId);
    } catch (error) {
      rollbackErrors.push(new Error(`Failed to clean up conflict pane ${paneId}: ${String(error)}`));
    }
  }

  const abortResult = await abortConflictMerge(repoPath);
  if (abortResult.exitCode !== 0) {
    const mergeHead = await inspectMergeHead(repoPath);
    if (mergeHead.exitCode !== 1) {
      rollbackErrors.push(new Error(
        `Failed to abort conflict merge in ${repoPath}: ${getProcessError(abortResult)}`,
      ));
    }
  }

  try {
    removePaneTranscript(terminalTranscriptPath);
  } catch (error) {
    rollbackErrors.push(new Error(
      `Failed to remove conflict transcript ${terminalTranscriptPath}: ${String(error)}`,
    ));
  }

  if (rollbackErrors.length > 0) {
    for (const rollbackError of rollbackErrors) {
      log.warn(rollbackError.message, 'conflictResolution');
    }
    throw new AggregateError(
      [originalError, ...rollbackErrors],
      `Conflict pane creation failed and rollback was incomplete: ${String(originalError)}`,
    );
  }

  throw originalError;
}

/** Release every resource retained by a successfully launched conflict pane. */
export async function disposeConflictResolutionPane(
  creation: ConflictResolutionPaneCreation,
): Promise<void> {
  const tmuxService = TmuxService.getInstance();
  const cleanupErrors: Error[] = [];

  try {
    await tmuxService.killPane(creation.pane.paneId);
  } catch (error) {
    cleanupErrors.push(new Error(
      `Failed to kill conflict pane ${creation.pane.paneId}: ${String(error)}`,
    ));
  }

  const abortResult = await abortConflictMerge(creation.preparation.repoPath);
  if (abortResult.exitCode !== 0) {
    const mergeHead = await inspectMergeHead(creation.preparation.repoPath);
    if (mergeHead.exitCode !== 1) {
      cleanupErrors.push(new Error(
        `Failed to abort conflict merge in ${creation.preparation.repoPath}: ${getProcessError(abortResult)}`,
      ));
    }
  }

  try {
    removePaneTranscript(creation.pane.terminalTranscriptPath);
  } catch (error) {
    cleanupErrors.push(new Error(
      `Failed to remove conflict transcript ${creation.pane.terminalTranscriptPath}: ${String(error)}`,
    ));
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Conflict pane cleanup was incomplete');
  }
}

function getProcessError(result: ExecAsyncResult): string {
  if (result.stderr) return result.stderr;
  if (result.timedOut) return 'command timed out';
  if (result.exitCode === null) return 'command could not be executed';
  return `git exited with code ${result.exitCode}`;
}
