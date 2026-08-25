import path from 'path';

const MUXBASE_METADATA_DIR_NAME = '.muxbase';
const MUXBASE_HOOKS_DIR_NAME = '.muxbase-hooks';
const MUXBASE_WORKTREES_DIR_NAME = 'worktrees';
const MUXBASE_CONFIG_FILE_NAME = 'muxbase.config.json';
export const MUXBASE_GITIGNORE_ENTRY = `${MUXBASE_METADATA_DIR_NAME}/`;

const MANAGED_WORKTREE_PATH_PATTERN = /[\\\/]\.muxbase[\\\/]worktrees[\\\/][^\\\/]+[\\\/]?$/;

export function getProjectMetadataDir(projectRoot: string): string {
  return path.join(projectRoot, MUXBASE_METADATA_DIR_NAME);
}

export function getProjectConfigPath(projectRoot: string): string {
  return path.join(getProjectMetadataDir(projectRoot), MUXBASE_CONFIG_FILE_NAME);
}

export function getProjectMetadataPath(projectRoot: string, ...segments: string[]): string {
  return path.join(getProjectMetadataDir(projectRoot), ...segments);
}

export function getProjectMetadataGitignoreEntry(projectRoot: string): string {
  return `${path.basename(getProjectMetadataDir(projectRoot))}/`;
}

export function getProjectHooksDir(projectRoot: string): string {
  return path.join(projectRoot, MUXBASE_HOOKS_DIR_NAME);
}

export function getProjectHooksGitignoreEntry(projectRoot: string): string {
  return `${path.basename(getProjectHooksDir(projectRoot))}/`;
}

export function getManagedWorktreesDir(projectRoot: string): string {
  return path.join(getProjectMetadataDir(projectRoot), MUXBASE_WORKTREES_DIR_NAME);
}

export function getManagedWorktreePath(projectRoot: string, slug: string): string {
  return path.join(getManagedWorktreesDir(projectRoot), slug);
}

export function deriveProjectRootFromManagedWorktreePath(worktreePath?: string): string | undefined {
  if (!worktreePath) return undefined;
  if (!MANAGED_WORKTREE_PATH_PATTERN.test(worktreePath)) return undefined;
  return worktreePath.replace(MANAGED_WORKTREE_PATH_PATTERN, '');
}
