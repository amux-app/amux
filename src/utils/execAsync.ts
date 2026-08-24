import {
  execFile,
  spawn,
  type ExecFileOptionsWithStringEncoding,
  type SpawnOptions,
} from 'child_process';
import { homedir } from 'os';

const DEFAULT_SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const SHELL_ENV_COMMAND = 'command env';
const FALLBACK_PATHS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/opt/local/bin',
  '/opt/local/sbin',
  `${homedir()}/.local/bin`,
  `${homedir()}/.nix-profile/bin`,
];

let cachedEnhancedPath: string | null = null;
let pendingEnhancedPath: Promise<string> | null = null;

function extractPathFromShellEnv(output: string): string | null {
  const pathLine = output.split(/\r?\n/).find((line) => line.startsWith('PATH='));
  const pathValue = pathLine?.slice('PATH='.length).trim();
  if (!pathValue) return null;
  if (!pathValue.includes(':') && /\s+\//.test(pathValue)) return null;

  const pathParts = pathValue.split(':').filter(Boolean);
  if (pathParts.length === 0) return null;
  if (!pathParts.some((part) => part.startsWith('/'))) return null;
  if (pathParts.some((part) => part.includes('\0') || part.includes('\n'))) return null;

  return pathParts.join(':');
}

function buildEnhancedPath(shellPath: string | null): string {
  const basePath = shellPath || process.env.PATH || DEFAULT_SYSTEM_PATH;
  const pathParts = basePath.split(':').filter(Boolean);
  return Array.from(new Set([...pathParts, ...FALLBACK_PATHS])).join(':');
}

export function getEnhancedPath(): string {
  if (cachedEnhancedPath) return cachedEnhancedPath;
  // Synchronous callers receive a safe fallback immediately. Login-shell
  // discovery is intentionally async so no caller can block Electron's main
  // thread while an in-flight warmup is still pending.
  return buildEnhancedPath(null);
}

export function getEnhancedPathAsync(): Promise<string> {
  if (cachedEnhancedPath) return Promise.resolve(cachedEnhancedPath);
  if (pendingEnhancedPath) return pendingEnhancedPath;

  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    cachedEnhancedPath = buildEnhancedPath(null);
    return Promise.resolve(cachedEnhancedPath);
  }

  const shell = process.env.SHELL || '/bin/zsh';
  pendingEnhancedPath = new Promise<string>((resolve) => {
    execFile(shell, ['-ilc', SHELL_ENV_COMMAND], {
      encoding: 'utf-8',
      timeout: 1500,
    }, (error, stdout) => {
      const shellPath = error ? null : extractPathFromShellEnv(stdout);
      cachedEnhancedPath = buildEnhancedPath(shellPath);
      resolve(cachedEnhancedPath);
    });
  }).finally(() => {
    pendingEnhancedPath = null;
  });
  return pendingEnhancedPath;
}

export function resetEnhancedPathCacheForTests(): void {
  cachedEnhancedPath = null;
  pendingEnhancedPath = null;
}

/**
 * Prepend a directory to the cached enhanced PATH so that child processes
 * launched through execAsync/execFileAsync resolve binaries from it. Kept in
 * sync with process.env.PATH by the tmux provider freeze so control-plane and
 * PTY commands agree on which tmux they run.
 */
export function prependEnhancedPathDir(dir: string): void {
  const current = cachedEnhancedPath ?? buildEnhancedPath(null);
  const parts = current.split(':').filter(Boolean);
  cachedEnhancedPath = parts.includes(dir) ? current : [dir, ...parts].join(':');
}

export interface ExecAsyncOptions extends Omit<SpawnOptions, 'stdio'> {
  /** Timeout in milliseconds. Default: 30000 (30s) */
  timeout?: number;
  /** If true, resolve with empty string on error instead of rejecting */
  silent?: boolean;
  /** Max bytes to buffer for stdout/stderr. Default: 10MB. Mirrors Node's child_process.exec. */
  maxBuffer?: number;
}

