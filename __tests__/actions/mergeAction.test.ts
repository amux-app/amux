import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mergePane } from '../../src/actions/implementations/mergeAction.js';
import { buildMergeQueue } from '../../src/actions/merge/multiMergeOrchestrator.js';
import type { MergeQueueItem, WorktreeInfo } from '../../src/actions/merge/types.js';
import type { ActionContext } from '../../src/actions/types.js';
import type { MuxBasePane } from '../../src/types.js';
import { validateMerge } from '../../src/utils/mergeValidation.js';
import type { MergeValidationResult } from '../../src/utils/mergeValidation.js';
import { detectAllWorktrees } from '../../src/utils/worktreeDiscovery.js';

vi.mock('../../src/actions/merge/mergeExecution.js', () => ({
  executeMerge: vi.fn(),
}));

vi.mock('../../src/actions/merge/multiMergeOrchestrator.js', () => ({
  buildMergeQueue: vi.fn(),
  executeMultiMerge: vi.fn(),
}));

vi.mock('../../src/actions/merge/issueHandlers/index.js', () => ({
  handleMainDirty: vi.fn(),
  handleMergeConflict: vi.fn(),
  handleNothingToMerge: vi.fn(),
  handleWorktreeUncommitted: vi.fn(),
}));

vi.mock('../../src/services/LogService.js', () => ({
  LogService: {
    getInstance: vi.fn(() => ({
      debug: vi.fn(),
    })),
  },
}));

vi.mock('../../src/utils/hooks.js', () => ({
  triggerHook: vi.fn(),
}));

vi.mock('../../src/utils/mergeValidation.js', () => ({
  validateMerge: vi.fn(),
}));

vi.mock('../../src/utils/worktreeDiscovery.js', () => ({
  detectAllWorktrees: vi.fn(),
}));

describe('mergePane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses pane project metadata as the main repo path', async () => {
    const pane: MuxBasePane = {
      id: 'muxbase-1',
      slug: 'fix-auth',
      prompt: 'test',
      paneId: '%1',
      projectRoot: '/workspace/main-project',
      worktreePath: '/external/worktrees/fix-auth',
    };
    const context: ActionContext = {
      panes: [pane],
      projectName: 'main-project',
      savePanes: vi.fn(),
      sessionName: 'muxbase-main-project',
    };
    const rootWorktree: WorktreeInfo = {
      branch: 'fix-auth',
      depth: 0,
      isRoot: true,
      mainBranch: 'main',
      parentRepoPath: '/workspace/main-project',
      relativePath: '.',
      repoName: 'main-project',
      worktreePath: '/external/worktrees/fix-auth',
    };
    const validation: MergeValidationResult = {
      canMerge: true,
      issues: [],
      mainBranch: 'main',
    };
    const queue: MergeQueueItem[] = [{
      status: 'pending',
      validation,
      worktree: rootWorktree,
    }];

    vi.mocked(detectAllWorktrees).mockResolvedValue([rootWorktree]);
    vi.mocked(buildMergeQueue).mockResolvedValue(queue);
    vi.mocked(validateMerge).mockReturnValue(validation);

    const result = await mergePane(pane, context);

    expect(result.type).toBe('confirm');
    expect(validateMerge).toHaveBeenCalledWith('/workspace/main-project', '/external/worktrees/fix-auth', 'fix-auth');
  });

  it('rejects merging a review pane without inspecting worktrees', async () => {
    const pane: MuxBasePane = {
      id: 'muxbase-review-1',
      slug: 'review-fix-auth',
      prompt: 'review',
      paneId: '%2',
      projectRoot: '/workspace/main-project',
      worktreePath: '/external/worktrees/review-fix-auth',
      role: 'review',
    };
    const context: ActionContext = {
      panes: [pane],
      projectName: 'main-project',
      savePanes: vi.fn(),
      sessionName: 'muxbase-main-project',
    };

    const result = await mergePane(pane, context);

    expect(result.type).toBe('error');
    expect(detectAllWorktrees).not.toHaveBeenCalled();
  });
});
