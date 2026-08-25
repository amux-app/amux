import { execAsync } from 'muxbase/core';

interface EnsureGitRepositoryOptions {
  initIfMissing: boolean;
}

export interface EnsureGitRepositoryResult {
  initialized: boolean;
  isReady: boolean;
}

function quoteShellPath(path: string): string {
  return `'${path.replace(/'/g, `'\"'\"'`)}'`;
}

async function runGitCommand(command: string): Promise<string> {
  return execAsync(command, { silent: true });
}

async function runGitBoolean(command: string): Promise<boolean> {
  const output = await runGitCommand(`${command} >/dev/null 2>&1 && printf true || printf false`);
  return output.trim() === 'true';
}

async function isGitRepository(projectRoot: string): Promise<boolean> {
  return runGitBoolean(`git -C ${quoteShellPath(projectRoot)} rev-parse --is-inside-work-tree`);
}

async function initializeGitRepository(projectRoot: string): Promise<boolean> {
  return runGitBoolean(`git -C ${quoteShellPath(projectRoot)} init -q`);
}

export async function ensureGitRepository(
  projectRoot: string,
  options: EnsureGitRepositoryOptions,
): Promise<EnsureGitRepositoryResult> {
  const existingRepository = await isGitRepository(projectRoot);
  if (existingRepository) {
    return { initialized: false, isReady: true };
  }

  if (!options.initIfMissing) {
    return { initialized: false, isReady: false };
  }

  const initialized = await initializeGitRepository(projectRoot);
  return {
    initialized,
    isReady: initialized,
  };
}