export interface ExecFileAsyncOptions extends Omit<
  ExecFileOptionsWithStringEncoding,
  'encoding' | 'maxBuffer' | 'shell' | 'timeout'
> {
  /** Timeout in milliseconds. Default: 30000 (30s) */
  timeout?: number;
  /** If true, resolve with empty string on error instead of rejecting */
  silent?: boolean;
  /** Max bytes to buffer for stdout/stderr. Default: 10MB. */
  maxBuffer?: number;
}

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
const MAX_BUFFER_EXCEEDED_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
const KILL_SIGNAL: NodeJS.Signals = 'SIGTERM';

class MaxBufferError extends Error {
  readonly code = MAX_BUFFER_EXCEEDED_CODE;
  constructor(stream: 'stdout' | 'stderr', maxBuffer: number, command: string) {
    super(`${stream} exceeded maxBuffer (${maxBuffer} bytes): ${command}`);
  }
}

class ExecFileError extends Error {
  readonly code?: string | number;
  constructor(message: string, code?: string | number) {
    super(message);
    this.code = code;
  }
}

interface BoundedBuffer {
  append(chunk: Buffer): boolean;
  toString(): string;
}

function createBoundedBuffer(maxBuffer: number): BoundedBuffer {
  const chunks: Buffer[] = [];
  let length = 0;
  return {
    append(chunk) {
      length += chunk.length;
      if (length > maxBuffer) return false;
      chunks.push(chunk);
      return true;
    },
    toString() {
      return Buffer.concat(chunks, length).toString('utf-8');
    },
  };
}

/**
 * Async wrapper around child_process.spawn that returns stdout as a string.
 * This is the non-blocking replacement for execSync.
 *
 * @param command - The command to execute (can include spaces)
 * @param options - Spawn options plus timeout and silent flags
 * @returns Promise resolving to trimmed stdout
 *
 * @example
 * // Basic usage
 * const output = await execAsync('tmux list-panes');
 *
 * @example
 * // With timeout
 * const output = await execAsync('git status', { timeout: 5000 });
 *
 * @example
 * // Silent mode (returns empty string on error)
 * const output = await execAsync('tmux has-session -t foo', { silent: true });
 */
export async function execAsync(
  command: string,
  options: ExecAsyncOptions = {}
): Promise<string> {
  const { timeout = 30000, silent = false, maxBuffer = DEFAULT_MAX_BUFFER, env, ...spawnOptions } = options;
  const enhancedPath = await getEnhancedPathAsync();

  return new Promise((resolve, reject) => {
    const proc = spawn(command, [], {
      shell: true,
      ...spawnOptions,
      env: { ...process.env, ...env, PATH: enhancedPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout = createBoundedBuffer(maxBuffer);
    const stderr = createBoundedBuffer(maxBuffer);
    let timedOut = false;
    let exceededError: MaxBufferError | null = null;
    let timeoutId: NodeJS.Timeout | undefined;

    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill(KILL_SIGNAL);
      }, timeout);
    }

    proc.stdout?.on('data', (data: Buffer) => {
      if (!stdout.append(data) && !exceededError) {
        exceededError = new MaxBufferError('stdout', maxBuffer, command);
        proc.kill(KILL_SIGNAL);
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      if (!stderr.append(data) && !exceededError) {
        exceededError = new MaxBufferError('stderr', maxBuffer, command);
        proc.kill(KILL_SIGNAL);
      }
    });

    proc.on('error', (error: Error) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (silent) {
        resolve('');
      } else {
        reject(error);
      }
    });

    proc.on('close', (code: number | null) => {
      if (timeoutId) clearTimeout(timeoutId);

      if (exceededError) {
        if (silent) {
          resolve('');
        } else {
          reject(exceededError);
        }
        return;
      }

      if (timedOut) {
        if (silent) {
          resolve('');
        } else {
          reject(new Error(`Command timed out after ${timeout}ms: ${command}`));
        }
        return;
      }

      if (code === 0) {
        resolve(stdout.toString().trim());
      } else {
        if (silent) {
          resolve('');
        } else {
          const errorMessage = stderr.toString().trim() || `Command failed with exit code ${code}`;
          reject(new Error(errorMessage));
        }
      }
    });
  });
}

