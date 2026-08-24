import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { generateRecap } from '../../src/main/services/recapGenerator.js';

function makeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    stderr: EventEmitter;
    stdin: { end: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
  };
  proc.kill = vi.fn();
  proc.stderr = new EventEmitter();
  proc.stdin = { end: vi.fn(), write: vi.fn() };
  proc.stdout = new EventEmitter();
  return proc;
}

describe('generateRecap', () => {
  beforeEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    spawnMock.mockReset();
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('skips OpenRouter and uses a successful Claude CLI fallback when no key exists', async () => {
    const proc = makeProcess();
    spawnMock.mockReturnValue(proc);
    const promise = generateRecap(['[user] implement the feature']);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    proc.stdout.emit('data', 'CLI summary\n');
    proc.emit('close', 0);

    await expect(promise).resolves.toEqual({ summary: 'CLI summary' });
    expect(spawnMock).toHaveBeenCalledWith('claude', ['-p', '--max-turns', '1'], expect.anything());
  });

  it('falls through from a failed first OpenRouter model to the second model', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'router summary' } }],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateRecap(['[assistant] done'])).resolves.toEqual({
      summary: 'router summary',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('falls through empty and malformed OpenRouter content to the CLI fallback', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    const proc = makeProcess();
    spawnMock.mockReturnValue(proc);
    const promise = generateRecap(['[user] explain the failure']);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    proc.emit('error', new Error('claude unavailable'));

    await expect(promise).resolves.toEqual({
      summary: '',
      error: 'Failed to generate summary',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts timed-out OpenRouter calls and advances to the next fallback model', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const proc = makeProcess();
    spawnMock.mockReturnValue(proc);
    const promise = generateRecap(['[user] timeout test']);
    await vi.advanceTimersByTimeAsync(30_000);
    proc.emit('close', 1);

    await expect(promise).resolves.toEqual({
      summary: '',
      error: 'Failed to generate summary',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('normalizes CLI non-zero exits and spawn errors', async () => {
    const nonZero = makeProcess();
    spawnMock.mockReturnValueOnce(nonZero);
    const nonZeroPromise = generateRecap(['non-zero']);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    nonZero.stderr.emit('data', 'permission denied');
    nonZero.emit('close', 2);
    await expect(nonZeroPromise).resolves.toEqual({
      summary: '',
      error: 'Failed to generate summary',
    });

    const spawnError = makeProcess();
    spawnMock.mockReturnValueOnce(spawnError);
    const errorPromise = generateRecap(['spawn error']);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    spawnError.emit('error', new Error('not installed'));
    await expect(errorPromise).resolves.toEqual({
      summary: '',
      error: 'Failed to generate summary',
    });
  });

  it('kills a hung CLI and preserves the context truncation marker', async () => {
    vi.useFakeTimers();
    const proc = makeProcess();
    spawnMock.mockReturnValue(proc);
    const promise = generateRecap(['x'.repeat(20_000)]);
    await Promise.resolve();
    await Promise.resolve();
    const prompt = proc.stdin.write.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('...(truncated)');
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(promise).resolves.toEqual({
      summary: '',
      error: 'Failed to generate summary',
    });
    expect(proc.kill).toHaveBeenCalledOnce();
  });
});
