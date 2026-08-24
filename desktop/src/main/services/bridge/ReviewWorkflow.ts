import type {
  AgentName,
  AumxPane,
  ReviewMetadata,
} from 'aumx/core';
import {
  agentHasCapability,
  getProjectMetadataDir,
} from 'aumx/core';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'path';
import type { NormalizedSession } from '../../../shared/agent-session-types.js';
import type {
  PaneActivity,
  ReadinessToken,
} from '../../../shared/pane-activity.js';
import type {
  PaneCreateResponse,
  PaneSendFixResponse,
  PaneStartReviewResponse,
} from '../../../shared/ipc-types.js';
import { sanitizeReviewIdToken } from '../../../shared/review-constants.js';
import { formatError } from '../../utils/formatError.js';
import {
  collectSnapshotDiffData,
  collectWorkingDiffData,
  createReviewSnapshot,
  resolveBaseBranch,
  sh,
  type WorkingTreeDiffData,
} from '../git/gitDiff.js';
import { log } from '../Logger.js';
import {
  buildFindingsFile,
  buildFixPrompt,
  extractReviewFindings,
} from '../review/fixHandoff.js';
import { buildReviewSessionDigest } from '../review/reviewDigest.js';
import {
  getFixHandoffSourceBlockReason,
  getFixHandoffSourceCapabilityBlockReason,
  getReviewPaneHandoffBlockReason,
  getReviewSourceBlockReason,
  getReviewSourceCapabilityBlockReason,
  hasOpenReviewForSource,
  resolveReviewSourcePane,
} from '../review/reviewPaneGuards.js';
import { buildReviewLaunchMessage, buildReviewPrompt } from '../review/reviewPrompt.js';

interface ReviewPaneLaunchOptions {
  agentPrompt: string;
  projectRoot: string;
  readOnly: true;
  review: ReviewMetadata;
  role: 'review';
  slugBase: string;
  useWorktree: true;
  worktreeSeedFile: { content: string; relativePath: string };
  worktreeStartPoint: string;
}

interface ReviewWorkflowDependencies {
  captureReadinessTokenFor(paneId: string): ReadinessToken | undefined;
  createPane(
    prompt: string,
    agent: AgentName | undefined,
    options: ReviewPaneLaunchOptions,
  ): Promise<PaneCreateResponse>;
  getAvailableAgents(): readonly AgentName[];
  getPane(paneId: string): AumxPane | undefined;
  getPaneActivity(paneId: string): PaneActivity | undefined;
  getPanes(): AumxPane[];
  getProjectRoot(): string;
  getSession(paneId: string): NormalizedSession | null;
  replacePanesBestEffort(panes: AumxPane[]): void;
  revalidateReadinessOrReject<T extends { id: string }>(
    pane: T | undefined,
    token: ReadinessToken | undefined,
    blockReason: (pane: T) => string | undefined,
    notFoundReason: string,
  ): { ok: true; pane: T } | { ok: false; reason: string };
  sendPromptToPane(paneId: string, prompt: string): Promise<void>;
  setProgress(action: string, active: boolean): void;
}

function formatReviewError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('command not found') || message.includes('ENOENT') && message.includes('git')) {
    return 'Git is not installed or not in PATH';
  }
  if (message.includes("ambiguous argument 'HEAD'") || message.includes('unknown revision')) {
    return 'This repository has no commits yet — make an initial commit first';
  }
  if (message.includes('EACCES') || message.includes('permission denied')) {
    return 'Cannot access the repository — check file permissions';
  }
  if (message.includes('maxBuffer') || message.includes('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')) {
    return 'The diff is too large to review (exceeds 64 MB)';
  }
  return formatError(error);
}

function getReviewArtifactPaths(projectRoot: string): { directory: string; rubric: string } {
  const directory = `${basename(getProjectMetadataDir(projectRoot))}/review`;
  return { directory, rubric: `${directory}/REVIEW.md` };
}