/**
 * Execute a binary directly with an argument array. Unlike execAsync, this
 * function never invokes a shell, so each argument remains literal data.
 */
export async function execFileAsync(
  command: string,
  args: readonly string[],
  options: ExecFileAsyncOptions = {},
): Promise<string> {
  const {
    timeout = 30000,
    silent = false,
    maxBuffer = DEFAULT_MAX_BUFFER,
    env,
    ...execFileOptions
  } = options;
  const enhancedPath = await getEnhancedPathAsync();

  return new Promise((resolve, reject) => {
    execFile(command, [...args], {
      ...execFileOptions,
      encoding: 'utf8',
      env: { ...process.env, ...env, PATH: enhancedPath },
      maxBuffer,
      shell: false,
      timeout,
    }, (error, stdout, stderr) => {
      if (error) {
        if (silent) {
          resolve('');
          return;
        }
        reject(new ExecFileError(stderr.trim() || error.message, error.code ?? undefined));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export interface ExecAsyncResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Like execAsync but never throws. Returns structured result with exit code.
 * Use this for check-style operations where you need to inspect the outcome
 * rather than treat non-zero exit as an error.
 */
export async function execAsyncWithStatus(
  command: string,
  options: Omit<ExecAsyncOptions, 'silent'> = {}
): Promise<ExecAsyncResult> {
  const { timeout = 30000, maxBuffer = DEFAULT_MAX_BUFFER, env, ...spawnOptions } = options;
  const enhancedPath = await getEnhancedPathAsync();

  return new Promise((resolve) => {
    const proc = spawn(command, [], {
      shell: true,
      ...spawnOptions,
      env: { ...process.env, ...env, PATH: enhancedPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout = createBoundedBuffer(maxBuffer);
    const stderr = createBoundedBuffer(maxBuffer);
    let timedOut = false;
    let exceededStream: 'stdout' | 'stderr' | null = null;
    let timeoutId: NodeJS.Timeout | undefined;

    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill(KILL_SIGNAL);
      }, timeout);
    }

    proc.stdout?.on('data', (data: Buffer) => {
      if (!stdout.append(data) && !exceededStream) {
        exceededStream = 'stdout';
        proc.kill(KILL_SIGNAL);
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      if (!stderr.append(data) && !exceededStream) {
        exceededStream = 'stderr';
        proc.kill(KILL_SIGNAL);
      }
    });

    proc.on('error', () => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({ stdout: stdout.toString().trim(), stderr: stderr.toString().trim(), exitCode: null, timedOut });
    });

    proc.on('close', (code: number | null) => {
      if (timeoutId) clearTimeout(timeoutId);
      const stderrText = exceededStream
        ? `${stderr.toString().trim()}\n[${exceededStream} exceeded maxBuffer ${maxBuffer} bytes]`.trim()
        : stderr.toString().trim();
      resolve({
        stdout: stdout.toString().trim(),
        stderr: stderrText,
        exitCode: timedOut || exceededStream ? null : code,
        timedOut,
      });
    });
  });
}

/**
 * Race multiple equivalent commands, returning the first successful result.
 * Useful for API fallbacks or trying multiple approaches.
 *
 * @param commands - Array of commands to race
 * @param options - Options applied to all commands
 * @returns First successful stdout
 * @throws If all commands fail
 *
 * @example
 * // Try multiple git commands, use first that succeeds
 * const branch = await execAsyncRace([
 *   'git symbolic-ref refs/remotes/origin/HEAD',
 *   'git show-ref --verify refs/heads/main',
 *   'git branch --show-current'
 * ], { silent: false });
 */
export async function execAsyncRace(
  commands: string[],
  options: Omit<ExecAsyncOptions, 'silent'> = {}
): Promise<string> {
  // Use Promise.any to get first success
  // Each command must NOT be silent so failures actually reject
  return Promise.any(
    commands.map(cmd => execAsync(cmd, { ...options, silent: false }))
  );
}
