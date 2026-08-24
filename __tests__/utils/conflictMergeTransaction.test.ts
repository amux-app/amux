import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileAsync } from '../../src/utils/execAsync.js';
import {
  abortConflictMergeTransaction,
  getConflictMergeTransaction,
  inspectConflictMergeState,
  registerConflictMergeTransaction,
  resetConflictMergeTransactionsForTests,
  scanConflictMergeRecovery,
  verifyPreparedConflictMerge,
  verifyResolvedConflictMerge,
} from '../../src/utils/conflictMergeTransaction.js';

vi.mock('../../src/utils/execAsync.js', () => ({ execFileAsync: vi.fn() }));

const tx = {
  id: 'tx-1',
  repoPath: '/workspace/worktree',
  mainRepoPath: '/workspace/main',
  sourceBranch: 'feature',
  targetBranch: 'main',
  sourceCommit: 'source-commit',
  targetCommit: 'target-commit',
  sourcePaneId: 'source-pane',
  conflictPaneId: 'conflict-pane',
};

describe('conflict merge transaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetConflictMergeTransactionsForTests();
  });

  it('classifies conflicts from MERGE_HEAD and unmerged index entries', async () => {
    vi.mocked(execFileAsync).mockImplementation(async (_file, args) => {
      if (args.includes('MERGE_HEAD')) return 'target-commit\n';
      return 'src/conflicted.ts\n';
    });

    await expect(inspectConflictMergeState('/workspace/worktree')).resolves.toEqual({
      status: 'conflicted',
      mergeHead: 'target-commit',
      unmergedFiles: ['src/conflicted.ts'],
    });
  });

  it('requires the prepared source and target identities', async () => {
    registerConflictMergeTransaction(tx);
    vi.mocked(execFileAsync).mockImplementation(async (_file, args) => {
      if (args.includes('MERGE_HEAD')) return 'target-commit';
      if (args.includes('HEAD')) return 'source-commit';
      return 'src/conflicted.ts';
    });

    await expect(verifyPreparedConflictMerge(tx)).resolves.toMatchObject({
      status: 'conflicted',
      mergeHead: 'target-commit',
    });
  });

  it('accepts only a clean merge commit containing both prepared parents', async () => {
    registerConflictMergeTransaction(tx);
    vi.mocked(execFileAsync).mockImplementation(async (_file, args) => {
      if (args.includes('MERGE_HEAD')) throw new Error('no merge head');
      if (args.includes('rev-list')) return 'merge-commit source-commit target-commit';
      return '';
    });

    await expect(verifyResolvedConflictMerge(tx)).resolves.toBe(true);
  });

  it('keeps the transaction registered when abort cannot restore a clean state', async () => {
    const registered = registerConflictMergeTransaction(tx);
    vi.mocked(execFileAsync).mockImplementation(async (_file, args) => {
      if (args[0] === 'merge' && args[1] === '--abort') return '';
      if (args.includes('MERGE_HEAD')) return 'target-commit';
      return 'src/conflicted.ts';
    });

    await expect(abortConflictMergeTransaction(registered)).resolves.toMatchObject({ success: false });
    expect(getConflictMergeTransaction(tx.repoPath)).toBeDefined();
  });

  it('refuses to abort a different merge that replaced the prepared transaction', async () => {
    const registered = registerConflictMergeTransaction(tx);
    vi.mocked(execFileAsync).mockImplementation(async (_file, args) => {
      if (args.includes('MERGE_HEAD')) return 'different-target';
      if (args[0] === 'diff') return 'src/different-conflict.ts';
      return '';
    });

    await expect(abortConflictMergeTransaction(registered)).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('does not match expected commits'),
    });
    expect(execFileAsync).not.toHaveBeenCalledWith(
      'git',
      ['merge', '--abort'],
      { cwd: tx.repoPath },
    );
    expect(getConflictMergeTransaction(tx.repoPath)).toBeDefined();
  });

  it('aborts the prepared merge after all conflicts are staged', async () => {
    const registered = registerConflictMergeTransaction(tx);
    let aborted = false;
    vi.mocked(execFileAsync).mockImplementation(async (_file, args) => {
      if (args[0] === 'merge' && args[1] === '--abort') {
        aborted = true;
        return '';
      }
      if (args.includes('MERGE_HEAD')) {
        if (aborted) throw new Error('no merge head');
        return 'target-commit';
      }
      if (args.includes('HEAD')) return 'source-commit';
      // Unmerged-file query: every conflict has already been staged.
      return '';
    });

    await expect(abortConflictMergeTransaction(registered)).resolves.toEqual({ success: true });

    const abortCalls = vi.mocked(execFileAsync).mock.calls.filter(
      ([, args]) => args[0] === 'merge' && args[1] === '--abort',
    );
    expect(abortCalls).toEqual([['git', ['merge', '--abort'], { cwd: tx.repoPath }]]);
    expect(getConflictMergeTransaction(tx.repoPath)).toBeUndefined();
  });

  it('finds interrupted merge states from persisted worktree panes', async () => {
    vi.mocked(execFileAsync).mockImplementation(async (_file, args, options) => {
      if (options?.cwd === '/workspace/conflicted' && args.includes('MERGE_HEAD')) return 'target-commit';
      if (options?.cwd === '/workspace/conflicted') return 'src/conflicted.ts';
      return '';
    });

    await expect(scanConflictMergeRecovery([
      { id: 'clean-pane', worktreePath: '/workspace/clean' },
      { id: 'conflict-pane', worktreePath: '/workspace/conflicted' },
      { id: 'shell-pane', worktreePath: undefined },
    ])).resolves.toEqual([{
      mergeHead: 'target-commit',
      paneId: 'conflict-pane',
      repoPath: '/workspace/conflicted',
      unmergedFiles: ['src/conflicted.ts'],
    }]);
  });
});
