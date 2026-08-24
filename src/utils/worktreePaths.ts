import { existsSync } from 'node:fs';
import path from 'path';

const AMUX_METADATA_DIR_NAME = '.amux';
const LEGACY_AUMX_METADATA_DIR_NAME = '.aumx';
const AMUX_HOOKS_DIR_NAME = '.amux-hooks';
const LEGACY_AUMX_HOOKS_DIR_NAME = '.aumx-hooks';
const AUMX_WORKTREES_DIR_NAME = 'worktrees';
const AUMX_CONFIG_FILE_NAME = 'aumx.config.json';
export const AUMX_GITIGNORE_ENTRY = `${AMUX_METADATA_DIR_NAME}/`;

const MANAGED_WORKTREE_PATH_PATTERN = /[\\\/]\.(?:amux|aumx)[\\\/]worktrees[\\\/][^\\\/]+[\\\/]?$/;

/**
 * Resolves project-local metadata without splitting an existing installation.
 * New projects use the correctly branded .amux directory; legacy projects keep
 * using .aumx until an explicit migration is introduced.
 */
export function getProjectMetadataDir(projectRoot: string): string {
  const currentDir = path.join(projectRoot, AMUX_METADATA_DIR_NAME);
  const legacyDir = path.join(projectRoot, LEGACY_AUMX_METADATA_DIR_NAME);

  if (existsSync(path.join(currentDir, AUMX_CONFIG_FILE_NAME))) return currentDir;
  if (existsSync(path.join(legacyDir, AUMX_CONFIG_FILE_NAME))) return legacyDir;
  if (existsSync(currentDir)) return currentDir;

  return existsSync(legacyDir) ? legacyDir : currentDir;
}

export function getProjectConfigPath(projectRoot: string): string {
  return path.join(getProjectMetadataDir(projectRoot), AUMX_CONFIG_FILE_NAME);
}

export function getProjectMetadataPath(projectRoot: string, ...segments: string[]): string {
  return path.join(getProjectMetadataDir(projectRoot), ...segments);
}

export function getProjectMetadataGitignoreEntry(projectRoot: string): string {
  return `${path.basename(getProjectMetadataDir(projectRoot))}/`;
}

export function getProjectHooksDir(projectRoot: string): string {
  const currentDir = path.join(projectRoot, AMUX_HOOKS_DIR_NAME);
  if (existsSync(currentDir)) return currentDir;

  const legacyDir = path.join(projectRoot, LEGACY_AUMX_HOOKS_DIR_NAME);
  if (existsSync(legacyDir)) return legacyDir;

  return path.basename(getProjectMetadataDir(projectRoot)) === LEGACY_AUMX_METADATA_DIR_NAME
    ? legacyDir
    : currentDir;
}

export function getProjectHooksGitignoreEntry(projectRoot: string): string {
  return `${path.basename(getProjectHooksDir(projectRoot))}/`;
}

export function getManagedWorktreesDir(projectRoot: string): string {
  return path.join(getProjectMetadataDir(projectRoot), AUMX_WORKTREES_DIR_NAME);
}

export function getManagedWorktreePath(projectRoot: string, slug: string): string {
  return path.join(getManagedWorktreesDir(projectRoot), slug);
}

export function deriveProjectRootFromManagedWorktreePath(worktreePath?: string): string | undefined {
  if (!worktreePath) return undefined;
  if (!MANAGED_WORKTREE_PATH_PATTERN.test(worktreePath)) return undefined;
  return worktreePath.replace(MANAGED_WORKTREE_PATH_PATTERN, '');
}
