/**
 * Multi-Merge Type Definitions
 *
 * Types for managing multiple worktree merges in a single operation.
 */

import type { MergeValidationResult } from '../../utils/mergeValidation.js';

/**
 * Information about a single worktree (either root or sub-worktree)
 */
export interface WorktreeInfo {
  /** Absolute path to the worktree directory */
  worktreePath: string;

  /** Absolute path to the parent repo (where the worktree originated from) */
  parentRepoPath: string;

  /** Name of the repository (derived from parent repo's directory name) */
  repoName: string;

  /** Current branch in this worktree */
  branch: string;

  /** Main branch in parent repo (main, master, etc.) */
  mainBranch: string;

  /** Whether this is the root worktree (the muxbase pane's worktree) */
  isRoot: boolean;

  /** Relative path from root worktree (for display), "." for root */
  relativePath: string;

  /** Depth level (0 = root, 1 = immediate child, etc.) */
  depth: number;
}

/**
 * A single item in the merge queue
 */
export interface MergeQueueItem {
  worktree: WorktreeInfo;
  validation: MergeValidationResult;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
  error?: string;
}

/**
 * Result of multi-merge operation
 */
export interface MultiMergeResult {
  totalWorktrees: number;
  successful: number;
  failed: number;
  skipped: number;
  results: Array<{
    worktree: WorktreeInfo;
    status: 'completed' | 'failed' | 'skipped';
    error?: string;
  }>;
}
