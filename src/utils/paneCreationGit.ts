import { execAsync, execAsyncWithStatus } from './execAsync.js';
import { shQuote } from './shellEscape.js';

interface GitWorktreeAddOptions {
  branchName: string;
  createBranch: boolean;
  startPoint?: string;
  worktreePath: string;
}

interface GitWorktreeShellOptions extends GitWorktreeAddOptions {
  projectRoot: string;
}

export function buildGitWorktreeAddArgs({
  branchName,
  createBranch,
  startPoint,
  worktreePath,
}: GitWorktreeAddOptions): string[] {
  const args = ['worktree', 'add'];
  if (createBranch) {
    args.push('-b', branchName);
  }
  args.push('--', worktreePath);
  if (startPoint) {
    args.push(startPoint);
  } else if (!createBranch) {
    args.push(branchName);
  }
  return args;
}

export function buildGitWorktreeShellCommand({
  projectRoot,
  ...worktreeOptions
}: GitWorktreeShellOptions): string {
  const args = buildGitWorktreeAddArgs(worktreeOptions);
  const createBranch = args[2] === '-b';
  const dynamicArgs = createBranch
    ? `-b ${shQuote(args[3])} -- ${args.slice(5).map(shQuote).join(' ')}`
    : `-- ${args.slice(3).map(shQuote).join(' ')}`;

  return `cd ${shQuote(projectRoot)} && git worktree add ${dynamicArgs} && cd ${shQuote(worktreeOptions.worktreePath)}`;
}

export function chooseAvailableSlug(
  baseSlug: string,
  hasConflict: (candidateSlug: string) => boolean,
): string {
  let candidate = baseSlug;
  let suffix = 2;
  while (hasConflict(candidate)) {
    candidate = `${baseSlug}-${suffix++}`;
  }
  return candidate;
}

export async function getCheckedOutWorktreeBranches(projectRoot: string): Promise<Set<string>> {
  const checkedOutBranches = new Set<string>();
  const output = await execAsync('git worktree list --porcelain', {
    cwd: projectRoot,
    silent: true,
    timeout: 5000,
  });

  if (!output) {
    return checkedOutBranches;
  }

  for (const line of output.split('\n')) {
    if (!line.startsWith('branch ')) continue;
    const ref = line.slice('branch '.length).trim();
    if (!ref) continue;
    if (ref.startsWith('refs/heads/')) {
      checkedOutBranches.add(ref.slice('refs/heads/'.length));
    } else {
      checkedOutBranches.add(ref);
    }
  }

  return checkedOutBranches;
}

export async function getAllLocalBranches(projectRoot: string): Promise<Set<string>> {
  const branches = new Set<string>();
  const output = await execAsync('git for-each-ref --format=%(refname:short) refs/heads', {
    cwd: projectRoot,
    silent: true,
    timeout: 5000,
  });

  if (!output) {
    return branches;
  }

  for (const line of output.split('\n')) {
    const name = line.trim();
    if (name) {
      branches.add(name);
    }
  }

  return branches;
}

export function isWorktreeCollisionError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('already exists')
    || normalized.includes('already checked out')
    || normalized.includes('already a worktree')
    || normalized.includes('already registered')
    || normalized.includes('cannot be used as a worktree');
}

export function shouldFallbackDirectWorktreeToTmuxShell(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('command not found')
    || normalized.includes('not recognized as an internal or external command')
    || normalized.includes('enoent')
    || normalized.includes('spawn');
}

export async function gitCommandSucceeds(
  command: string,
  cwd: string,
  timeout: number = 5000,
): Promise<boolean> {
  const result = await execAsyncWithStatus(command, { cwd, timeout });
  return result.exitCode === 0 && !result.timedOut;
}

export function buildGitRefVerifyArgs(refName: string): ['rev-parse', '--verify', string] {
  return ['rev-parse', '--verify', refName];
}

export function buildGitRefVerifyCommand(refName: string): string {
  return `git rev-parse --verify ${shQuote(refName)}`;
}
