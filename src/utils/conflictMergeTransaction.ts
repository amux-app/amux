import path from 'node:path';
import type { AumxPane, ConflictMergeMetadata } from '../types.js';
import { execFileAsync } from './execAsync.js';

type ConflictMergeRepositoryStatus = 'conflicted' | 'clean' | 'failed';

export interface ConflictMergeRepositoryState {
  status: ConflictMergeRepositoryStatus;
  mergeHead?: string;
  unmergedFiles: string[];
  error?: string;
}

export interface ConflictMergeTransaction {
  id: string;
  repoPath: string;
  mainRepoPath?: string;
  sourceBranch: string;
  targetBranch: string;
  sourceCommit: string;
  targetCommit: string;
  sourcePaneId: string;
  conflictPaneId: string;
  state: 'active' | 'resolved';
}

export interface ConflictMergeRecovery {
  paneId: string;
  repoPath: string;
  mergeHead?: string;
  unmergedFiles: string[];
  error?: string;
}

export function conflictMergeTransactionFromMetadata(
  metadata: ConflictMergeMetadata,
): Omit<ConflictMergeTransaction, 'state'> {
  return {
    conflictPaneId: metadata.conflictPaneId,
    id: metadata.transactionId,
    mainRepoPath: metadata.mainRepoPath,
    repoPath: metadata.repoPath,
    sourceBranch: metadata.sourceBranch,
    sourceCommit: metadata.sourceCommit,
    sourcePaneId: metadata.sourcePaneId,
    targetBranch: metadata.targetBranch,
    targetCommit: metadata.targetCommit,
  };
}

const transactions = new Map<string, ConflictMergeTransaction>();

function transactionKey(repoPath: string): string {
  return path.resolve(repoPath);
}

export function registerConflictMergeTransaction(
  transaction: Omit<ConflictMergeTransaction, 'state'>,
): ConflictMergeTransaction {
  const key = transactionKey(transaction.repoPath);
  const existing = transactions.get(key);
  if (existing && existing.id !== transaction.id) {
    throw new Error(`A conflict merge is already active for ${transaction.repoPath}`);
  }

  const registered: ConflictMergeTransaction = { ...transaction, state: existing?.state ?? 'active' };
  transactions.set(key, registered);
  return registered;
}

export function getConflictMergeTransaction(repoPath: string): ConflictMergeTransaction | undefined {
  return transactions.get(transactionKey(repoPath));
}

export function listConflictMergeTransactions(): ConflictMergeTransaction[] {
  return Array.from(transactions.values());
}

export function findConflictMergeTransactionByPane(paneId: string): ConflictMergeTransaction | undefined {
  return Array.from(transactions.values()).find((transaction) => (
    transaction.sourcePaneId === paneId || transaction.conflictPaneId === paneId
  ));
}

export function findConflictMergeTransactionForMerge(
  mainRepoPath: string,
  worktreeBranch: string,
): ConflictMergeTransaction | undefined {
  const canonicalMainRepoPath = transactionKey(mainRepoPath);
  return Array.from(transactions.values()).find((transaction) => (
    transaction.mainRepoPath && transactionKey(transaction.mainRepoPath) === canonicalMainRepoPath
      && transaction.sourceBranch === worktreeBranch
  ));
}

export async function scanConflictMergeRecovery(
  panes: readonly Pick<AumxPane, 'id' | 'worktreePath'>[],
): Promise<ConflictMergeRecovery[]> {
  const recoveries: Array<ConflictMergeRecovery | undefined> = await Promise.all(panes.flatMap((pane) => {
    if (!pane.worktreePath) return [];
    return [inspectConflictMergeState(pane.worktreePath).then((state) => (
      state.status === 'clean' || (!state.mergeHead && state.unmergedFiles.length === 0)
        ? undefined
        : {
            ...(state.error ? { error: state.error } : {}),
            ...(state.mergeHead ? { mergeHead: state.mergeHead } : {}),
            paneId: pane.id,
            repoPath: pane.worktreePath!,
            unmergedFiles: state.unmergedFiles,
          } satisfies ConflictMergeRecovery
    ))];
  }));
  return recoveries.filter((recovery): recovery is ConflictMergeRecovery => recovery !== undefined);
}

export function clearConflictMergeTransaction(repoPath: string): void {
  transactions.delete(transactionKey(repoPath));
}

export function clearConflictMergeTransactionById(id: string): void {
  for (const [key, transaction] of transactions) {
    if (transaction.id === id) transactions.delete(key);
  }
}

