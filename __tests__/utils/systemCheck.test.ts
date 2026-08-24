import { execFile, type ExecFileException } from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAvailableAgents } from '../../src/utils/agentDetection.js';
import {
  validateRequiredSystemRequirements,
  validateSystemRequirements,
} from '../../src/utils/systemCheck.js';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('../../src/utils/agentDetection.js', () => ({
  getAvailableAgents: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);
const mockGetAvailableAgents = vi.mocked(getAvailableAgents);

interface Environment {
  tmuxClient?: string;
  gitVersion?: string;
  server?: { version?: string; error?: { message: string; stderr?: string } };
}

function noServerError(): { message: string; stderr: string } {
  return {
    message: 'error connecting to /private/tmp/tmux-501/default (No such file or directory)',
    stderr: 'error connecting to /private/tmp/tmux-501/default (No such file or directory)',
  };
}

function mockEnvironment(env: Environment): void {
  const tmuxClient = env.tmuxClient ?? 'tmux 3.7b';
  const gitVersion = env.gitVersion ?? 'git version 2.40.0';
  const server = env.server ?? { error: noServerError() };

  mockExecFile.mockImplementation(((command, args, _options, callback) => {
    const argv = args as string[];
    if (command === 'tmux' && argv.includes('-V')) {
      callback(null, tmuxClient, '');
      return;
    }
    if (command === 'tmux' && argv.includes('display-message')) {
      if (server.error) {
        callback({ message: server.error.message } as ExecFileException, '', server.error.stderr ?? '');
      } else {
        callback(null, server.version ?? '', '');
      }
      return;
    }
    if (command === 'git') {
      callback(null, gitVersion, '');
      return;
    }
    throw new Error(`Unexpected command: ${String(command)} ${argv.join(' ')}`);
  }) as typeof execFile);
}

describe('validateSystemRequirements', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    mockGetAvailableAgents.mockReset();
    mockGetAvailableAgents.mockResolvedValue(['codex']);
  });

  it('accepts the exact minimum client with no running server', async () => {
    // Arrange
    mockEnvironment({ tmuxClient: 'tmux 3.7b' });

    // Act
    const result = await validateSystemRequirements();

    // Assert
    expect(result.canRun).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('validates required startup dependencies without waiting for optional agent discovery', async () => {
    mockEnvironment({ tmuxClient: 'tmux 3.7b' });
    mockGetAvailableAgents.mockReturnValue(new Promise(() => {}));

    const result = await validateRequiredSystemRequirements();

    expect(result).toEqual({ canRun: true, errors: [] });
    expect(mockGetAvailableAgents).not.toHaveBeenCalled();
  });

  it('rejects 3.7a as below the minimum and preserves the suffix in guidance', async () => {
    // Arrange
    mockEnvironment({ tmuxClient: 'tmux 3.7a' });

    // Act
    const result = await validateSystemRequirements();

    // Assert
    expect(result.canRun).toBe(false);
    expect(result.errors).toContain("tmux 3.7a is below Amux's minimum 3.7b. Run: brew upgrade tmux");
  });

  it('accepts a newer stable client', async () => {
    // Arrange
    mockEnvironment({ tmuxClient: 'tmux 3.8', server: { version: '3.8' } });

    // Act
    const result = await validateSystemRequirements();

    // Assert
    expect(result.canRun).toBe(true);
  });

  it('reports an install command when tmux is missing', async () => {
    // Arrange
    mockExecFile.mockImplementation(((command, _args, _options, callback) => {
      if (command === 'tmux') {
        callback({ message: 'spawn tmux ENOENT', code: 'ENOENT' } as ExecFileException, '', '');
        return;
      }
      callback(null, 'git version 2.40.0', '');
    }) as typeof execFile);

    // Act
    const result = await validateSystemRequirements();

    // Assert
    expect(result.canRun).toBe(false);
    expect(result.errors).toContain('tmux is required. Install it with: brew install tmux');
  });

  it('reports a timed-out Git probe as transient instead of claiming Git is missing', async () => {
    mockExecFile.mockImplementation(((command, args, _options, callback) => {
      const argv = args as string[];
      if (command === 'tmux' && argv.includes('-V')) {
        callback(null, 'tmux 3.7b', '');
        return;
      }
      if (command === 'tmux') {
        callback({ message: 'No such file or directory' } as ExecFileException, '', 'no server running');
        return;
      }
      callback(Object.assign(new Error('Command failed'), {
        killed: true,
        signal: 'SIGTERM',
      }) as ExecFileException, '', '');
    }) as typeof execFile);

    const result = await validateSystemRequirements();

    expect(result.canRun).toBe(false);
    expect(result.errors).toContain('Amux could not verify Git because the version check timed out. Retry startup.');
    expect(result.errors).not.toContain('git is not installed or not in PATH');
  });

  it('fails closed on an unparseable client version', async () => {
    // Arrange
    mockEnvironment({ tmuxClient: 'tmux next-master' });

    // Act
    const result = await validateSystemRequirements();

    // Assert
    expect(result.canRun).toBe(false);
    expect(result.errors.some((e) => e.includes('could not verify tmux version'))).toBe(true);
  });

  it('blocks a new client against an old running server without proposing a kill', async () => {
    // Arrange
    mockEnvironment({ tmuxClient: 'tmux 3.7b', server: { version: '3.6a' } });

    // Act
    const result = await validateSystemRequirements();

    // Assert
    expect(result.canRun).toBe(false);
    const message = result.errors.find((e) => e.includes('running server is 3.6a'));
    expect(message).toBeDefined();
    expect(message).toContain('restart tmux completely');
    expect(result.errors.join(' ')).not.toMatch(/kill-server/);
  });

  it('accepts a supported client with a supported running server', async () => {
    // Arrange
    mockEnvironment({ tmuxClient: 'tmux 3.7b', server: { version: '3.7b' } });

    // Act
    const result = await validateSystemRequirements();

    // Assert
    expect(result.canRun).toBe(true);
  });

  it('treats a "no server" probe failure as valid', async () => {
    // Arrange
    mockEnvironment({ tmuxClient: 'tmux 3.7b', server: { error: noServerError() } });

    // Act
    const result = await validateSystemRequirements();

    // Assert
    expect(result.canRun).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('blocks when the server probe fails for a non-absence reason', async () => {
    // Arrange
    mockEnvironment({
      tmuxClient: 'tmux 3.7b',
      server: { error: { message: 'protocol version mismatch', stderr: 'protocol version mismatch' } },
    });

    // Act
    const result = await validateSystemRequirements();

    // Assert
    expect(result.canRun).toBe(false);
    expect(result.errors.some((e) => e.includes('could not verify the running tmux server'))).toBe(true);
  });

  it('does not mistake a socket permission failure for an absent server', async () => {
    // Arrange
    mockEnvironment({
      tmuxClient: 'tmux 3.7b',
      server: {
        error: {
          message: 'error connecting to /private/tmp/tmux-501/default (Permission denied)',
          stderr: 'error connecting to /private/tmp/tmux-501/default (Permission denied)',
        },
      },
    });

    // Act
    const result = await validateSystemRequirements();

    // Assert
    expect(result.canRun).toBe(false);
    expect(result.errors.some((e) => e.includes('could not verify the running tmux server'))).toBe(true);
  });

  it('does not probe the server when the client is already unsupported', async () => {
    // Arrange
    let serverProbed = false;
    mockExecFile.mockImplementation(((command, args, _options, callback) => {
      const argv = args as string[];
      if (command === 'tmux' && argv.includes('-V')) {
        callback(null, 'tmux 3.6a', '');
        return;
      }
      if (command === 'tmux' && argv.includes('display-message')) {
        serverProbed = true;
        callback(null, '3.6a', '');
        return;
      }
      callback(null, 'git version 2.40.0', '');
    }) as typeof execFile);

    // Act
    await validateSystemRequirements();

    // Assert
    expect(serverProbed).toBe(false);
  });

  it('starts client, git, and agent probes concurrently before the sequential server probe', async () => {
    // Arrange
    const callbacks = new Map<string, (
      error: ExecFileException | null,
      stdout: string,
      stderr: string,
    ) => void>();
    mockExecFile.mockImplementation(((command, args, _options, callback) => {
      const argv = args as string[];
      const key = command === 'tmux' && argv.includes('-V') ? 'tmux-V'
        : command === 'tmux' ? 'tmux-server'
        : 'git';
      callbacks.set(key, callback);
    }) as typeof execFile);
    let resolveAgents: ((agents: ['codex']) => void) | undefined;
    mockGetAvailableAgents.mockReturnValue(new Promise((resolve) => {
      resolveAgents = resolve;
    }));

    // Act
    const validation = validateSystemRequirements();
    await Promise.resolve();

    // Assert — client, git, and agents run together; server is not probed yet
    expect(callbacks.has('tmux-V')).toBe(true);
    expect(callbacks.has('git')).toBe(true);
    expect(callbacks.has('tmux-server')).toBe(false);
    expect(mockGetAvailableAgents).toHaveBeenCalledOnce();

    callbacks.get('tmux-V')?.(null, 'tmux 3.7b', '');
    callbacks.get('git')?.(null, 'git version 2.40.0', '');
    resolveAgents?.(['codex']);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // The server probe is dispatched only after the client is confirmed supported
    expect(callbacks.has('tmux-server')).toBe(true);
    callbacks.get('tmux-server')?.(
      { message: 'error connecting (No such file or directory)' } as ExecFileException,
      '',
      'error connecting (No such file or directory)',
    );
    await expect(validation).resolves.toMatchObject({ canRun: true });
  });
});