function reviewFindingsRelPath(reviewId: string, directory: string): string {
  return `${directory}/findings-${sanitizeReviewIdToken(reviewId, '_', 64)}.md`;
}

function sweepStaleFindings(reviewDirectory: string): void {
  if (!existsSync(reviewDirectory)) return;
  for (const name of readdirSync(reviewDirectory)) {
    if (name.startsWith('findings-') && name.endsWith('.md')) {
      rmSync(join(reviewDirectory, name), { force: true });
    }
  }
}

function writeAumxFile(absolutePath: string, content: string): void {
  mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
  writeFileSync(absolutePath, content, { encoding: 'utf-8', mode: 0o600 });
}

export class ReviewWorkflow {
  constructor(
    private readonly dependencies: ReviewWorkflowDependencies,
    private readonly inFlightReviewSourceIds = new Set<string>(),
    private readonly inFlightHandoffIds = new Set<string>(),
  ) {}

  async startReview(
    sourcePaneId: string,
    reviewAgent?: AgentName,
  ): Promise<PaneStartReviewResponse> {
    const startedAt = Date.now();
    const sourcePane = this.dependencies.getPane(sourcePaneId);
    if (!sourcePane) {
      log.warn('bridge', 'startReviewAction rejected: pane not found', { sourcePaneId });
      return { success: false, error: 'Pane not found' };
    }
    const blockReason = this.getReviewSourceReadinessBlockReason(sourcePane);
    if (blockReason) {
      log.warn('bridge', 'startReviewAction rejected: source not ready', {
        reason: blockReason,
        sourcePaneId,
      });
      return { success: false, error: blockReason };
    }
    const sourceReadinessToken = this.dependencies.captureReadinessTokenFor(sourcePaneId);

    const agent = reviewAgent ?? sourcePane.agent as AgentName | undefined;
    if (agent && !agentHasCapability(agent, 'review')) {
      log.warn('bridge', 'startReviewAction rejected: unsupported review agent', {
        agent,
        sourcePaneId,
      });
      return { success: false, error: `${agent} does not support review sessions` };
    }
    if (agent && !this.dependencies.getAvailableAgents().includes(agent)) {
      log.warn('bridge', 'startReviewAction rejected: agent unavailable', { agent, sourcePaneId });
      return { success: false, error: `Agent "${agent}" is not available on this machine` };
    }

    if (this.inFlightReviewSourceIds.has(sourcePaneId)) {
      log.warn('bridge', 'startReviewAction rejected: already in flight', { sourcePaneId });
      return { success: false, error: 'A review is already launching for this pane' };
    }
    if (hasOpenReviewForSource(sourcePaneId, this.dependencies.getPanes())) {
      log.warn('bridge', 'startReviewAction rejected: open review exists', { sourcePaneId });
      return {
        success: false,
        error: 'A review is already open for this pane — close it or send its fixes first',
      };
    }
    this.inFlightReviewSourceIds.add(sourcePaneId);
    log.info('bridge', 'startReviewAction begin', { agent, sourcePaneId });

    try {
      const {
        changedFiles,
        launchMessage,
        rubric,
        rubricPath,
        snapshotSha,
      } = await this.gatherReviewContext(sourcePane);

      if (changedFiles.length === 0) {
        log.warn('bridge', 'startReviewAction rejected: no changes to review', {
          snapshotSha,
          sourcePaneId,
        });
        return {
          success: false,
          error: 'No changes to review — the branch is at the same point as the base branch',
        };
      }

      const revalidation = this.dependencies.revalidateReadinessOrReject(
        this.dependencies.getPane(sourcePaneId),
        sourceReadinessToken,
        (pane) => this.getReviewSourceReadinessBlockReason(pane),
        'Pane not found',
      );
      if (!revalidation.ok) {
        log.warn('bridge', 'startReviewAction rejected: source became unready', {
          reason: revalidation.reason,
          sourcePaneId,
        });
        return { success: false, error: revalidation.reason };
      }

      const reviewId = randomUUID();
      this.dependencies.setProgress('Reviewing changes: launching reviewer…', true);
      const result = await this.dependencies.createPane(`Review: ${sourcePane.slug}`, agent, {
        agentPrompt: launchMessage,
        projectRoot: sourcePane.projectRoot ?? this.dependencies.getProjectRoot(),
        readOnly: true,
        review: {
          changedFiles: changedFiles.length,
          reviewId,
          sourcePaneId,
          sourceSlug: sourcePane.slug,
          sourceWorktreePath: sourcePane.worktreePath,
          startedAt: Date.now(),
        },
        role: 'review',
        slugBase: `review-${sourcePane.slug}`,
        useWorktree: true,
        worktreeSeedFile: { content: rubric, relativePath: rubricPath },
        worktreeStartPoint: snapshotSha,
      });

      if (!result.success) {
        log.warn('bridge', 'startReviewAction createPane failed', {
          error: result.error,
          sourcePaneId,
        });
        return { success: false, error: result.error || 'Failed to create review pane' };
      }
      log.info('bridge', 'Review started', {
        changedFiles: changedFiles.length,
        elapsedMs: Date.now() - startedAt,
        reviewId,
        snapshotSha,
        sourcePaneId,
      });
      return { success: true, reviewId, pane: result.pane };
    } catch (error) {
      log.error('bridge', 'startReviewAction failed', { error, sourcePaneId });
      return { success: false, error: formatReviewError(error) };
    } finally {
      this.inFlightReviewSourceIds.delete(sourcePaneId);
      this.dependencies.setProgress('Reviewing changes', false);
    }
  }

