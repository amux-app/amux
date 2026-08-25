import { IPC } from '../../shared/ipc-channels.js';
import type {
  GitBranchesRequest,
  GitDiffMode,
  GitDiffRequest,
  GitDiffResponse,
  GitFileDiffRequest,
  GitStatusRequest,
  GitStatusResponse,
} from '../../shared/ipc-types.js';
import type { MuxBaseBridge } from '../services/MuxBaseBridge.js';
import { formatError } from '../utils/formatError.js';
import { resolveAuthorizedFileRoot } from '../utils/file-root-authorization.js';
import { REV_PARSE } from '../services/git/gitArgs.js';
import {
  collectRangeDiffData,
  collectRangeFilePatch,
  collectWorkingTreeFilePatch,
  getWorktreeMeta,
  getWorktreeSnapshot,
  git,
  resolveBaseBranch,
  safeGit,
  type WorkingTreeDiffData,
  type WorktreeMeta,
} from '../services/git/gitDiff.js';
import { buildGitStatusResponse } from '../services/git/gitStatus.js';
import { log } from '../services/Logger.js';
import { RuntimeActivityMetrics } from '../services/RuntimeActivityMetrics.js';
import { secureHandle } from './ipc-security.js';

const EMPTY_STATUS_RESPONSE: GitStatusResponse = {
  commitsAhead: null,
  deletions: 0,
  filesChanged: 0,
  hasChanges: false,
  insertions: 0,
};

const NOT_A_REPO_RESPONSE: GitDiffResponse = {
  diff: '',
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
  changedFiles: [],
  untrackedFiles: [],
  files: [],
  repo: { isGitRepo: false },
};

function buildDiffResponse(meta: WorktreeMeta, diff: WorkingTreeDiffData): GitDiffResponse {
  const { context } = meta;
  return {
    diff: diff.diff,
    filesChanged: diff.filesChanged,
    insertions: diff.insertions,
    deletions: diff.deletions,
    changedFiles: diff.changedFiles,
    untrackedFiles: diff.untrackedFiles,
    files: diff.files,
    repo: {
      isGitRepo: true,
      branch: context.detachedHead ? undefined : context.branch,
      detachedHead: context.detachedHead,
      repoRoot: context.gitRoot,
      isWorktree: context.isWorktree,
    },
    commitsAhead: meta.commitsAhead,
    recentCommits: meta.recentCommits,
  };
}

function notARepoResponse(worktreePath: string): GitDiffResponse {
  log.info('ipc:git', 'GIT_DIFF target is not a git repository', { worktreePath });
  return NOT_A_REPO_RESPONSE;
}

async function buildWorkingDiffResponse(worktreePath: string): Promise<GitDiffResponse> {
  const snapshot = await getWorktreeSnapshot(worktreePath, true);
  return snapshot ? buildDiffResponse(snapshot, snapshot.diff) : notARepoResponse(worktreePath);
}

/**
 * A commit range is diffed on its own; only the repository context and branch
 * metadata come from the shared snapshot, never the working-tree scan.
 */
async function buildRangeDiffResponse(
  worktreePath: string,
  diffMode: Exclude<GitDiffMode, 'working'>,
): Promise<GitDiffResponse> {
  const meta = await getWorktreeMeta(worktreePath);
  if (!meta) return notARepoResponse(worktreePath);
  return buildDiffResponse(meta, await collectRangeDiffData(worktreePath, diffMode, meta.baseBranch));
}

export function registerGitHandlers(bridge: MuxBaseBridge): void {
  const authorizeRoot = (requestedRoot: string): string =>
    resolveAuthorizedFileRoot(bridge.getProjectRoot(), bridge.getPanes(), requestedRoot);

  secureHandle(IPC.GIT_DIFF, async (_event, request: GitDiffRequest) => {
    log.debug('ipc:git', 'GIT_DIFF request', { worktreePath: request.worktreePath });
    try {
      const worktreePath = authorizeRoot(request.worktreePath);
      const diffMode: GitDiffMode = request.diffMode ?? 'working';
      const response = diffMode === 'working'
        ? await buildWorkingDiffResponse(worktreePath)
        : await buildRangeDiffResponse(worktreePath, diffMode);

      log.debug('ipc:git', 'GIT_DIFF response', {
        filesChanged: response.filesChanged,
        insertions: response.insertions,
        deletions: response.deletions,
      });

      return response;
    } catch (error) {
      log.error('ipc:git', 'GIT_DIFF failed', error);
      return { error: formatError(error) };
    }
  });

  secureHandle(IPC.GIT_FILE_DIFF, async (_event, request: GitFileDiffRequest) => {
    log.debug('ipc:git', 'GIT_FILE_DIFF request', {
      diffMode: request.diffMode,
      path: request.path,
      worktreePath: request.worktreePath,
    });
    try {
      const worktreePath = authorizeRoot(request.worktreePath);
      const gitRoot = await safeGit(worktreePath, [REV_PARSE, '--show-toplevel']);
      if (!gitRoot) {
        return { path: request.path, error: 'Target is not a Git repository' };
      }

      const diffMode: GitDiffMode = request.diffMode ?? 'working';
      const response = diffMode === 'working'
        ? await collectWorkingTreeFilePatch(worktreePath, request.path, request.oldPath)
        : await collectRangeFilePatch(
          worktreePath,
          diffMode,
          await resolveBaseBranch(worktreePath),
          request.path,
          request.oldPath,
        );

      log.debug('ipc:git', 'GIT_FILE_DIFF response', {
        isBinary: response.isBinary,
        patchLength: response.patch?.length ?? 0,
        path: response.path,
        tooLarge: response.tooLarge,
      });

      return response;
    } catch (error) {
      log.error('ipc:git', 'GIT_FILE_DIFF failed', error);
      return { path: request.path, error: formatError(error) };
    }
  });

  secureHandle(IPC.GIT_STATUS, async (_event, request: GitStatusRequest) => {
    RuntimeActivityMetrics.getInstance().recordGitStatusPoll();
    try {
      const snapshot = await getWorktreeSnapshot(authorizeRoot(request.worktreePath), false);
      if (!snapshot) return EMPTY_STATUS_RESPONSE;
      return buildGitStatusResponse(snapshot.diff, snapshot.commitsAhead);
    } catch (error) {
      log.error('ipc:git', 'GIT_STATUS failed', error);
      return { error: formatError(error) };
    }
  });

  secureHandle(IPC.GIT_BRANCHES, async (_event, request: GitBranchesRequest) => {
    log.debug('ipc:git', 'GIT_BRANCHES', { projectRoot: request.projectRoot });
    try {
      const output = await git(authorizeRoot(request.projectRoot), ['branch', '--list']);
      const branches = output
        .split('\n')
        .map((b) => b.replace(/^\*?\s+/, '').trim())
        .filter(Boolean);
      return { branches };
    } catch (error) {
      return { error: formatError(error) };
    }
  });
}
