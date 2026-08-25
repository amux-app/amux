import { describe, expect, it } from 'vitest';
import {
  MUXBASE_GITIGNORE_ENTRY,
  deriveProjectRootFromManagedWorktreePath,
  getManagedWorktreePath,
  getManagedWorktreesDir,
} from '../src/utils/worktreePaths.js';

describe('worktree path helpers', () => {
  it('builds managed worktree directories from the project root', () => {
    expect(getManagedWorktreesDir('/workspace/project')).toBe('/workspace/project/.muxbase/worktrees');
    expect(getManagedWorktreePath('/workspace/project', 'fix-auth')).toBe('/workspace/project/.muxbase/worktrees/fix-auth');
  });

  it('derives project roots from managed worktree paths', () => {
    expect(deriveProjectRootFromManagedWorktreePath('/workspace/project/.muxbase/worktrees/fix-auth')).toBe('/workspace/project');
    expect(deriveProjectRootFromManagedWorktreePath('C:\\workspace\\project\\.muxbase\\worktrees\\fix-auth')).toBe('C:\\workspace\\project');
  });

  it('does not derive roots from unmanaged worktree paths', () => {
    expect(deriveProjectRootFromManagedWorktreePath('/workspace/worktrees/fix-auth')).toBeUndefined();
  });

  it('exposes the managed metadata ignore entry', () => {
    expect(MUXBASE_GITIGNORE_ENTRY).toBe('.muxbase/');
  });
});
