import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({ spawn: spawnMock }));
vi.mock('../src/utils/execAsync.js', () => ({
  getEnhancedPathAsync: vi.fn(async () => '/test/bin'),
}));

import { callClaudeCode } from '../src/utils/aiCli.js';

function mockClaudeProcess(code: number | null, output: string) {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stdin = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn> };
  const stdinEnd = vi.fn((_prompt: string) => {
    queueMicrotask(() => {
      stdout.end(output);
      child.emit('close', code);
    });
  });
  stdin.end = stdinEnd;
  const kill = vi.fn();
  Object.assign(child, { kill, stdin, stdout });
  spawnMock.mockReturnValue(child);
  return { child, kill, stdin, stdinEnd, stdout };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('callClaudeCode', () => {
  it('invokes claude with the correct flags and sends the prompt via stdin', async () => {
    const process = mockClaudeProcess(0, 'Fix the auth bug\n');

    await expect(callClaudeCode('fix the auth bug')).resolves.toBe('Fix the auth bug');

    expect(spawnMock).toHaveBeenCalledWith(
      'claude',
      ['-p', '--max-turns', '1', '--no-session-persistence'],
      expect.objectContaining({
        env: expect.objectContaining({ PATH: '/test/bin' }),
        stdio: ['pipe', 'pipe', 'ignore'],
      }),
    );
    expect(process.stdinEnd).toHaveBeenCalledWith('fix the auth bug');
  });

  it('returns null on a nonzero exit code', async () => {
    mockClaudeProcess(1, 'error: unknown option');

    await expect(callClaudeCode('some prompt')).resolves.toBeNull();
  });

  it('returns null when stdout is empty', async () => {
    mockClaudeProcess(null, '');

    await expect(callClaudeCode('some prompt')).resolves.toBeNull();
  });

  it('returns trimmed text on success', async () => {
    mockClaudeProcess(0, '  Refactor auth layer  \n');

    await expect(callClaudeCode('some prompt')).resolves.toBe('Refactor auth layer');
  });

  it('terminates Claude when output exceeds the bounded response buffer', async () => {
    const process = mockClaudeProcess(0, 'x'.repeat(1024 * 1024 + 1));

    await expect(callClaudeCode('some prompt')).resolves.toBeNull();
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('returns null when Claude closes before consuming stdin', async () => {
    const process = mockClaudeProcess(0, '');
    process.stdinEnd.mockImplementationOnce(() => {
      queueMicrotask(() => process.stdin.emit('error', new Error('write EPIPE')));
    });

    await expect(callClaudeCode('x'.repeat(1024 * 1024))).resolves.toBeNull();
  });
});