  async startFixHandoff(reviewPaneId: string): Promise<PaneSendFixResponse> {
    const startedAt = Date.now();
    const reviewPane = this.dependencies.getPane(reviewPaneId);
    if (!reviewPane?.review) {
      log.warn('bridge', 'startFixHandoffAction rejected: not a review pane', { reviewPaneId });
      return { success: false, error: 'Not a review pane' };
    }
    if (reviewPane.review.handedOffAt || this.inFlightHandoffIds.has(reviewPaneId)) {
      log.warn('bridge', 'startFixHandoffAction rejected: already handed off', {
        handedOffAt: reviewPane.review.handedOffAt,
        reviewPaneId,
      });
      return { success: false, error: 'Findings already sent to the author' };
    }
    log.info('bridge', 'startFixHandoffAction begin', { reviewPaneId });

    this.inFlightHandoffIds.add(reviewPaneId);
    let findingsAbsolutePath: string | undefined;
    let promptDelivered = false;
    try {
      const reviewBlockReason = this.getReviewPaneReadinessBlockReason(reviewPane);
      if (reviewBlockReason) {
        log.warn('bridge', 'startFixHandoffAction rejected: reviewer not idle', {
          reason: reviewBlockReason,
          reviewPaneId,
        });
        return { success: false, error: reviewBlockReason };
      }
      const reviewReadinessToken = this.dependencies.captureReadinessTokenFor(reviewPaneId);

      const sourceReadiness = this.resolveReadyFixHandoffSourcePane(reviewPane.review);
      if (!sourceReadiness.pane) {
        log.warn('bridge', 'startFixHandoffAction rejected: source not ready', {
          reason: sourceReadiness.error,
          reviewPaneId,
        });
        return { success: false, error: sourceReadiness.error };
      }
      const sourceReadinessToken = this.dependencies.captureReadinessTokenFor(
        sourceReadiness.pane.id,
      );

      const findings = extractReviewFindings(this.dependencies.getSession(reviewPaneId));
      if (!findings) {
        log.warn('bridge', 'startFixHandoffAction rejected: no findings yet', { reviewPaneId });
        return { success: false, error: 'No review findings to send yet' };
      }

      const readiness = this.revalidateFixHandoffPanes(
        reviewPaneId,
        reviewPane.review,
        reviewReadinessToken,
        sourceReadinessToken,
      );
      if (!readiness.ok) {
        log.warn('bridge', 'startFixHandoffAction rejected: activity changed before commit', {
          reason: readiness.reason,
          reviewPaneId,
        });
        return { success: false, error: readiness.reason };
      }

      if (findings.kind === 'no-issues') {
        this.updateReviewPane(reviewPaneId, { handedOffAt: Date.now() });
        log.info('bridge', 'Fix handoff skipped: reviewer reported no issues', {
          elapsedMs: Date.now() - startedAt,
          reviewPaneId,
        });
        return { success: true, noIssues: true, sourcePaneId: sourceReadiness.pane.id };
      }

      const sourceRoot = readiness.sourcePane.worktreePath
        ?? readiness.sourcePane.projectRoot
        ?? this.dependencies.getProjectRoot();
      const sourceProjectRoot = readiness.sourcePane.projectRoot
        ?? this.dependencies.getProjectRoot()
        ?? sourceRoot;
      const { directory: reviewFindingsDirectory } = getReviewArtifactPaths(sourceProjectRoot);
      const findingsRelativePath = reviewFindingsRelPath(
        reviewPane.review.reviewId,
        reviewFindingsDirectory,
      );
      findingsAbsolutePath = join(sourceRoot, findingsRelativePath);
      sweepStaleFindings(join(sourceRoot, reviewFindingsDirectory));
      writeAumxFile(
        findingsAbsolutePath,
        buildFindingsFile(
          findings.text,
          reviewPane.agent ?? 'reviewer',
          reviewPane.review.reviewId,
        ),
      );

      await this.dependencies.sendPromptToPane(
        readiness.sourcePane.id,
        buildFixPrompt(findingsAbsolutePath),
      );
      promptDelivered = true;
      this.updateReviewPane(reviewPaneId, { handedOffAt: Date.now() });
      log.info('bridge', 'Fix handoff sent', {
        elapsedMs: Date.now() - startedAt,
        findingsRelPath: findingsRelativePath,
        reviewPaneId,
        sourcePaneId: readiness.sourcePane.id,
      });
      return { success: true, sourcePaneId: readiness.sourcePane.id };
    } catch (error) {
      if (findingsAbsolutePath && !promptDelivered) {
        rmSync(findingsAbsolutePath, { force: true });
      }
      log.error('bridge', 'startFixHandoffAction failed', { error, reviewPaneId });
      return { success: false, error: formatReviewError(error) };
    } finally {
      this.inFlightHandoffIds.delete(reviewPaneId);
    }
  }

