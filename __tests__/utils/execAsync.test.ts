import { execFile } from 'child_process';
import { homedir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  execFileAsync,
  getEnhancedPath,
  getEnhancedPathAsync,
  prependEnhancedPathDir,
  resetEnhancedPathCacheForTests,
} from '../../src/utils/execAsync';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

describe('getEnhancedPath', () => {
  const originalPath = process.env.PATH;
  const originalShell = process.env.SHELL;

  beforeEach(() => {
    resetEnhancedPathCacheForTests();
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    process.env.SHELL = originalShell;
    vi.mocked(execFile).mockReset();
    resetEnhancedPathCacheForTests();
  });

  it('returns a non-blocking fallback with common user agent install directories', () => {
    // Arrange
    process.env.PATH = '/usr/bin:/bin';
    process.env.SHELL = '/bin/zsh';
    const enhancedPath = getEnhancedPath();
    const pathParts = enhancedPath.split(':');

    expect(execFile).not.toHaveBeenCalled();
    expect(pathParts).toContain(`${homedir()}/.local/bin`);
    expect(pathParts).toContain(`${homedir()}/.nix-profile/bin`);
    expect(pathParts).toContain('/opt/local/bin');
  });

  it('resolves and caches the login-shell path without blocking the event loop', async () => {
    process.env.PATH = '/usr/bin:/bin';
    process.env.SHELL = '/bin/zsh';
    vi.mocked(execFile).mockImplementation(((_file, _args, _options, callback) => {
      callback(null, 'USER=test\nPATH=/async/bin:/usr/bin\n', '');
      return {};
    }) as typeof execFile);

    const enhancedPath = await getEnhancedPathAsync();

    expect(execFile).toHaveBeenCalledWith(
      '/bin/zsh',
      ['-ilc', 'command env'],
      expect.objectContaining({ encoding: 'utf-8', timeout: 1500 }),
      expect.any(Function),
    );
    expect(enhancedPath.split(':')[0]).toBe('/async/bin');
    expect(getEnhancedPath()).toBe(enhancedPath);
  });

  it('prepends a frozen provider bin dir into the cached enhanced path exactly once', async () => {
    // Arrange — warm the cache with a login-shell PATH that lacks the keg bin
    process.env.PATH = '/usr/bin:/bin';
    process.env.SHELL = '/bin/zsh';
    vi.mocked(execFile).mockImplementation(((_file, _args, _options, callback) => {
      callback(null, 'PATH=/usr/local/bin:/usr/bin\n', '');
      return {};
    }) as typeof execFile);
    await getEnhancedPathAsync();

    // Act — the tmux provider freeze prepends the resolved keg bin dir
    prependEnhancedPathDir('/opt/homebrew/opt/tmux/bin');
    prependEnhancedPathDir('/opt/homebrew/opt/tmux/bin');
    const enhancedPath = await getEnhancedPathAsync();

    // Assert — control-plane execAsync/execFileAsync now resolve the keg tmux
    const parts = enhancedPath.split(':');
    expect(parts[0]).toBe('/opt/homebrew/opt/tmux/bin');
    expect(parts.filter((dir) => dir === '/opt/homebrew/opt/tmux/bin')).toHaveLength(1);
  });

  it('uses a fallback synchronously while an async warmup is in flight', async () => {
    process.env.PATH = '/usr/bin:/bin';
    process.env.SHELL = '/bin/zsh';
    let completeWarmup: ((error: Error | null, stdout: string, stderr: string) => void) | undefined;
    vi.mocked(execFile).mockImplementation(((_file, _args, _options, callback) => {
      completeWarmup = callback;
      return {};
    }) as typeof execFile);

    const warmup = getEnhancedPathAsync();
    const fallback = getEnhancedPath();

    expect(fallback.split(':')[0]).toBe('/usr/bin');
    expect(execFile).toHaveBeenCalledOnce();
    completeWarmup?.(null, 'PATH=/warm/bin:/usr/bin\n', '');
    await expect(warmup).resolves.toMatch(/^\/warm\/bin:/);
  });

  it('passes argv literally with shell execution disabled', async () => {
    vi.mocked(execFile).mockImplementation(((file, _args, _options, callback) => {
      callback(null, file === '/bin/zsh' ? 'PATH=/usr/bin:/bin\n' : 'created\n', '');
      return {};
    }) as typeof execFile);

    const output = await execFileAsync(
      'git',
      ['worktree', 'add', '--', "/repo with spaces/owner's worktree", '-leading-ref'],
      { cwd: "/repo with spaces/owner's project", timeout: 60_000 },
    );

    expect(output).toBe('created');
    expect(execFile).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '--', "/repo with spaces/owner's worktree", '-leading-ref'],
      expect.objectContaining({
        cwd: "/repo with spaces/owner's project",
        shell: false,
        timeout: 60_000,
      }),
      expect.any(Function),
    );
  });
});
