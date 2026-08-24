/**
 * Worktree Discovery Utilities
 *
 * Scans a directory for nested git worktrees (including the root).
 * Used for multi-merge to find sub-worktrees created by hooks.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { basename, join, relative } from 'path';
import type { WorktreeInfo } from '../actions/merge/types.js';
import { LogService } from '../services/LogService.js';
import { execFileAsync } from './execAsync.js';
import { getCurrentBranchAsync } from './git.js';

const log = LogService.getInstance();

/**
 * Detect all git worktrees within a directory (recursively)
 *
 * @param rootWorktreePath - The root worktree path (aumx pane's worktree)
 * @returns Array of WorktreeInfo objects, ordered by depth (deepest first, root last)
 */
export async function detectAllWorktrees(rootWorktreePath: string): Promise<WorktreeInfo[]> {
  const worktrees: WorktreeInfo[] = [];

  // Add the root worktree first
  const rootInfo = await getWorktreeInfo(rootWorktreePath, rootWorktreePath, true);
  if (rootInfo) {
    worktrees.push(rootInfo);
  }

  // Recursively scan for sub-worktrees
  await scanForWorktrees(rootWorktreePath, rootWorktreePath, worktrees, 1);

  // Sort by depth descending (deepest first, root last)
  // This ensures sub-worktrees are merged before their parents
  worktrees.sort((a, b) => b.depth - a.depth);

  return worktrees;
}

/**
 * Recursively scan a directory for git worktrees
 */
async function scanForWorktrees(
  dirPath: string,
  rootWorktreePath: string,
  worktrees: WorktreeInfo[],
  depth: number
): Promise<void> {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      // Skip hidden directories (except we need to check for .git)
      if (entry.name.startsWith('.') && entry.name !== '.git') {
        continue;
      }

      // Skip node_modules and other common large directories
      if (entry.name === 'node_modules' || entry.name === 'vendor' || entry.name === '.pnpm') {
        continue;
      }

      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        // Check if this directory is a worktree (has .git file, not directory)
        const gitPath = join(fullPath, '.git');
        if (existsSync(gitPath)) {
          const gitStat = statSync(gitPath);

          if (gitStat.isFile()) {
            // This is a worktree (has .git file pointing to parent)
            const worktreeInfo = await getWorktreeInfo(fullPath, rootWorktreePath, false, depth);
            if (worktreeInfo) {
              worktrees.push(worktreeInfo);
            }
            // Continue scanning inside this worktree for nested worktrees
            await scanForWorktrees(fullPath, rootWorktreePath, worktrees, depth + 1);
          } else if (gitStat.isDirectory()) {
            // This is a full git repository, not a worktree
            // It could still contain worktrees inside it, but we skip the repo itself
            // (it's not a worktree of another repo)
            await scanForWorktrees(fullPath, rootWorktreePath, worktrees, depth + 1);
          }
        } else {
          // Regular directory, continue scanning
          await scanForWorktrees(fullPath, rootWorktreePath, worktrees, depth);
        }
      }
    }
  } catch (error) {
    log.warn(`Error scanning ${dirPath}: ${error}`, 'worktreeDiscovery');
  }
}

/**
 * Get detailed information about a worktree
 */
async function getWorktreeInfo(
  worktreePath: string,
  rootWorktreePath: string,
  isRoot: boolean,
  depth: number = 0
): Promise<WorktreeInfo | null> {
  try {
    // Get the parent repo path using git rev-parse
    const parentRepoPath = await getWorktreeParentPath(worktreePath);
    if (!parentRepoPath) {
      log.warn(`Could not determine parent for ${worktreePath}`, 'worktreeDiscovery');
      return null;
    }

    // Get repo name from parent path
    const repoName = getRepoName(parentRepoPath);

    // Get current branch in worktree
    const branch = await getCurrentBranchAsync(worktreePath);

    // Get main branch in parent repo
    const mainBranch = await getMainBranchForRepo(parentRepoPath);

    // Calculate relative path from root
    const relativePath = isRoot ? '.' : relative(rootWorktreePath, worktreePath);

    return {
      worktreePath,
      parentRepoPath,
      repoName,
      branch,
      mainBranch,
      isRoot,
      relativePath,
      depth,
    };
  } catch (error) {
    log.warn(`Error getting worktree info for ${worktreePath}: ${error}`, 'worktreeDiscovery');
    return null;
  }
}

/**
 * Get the parent repository path for a worktree
 *
 * Uses: git rev-parse --path-format=absolute --git-common-dir
 * Then removes ".git" suffix to get repo root
 */
async function getWorktreeParentPath(worktreePath: string): Promise<string | null> {
  try {
    // Get the common git directory (the parent repo's .git or .git/worktrees/...)
    const gitCommonDir = await execFileAsync('git', [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ], {
      cwd: worktreePath,
    });

    // The git-common-dir returns the .git directory path
    // Remove the ".git" suffix to get the repo root
    // Handle both "/path/to/repo/.git" and "/path/to/repo/.git/worktrees/name"
    let parentPath = gitCommonDir;

    // If it ends with .git, remove it
    if (parentPath.endsWith('.git')) {
      parentPath = parentPath.slice(0, -4); // Remove ".git"
      if (parentPath.endsWith('/')) {
        parentPath = parentPath.slice(0, -1); // Remove trailing slash
      }
    } else if (parentPath.includes('/.git/')) {
      // It's a path like /repo/.git/worktrees/name, extract the repo path
      parentPath = parentPath.split('/.git/')[0];
    }

    // Verify by getting the toplevel
    const topLevel = await execFileAsync('git', [
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
    ], {
      cwd: parentPath,
    });

    return topLevel;
  } catch (error) {
    log.warn(`Error getting parent path for ${worktreePath}: ${error}`, 'worktreeDiscovery');
    return null;
  }
}

/**
 * Get repository name from path (directory name)
 */
function getRepoName(repoPath: string): string {
  return basename(repoPath);
}

/**
 * Get main branch for a specific repo (running git commands in that repo's context)
 */
async function getMainBranchForRepo(repoPath: string): Promise<string> {
  try {
    // First try to get the default branch from origin
    const originHead = await execFileAsync('git', [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
    ], {
      cwd: repoPath,
    });

    if (originHead) {
      const match = originHead.match(/refs\/remotes\/origin\/(.+)/);
      if (match) {
        return match[1];
      }
    }
  } catch {
    log.debug(`origin/HEAD not set for ${repoPath}, trying branch names`, 'worktreeDiscovery');
  }

  try {
    await execFileAsync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/main'], {
      cwd: repoPath,
    });
    return 'main';
  } catch {
    log.debug(`'main' branch not found in ${repoPath}, trying 'master'`, 'worktreeDiscovery');
  }

  try {
    await execFileAsync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/master'], {
      cwd: repoPath,
    });
    return 'master';
  } catch {
    log.debug(`'master' branch not found in ${repoPath}, defaulting to 'main'`, 'worktreeDiscovery');
  }

  return 'main'; // Default fallback
}

/**
 * Generate a display label for a worktree
 * Format: "repo-name (branch)" or "repo-name (branch) - relative/path"
 */
export function getWorktreeDisplayLabel(worktree: WorktreeInfo): string {
  const baseLabel = `${worktree.repoName} (${worktree.branch})`;
  if (worktree.isRoot || worktree.relativePath === '.') {
    return baseLabel;
  }
  return `${baseLabel} - ${worktree.relativePath}`;
}