  private async collectReviewDiff(
    reviewRoot: string,
    hasWorktree: boolean,
    snapshotSha: string,
    baseBranch: string,
  ): Promise<{ diffData: WorkingTreeDiffData; diffCommand: string }> {
    if (hasWorktree) {
      const diffData = await collectSnapshotDiffData(reviewRoot, baseBranch, snapshotSha);
      return { diffData, diffCommand: `git diff ${sh(baseBranch)}...HEAD` };
    }
    const diffData = await collectWorkingDiffData(reviewRoot, snapshotSha);
    return { diffData, diffCommand: 'git diff HEAD^..HEAD' };
  }

  private async gatherReviewContext(
    pane: AumxPane,
  ): Promise<{
    changedFiles: string[];
    launchMessage: string;
    rubric: string;
    rubricPath: string;
    snapshotSha: string;
  }> {
    const reviewRoot = pane.worktreePath
      ?? pane.projectRoot
      ?? this.dependencies.getProjectRoot();
    const projectRoot = pane.projectRoot
      ?? this.dependencies.getProjectRoot()
      ?? reviewRoot;
    const { rubric: rubricPath } = getReviewArtifactPaths(projectRoot);

    this.dependencies.setProgress('Reviewing changes: snapshotting…', true);
    const [snapshot, branch] = await Promise.all([
      createReviewSnapshot(reviewRoot),
      resolveBaseBranch(reviewRoot),
    ]);

    this.dependencies.setProgress('Reviewing changes: collecting diff…', true);
    const { diffData, diffCommand } = await this.collectReviewDiff(
      reviewRoot,
      Boolean(pane.worktreePath),
      snapshot.sha,
      branch,
    );
    const promptInput = {
      branch,
      changedFiles: diffData.changedFiles,
      deletions: diffData.deletions,
      diffCommand,
      insertions: diffData.insertions,
      originalPrompt: pane.prompt || '',
      repositoryPath: projectRoot,
      sessionDigest: buildReviewSessionDigest(this.dependencies.getSession(pane.id)),
      skippedFiles: snapshot.skippedFiles.length > 0 ? snapshot.skippedFiles : undefined,
    };

    return {
      changedFiles: diffData.changedFiles,
      launchMessage: buildReviewLaunchMessage(promptInput, rubricPath),
      rubric: buildReviewPrompt(promptInput),
      rubricPath,
      snapshotSha: snapshot.sha,
    };
  }

