import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isConflictResolutionCommitted,
  startConflictMonitoring,
} from '../../src/utils/conflictMonitor.js';
import { execFileAsync } from '../../src/utils/execAsync.js';
import { TmuxService } from '../../src/services/TmuxService.js';

vi.mock('../../src/utils/execAsync.js', () => ({
  execFileAsync: vi.fn(),
}));

const SOURCE_COMMIT = '1111111111111111111111111111111111111111';
const TARGET_COMMIT = '2222222222222222222222222222222222222222';
const MERGE_COMMIT = '3333333333333333333333333333333333333333';

function mockGitState(options: {
  mergeHead?: string;
  unresolved?: string;
  headLine?: string;
}): void {
  vi.mocked(execFileAsync).mockImplementation(async (_file, args) => {
    const command = args.join(' ');
    if (command === 'rev-parse --verify -q MERGE_HEAD') {
      if (options.mergeHead === undefined) throw new Error('no merge in progress');
      return options.mergeHead;
    }
    if (command === 'diff --name-only --diff-filter=U --') {
      return options.unresolved ?? '';
    }
    if (command === 'rev-list --parents -n 1 HEAD') {
      return options.headLine ?? '';
    }
    throw new Error(`Unexpected git command: ${command}`);
  });
}

describe('isConflictResolutionCommitted', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts only a new merge commit with both prepared commits as parents', async () => {
    mockGitState({
      headLine: `${MERGE_COMMIT} ${SOURCE_COMMIT} ${TARGET_COMMIT}`,
    });

    await expect(isConflictResolutionCommitted('/workspace/worktree', {
      sourceCommit: SOURCE_COMMIT,
      targetCommit: TARGET_COMMIT,
    })).resolves.toBe(true);
  });

  it('does not treat aborting back to a pre-existing merge-commit HEAD as resolution', async () => {
    mockGitState({
      headLine: `${SOURCE_COMMIT} aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
    });

    await expect(isConflictResolutionCommitted('/workspace/worktree', {
      sourceCommit: SOURCE_COMMIT,
      targetCommit: TARGET_COMMIT,
    })).resolves.toBe(false);
  });

  it('does not resolve while unmerged index entries remain', async () => {
    mockGitState({
      unresolved: 'src/conflicted.ts\n',
      headLine: `${MERGE_COMMIT} ${SOURCE_COMMIT} ${TARGET_COMMIT}`,
    });

    await expect(isConflictResolutionCommitted('/workspace/worktree', {
      sourceCommit: SOURCE_COMMIT,
      targetCommit: TARGET_COMMIT,
    })).resolves.toBe(false);
  });

  it('rejects a merge commit that does not contain both prepared parents', async () => {
    mockGitState({
      headLine: `${MERGE_COMMIT} ${SOURCE_COMMIT} aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    });

    await expect(isConflictResolutionCommitted('/workspace/worktree', {
      sourceCommit: SOURCE_COMMIT,
      targetCommit: TARGET_COMMIT,
    })).resolves.toBe(false);
  });

  it('does not resolve while MERGE_HEAD still exists', async () => {
    mockGitState({
      mergeHead: TARGET_COMMIT,
      headLine: `${MERGE_COMMIT} ${SOURCE_COMMIT} ${TARGET_COMMIT}`,
    });

    await expect(isConflictResolutionCommitted('/workspace/worktree', {
      sourceCommit: SOURCE_COMMIT,
      targetCommit: TARGET_COMMIT,
    })).resolves.toBe(false);
  });
});

describe('startConflictMonitoring', () => {
  it('rejects missing preparation identities before registering an interval', () => {
    expect(() => startConflictMonitoring({
      conflictPaneId: '%9',
      expectedCommits: undefined as never,
      onResolved: vi.fn(),
      repoPath: '/workspace/worktree',
    })).toThrow('prepared commit identities');
  });

  it('serializes interval checks so resolution is delivered exactly once', async () => {
    vi.useFakeTimers();
    const onResolved = vi.fn();
    let resolvePaneExists: ((exists: boolean) => void) | undefined;
    const paneExists = new Promise<boolean>((resolve) => {
      resolvePaneExists = resolve;
    });
    const paneExistsSpy = vi.spyOn(TmuxService.getInstance(), 'paneExists')
      .mockReturnValue(paneExists);
    mockGitState({
      headLine: `${MERGE_COMMIT} ${SOURCE_COMMIT} ${TARGET_COMMIT}`,
    });

    const cleanup = startConflictMonitoring({
      checkIntervalMs: 100,
      conflictPaneId: '%9',
      expectedCommits: {
        sourceCommit: SOURCE_COMMIT,
        targetCommit: TARGET_COMMIT,
      },
      onResolved,
      repoPath: '/workspace/worktree',
    });

    try {
      vi.advanceTimersByTime(500);
      expect(paneExistsSpy).toHaveBeenCalledTimes(1);

      resolvePaneExists?.(true);
      await vi.waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(500);

      expect(paneExistsSpy).toHaveBeenCalledTimes(1);
      expect(onResolved).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
      paneExistsSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
