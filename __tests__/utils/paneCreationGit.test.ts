import { describe, expect, it } from 'vitest';
import {
  buildGitWorktreeAddArgs,
  buildGitWorktreeShellCommand,
} from '../../src/utils/paneCreationGit.js';

describe('git worktree add command boundaries', () => {
  it('builds argv for a new branch without invoking a shell', () => {
    expect(buildGitWorktreeAddArgs({
      branchName: 'feature/safe-worktree',
      createBranch: true,
      startPoint: '-leading-dash-ref',
      worktreePath: "/repo with spaces/owner's project/.muxbase/worktrees/safe-worktree",
    })).toEqual([
      'worktree',
      'add',
      '-b',
      'feature/safe-worktree',
      '--',
      "/repo with spaces/owner's project/.muxbase/worktrees/safe-worktree",
      '-leading-dash-ref',
    ]);
  });

  it('builds argv for an existing branch without treating values as options', () => {
    expect(buildGitWorktreeAddArgs({
      branchName: 'feature/existing',
      createBranch: false,
      worktreePath: '/repo/.muxbase/worktrees/-dash-like-path',
    })).toEqual([
      'worktree',
      'add',
      '--',
      '/repo/.muxbase/worktrees/-dash-like-path',
      'feature/existing',
    ]);
  });

  it('quotes every dynamic component in the intentional tmux-shell command', () => {
    const command = buildGitWorktreeShellCommand({
      branchName: "feature/owner's-work",
      createBranch: true,
      projectRoot: "/repo with spaces/owner's project",
      startPoint: '-leading-dash-ref',
      worktreePath: "/repo with spaces/owner's project/.muxbase/worktrees/work item",
    });

    expect(command).toBe(
      "cd '/repo with spaces/owner'\\''s project' && git worktree add -b 'feature/owner'\\''s-work' -- '/repo with spaces/owner'\\''s project/.muxbase/worktrees/work item' '-leading-dash-ref' && cd '/repo with spaces/owner'\\''s project/.muxbase/worktrees/work item'",
    );
  });
});
