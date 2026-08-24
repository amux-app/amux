import {
  execAsync,
  execAsyncWithStatus,
  type ExecAsyncResult,
} from './execAsync.js';
import { shQuote } from './shellEscape.js';

export interface ConflictMergePreparation {
  repoPath: string;
  sourceCommit: string;
  targetCommit: string;
}

export async function prepareConflictMerge(
  repoPath: string,
  targetBranch: string,
): Promise<ConflictMergePreparation> {
  const resetResult = await abortConflictMerge(repoPath);
  if (resetResult.exitCode !== 0) {
    const existingMergeHead = await inspectMergeHead(repoPath);
    if (existingMergeHead.exitCode !== 1) {
      throw new Error(`Cannot reset existing merge in ${repoPath}: ${getProcessError(resetResult)}`);
    }
  }

  const sourceCommit = await resolveCommit(repoPath, 'HEAD', 'current HEAD');
  const targetCommit = await resolveCommit(repoPath, `${targetBranch}^{commit}`, `target branch ${targetBranch}`);
  const mergeResult = await execAsyncWithStatus(
    `git merge --no-commit --no-ff --no-edit -- ${shQuote(targetBranch)}`,
    { cwd: repoPath, timeout: 120000 },
  );

  if (mergeResult.exitCode === 0) {
    throw new Error(`Merge of ${targetBranch} completed without conflicts; no resolution pane is needed`);
  }

  const mergeHead = await inspectMergeHead(repoPath);
  if (mergeHead.exitCode !== 0) {
    throw new Error(`Unable to prepare merge conflicts for ${targetBranch}: ${getProcessError(mergeResult)}`);
  }
  if (mergeHead.stdout.trim() !== targetCommit) {
    throw new Error(
      `Prepared merge target changed unexpectedly: expected ${targetCommit}, got ${mergeHead.stdout.trim() || 'no MERGE_HEAD'}`,
    );
  }

  const unresolvedFiles = await execAsync('git diff --name-only --diff-filter=U --', { cwd: repoPath, timeout: 10000 });
  if (!unresolvedFiles.trim()) {
    throw new Error(`Merge of ${targetBranch} failed without unresolved files: ${getProcessError(mergeResult)}`);
  }
  return { repoPath, sourceCommit, targetCommit };
}

async function resolveCommit(repoPath: string, revision: string, label: string): Promise<string> {
  const result = await execAsyncWithStatus(`git rev-parse --verify ${shQuote(revision)}`, { cwd: repoPath, timeout: 5000 });
  const commit = result.stdout.trim();
  if (result.exitCode !== 0 || !commit) throw new Error(`Cannot resolve ${label} in ${repoPath}: ${getProcessError(result)}`);
  return commit;
}

export function abortConflictMerge(repoPath: string): Promise<ExecAsyncResult> {
  return execAsyncWithStatus('git merge --abort', { cwd: repoPath, timeout: 30000 });
}

export function inspectMergeHead(repoPath: string): Promise<ExecAsyncResult> {
  return execAsyncWithStatus('git rev-parse --verify -q MERGE_HEAD', { cwd: repoPath, timeout: 5000 });
}

function getProcessError(result: ExecAsyncResult): string {
  if (result.stderr) return result.stderr;
  if (result.timedOut) return 'command timed out';
  if (result.exitCode === null) return 'command could not be executed';
  return `git exited with code ${result.exitCode}`;
}