  private getFixHandoffSourceReadinessBlockReason(pane: AumxPane): string | undefined {
    const capabilityBlockReason = getFixHandoffSourceCapabilityBlockReason(pane);
    if (capabilityBlockReason) return capabilityBlockReason;
    return getFixHandoffSourceBlockReason(
      pane,
      this.dependencies.getPaneActivity(pane.id),
    );
  }

  private getReviewPaneReadinessBlockReason(pane: AumxPane): string | undefined {
    return getReviewPaneHandoffBlockReason(
      pane,
      this.dependencies.getPaneActivity(pane.id),
    );
  }

  private getReviewSourceReadinessBlockReason(pane: AumxPane): string | undefined {
    const capabilityBlockReason = getReviewSourceCapabilityBlockReason(pane);
    if (capabilityBlockReason) return capabilityBlockReason;
    return getReviewSourceBlockReason(pane, this.dependencies.getPaneActivity(pane.id));
  }

  private revalidateFixHandoffPanes(
    reviewPaneId: string,
    review: ReviewMetadata,
    reviewToken: ReadinessToken | undefined,
    sourceToken: ReadinessToken | undefined,
  ): { ok: true; sourcePane: AumxPane } | { ok: false; reason: string } {
    const reviewRevalidation = this.dependencies.revalidateReadinessOrReject(
      this.dependencies.getPane(reviewPaneId),
      reviewToken,
      (pane) => this.getReviewPaneReadinessBlockReason(pane),
      'Not a review pane',
    );
    if (!reviewRevalidation.ok) return reviewRevalidation;

    const sourceRevalidation = this.dependencies.revalidateReadinessOrReject(
      resolveReviewSourcePane(review, this.dependencies.getPanes()),
      sourceToken,
      (pane) => this.getFixHandoffSourceReadinessBlockReason(pane),
      'The original pane is no longer open',
    );
    if (!sourceRevalidation.ok) return sourceRevalidation;
    return { ok: true, sourcePane: sourceRevalidation.pane };
  }

  private resolveReadyFixHandoffSourcePane(
    review: ReviewMetadata,
  ): { error?: string; pane?: AumxPane } {
    const sourcePane = resolveReviewSourcePane(review, this.dependencies.getPanes());
    if (!sourcePane?.paneId) return { error: 'The original pane is no longer open' };
    const sourceBlockReason = this.getFixHandoffSourceReadinessBlockReason(sourcePane);
    if (sourceBlockReason) return { error: sourceBlockReason };
    return { pane: sourcePane };
  }

  private updateReviewPane(paneId: string, reviewOverrides: Partial<ReviewMetadata>): void {
    const panes = this.dependencies.getPanes();
    const index = panes.findIndex((pane) => pane.id === paneId);
    if (index < 0 || !panes[index].review) return;
    const updated = panes.map((pane, currentIndex) => currentIndex === index
      ? { ...pane, review: { ...pane.review!, ...reviewOverrides } }
      : pane);
    this.dependencies.replacePanesBestEffort(updated);
  }
}
