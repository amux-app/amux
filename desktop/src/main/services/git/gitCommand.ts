import { execFileAsync, type ExecFileAsyncOptions } from 'muxbase/core';

const GIT_BIN = 'git';

function gitArgv(worktreePath: string, args: readonly string[]): string[] {
  return ['-C', worktreePath, ...args];
}

export async function git(worktreePath: string, args: readonly string[]): Promise<string> {
  return execFileAsync(GIT_BIN, gitArgv(worktreePath, args), { silent: true });
}

export async function gitOrThrow(
  worktreePath: string,
  args: readonly string[],
  options: Omit<ExecFileAsyncOptions, 'silent'> = {},
): Promise<string> {
  return execFileAsync(GIT_BIN, gitArgv(worktreePath, args), { ...options, silent: false });
}

export async function safeGit(
  worktreePath: string,
  args: readonly string[],
  fallback: string | null = null,
): Promise<string | null> {
  try {
    return await git(worktreePath, args);
  } catch {
    return fallback;
  }
}

/**
 * Shell-quote a value for commands that are rendered as display strings only.
 * Executed git commands go through the argv helpers above and need no quoting.
 */
export function sh(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}