export async function inspectConflictMergeState(repoPath: string): Promise<ConflictMergeRepositoryState> {
  try {
    const [mergeHead, unmergedOutput] = await Promise.all([
      readOptionalGit(repoPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']),
      execFileAsync('git', ['diff', '--name-only', '--diff-filter=U', '--'], { cwd: repoPath }),
    ]);
    const unmergedFiles = unmergedOutput.split(/\r?\n/).map((file) => file.trim()).filter(Boolean);
    if (mergeHead) {
      return { status: 'conflicted', mergeHead, unmergedFiles };
    }
    if (unmergedFiles.length === 0) {
      return { status: 'clean', unmergedFiles };
    }
    return {
      status: 'failed',
      unmergedFiles,
      error: 'Repository has unmerged files without an active MERGE_HEAD',
    };
  } catch (error) {
    return {
      status: 'failed',
      unmergedFiles: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function verifyPreparedConflictMerge(
  transaction: Pick<ConflictMergeTransaction, 'repoPath' | 'sourceCommit' | 'targetCommit'>,
): Promise<ConflictMergeRepositoryState> {
  const state = await inspectConflictMergeState(transaction.repoPath);
  if (state.status !== 'conflicted' || state.mergeHead !== transaction.targetCommit) {
    return {
      ...state,
      status: 'failed',
      error: `Prepared merge does not match expected commits (${transaction.sourceCommit} -> ${transaction.targetCommit})`,
    };
  }

  const currentHead = await readOptionalGit(transaction.repoPath, ['rev-parse', '--verify', 'HEAD']);
  if (currentHead !== transaction.sourceCommit) {
    return {
      ...state,
      status: 'failed',
      error: `Prepared merge source changed from ${transaction.sourceCommit} to ${currentHead || 'unknown'}`,
    };
  }
  return state;
}

export async function verifyResolvedConflictMerge(
  transaction: Pick<ConflictMergeTransaction, 'repoPath' | 'sourceCommit' | 'targetCommit'>,
): Promise<boolean> {
  const state = await inspectConflictMergeState(transaction.repoPath);
  if (state.status !== 'clean') return false;

  const headWithParents = await readOptionalGit(transaction.repoPath, ['rev-list', '--parents', '-n', '1', 'HEAD']);
  if (!headWithParents) return false;
  const [, ...parents] = headWithParents.split(/\s+/);
  return parents.includes(transaction.sourceCommit) && parents.includes(transaction.targetCommit);
}

export async function markConflictMergeResolved(id: string): Promise<boolean> {
  const transaction = Array.from(transactions.values()).find((candidate) => candidate.id === id);
  if (!transaction) return false;
  if (!await verifyResolvedConflictMerge(transaction)) return false;
  transaction.state = 'resolved';
  return true;
}

/** Mark a transaction resolved after an external monitor has already verified its Git identity. */
export function markConflictMergeResolvedAfterVerification(id: string): boolean {
  const transaction = Array.from(transactions.values()).find((candidate) => candidate.id === id);
  if (!transaction) return false;
  transaction.state = 'resolved';
  return true;
}

export async function abortConflictMergeTransaction(
  transaction: ConflictMergeTransaction,
  options: { retainRegistration?: boolean } = {},
): Promise<{ success: boolean; error?: string }> {
  try {
    const currentState = await inspectConflictMergeState(transaction.repoPath);
    if (currentState.status === 'clean') {
      if (!options.retainRegistration) clearConflictMergeTransactionById(transaction.id);
      return { success: true };
    }
    const preparedState = await verifyPreparedConflictMerge(transaction);
    if (preparedState.status !== 'conflicted') {
      return {
        success: false,
        error: preparedState.error || 'Conflict merge transaction no longer matches the prepared merge',
      };
    }
    await execFileAsync('git', ['merge', '--abort'], { cwd: transaction.repoPath });
    const state = await inspectConflictMergeState(transaction.repoPath);
    if (state.status !== 'clean') {
      return { success: false, error: state.error || 'Merge abort did not restore a clean repository' };
    }
    if (!options.retainRegistration) clearConflictMergeTransactionById(transaction.id);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function abortAllConflictMergeTransactions(): Promise<{
  success: boolean;
  failures: Array<{ transactionId: string; repoPath: string; error: string }>;
}> {
  const failures: Array<{ transactionId: string; repoPath: string; error: string }> = [];
  for (const transaction of listConflictMergeTransactions().filter((candidate) => candidate.state === 'active')) {
    const result = await abortConflictMergeTransaction(transaction);
    if (!result.success) {
      failures.push({
        transactionId: transaction.id,
        repoPath: transaction.repoPath,
        error: result.error || 'Merge abort failed',
      });
    }
  }
  return { success: failures.length === 0, failures };
}

export function resetConflictMergeTransactionsForTests(): void {
  transactions.clear();
}

async function readOptionalGit(repoPath: string, args: string[]): Promise<string | undefined> {
  try {
    const output = await execFileAsync('git', args, { cwd: repoPath });
    const value = output.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}
