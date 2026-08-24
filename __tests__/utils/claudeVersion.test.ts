import { describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_FULLSCREEN_MINIMUM_VERSION,
  ClaudeFullscreenVersionError,
  compareClaudeVersions,
  createClaudeVersionPreflight,
  parseClaudeVersion,
} from '../../src/utils/claudeVersion.js';

describe('Claude fullscreen version preflight', () => {
  it.each([
    ['2.1.220 (Claude Code)', [2, 1, 220]],
    ['claude 3.0.1', [3, 0, 1]],
    ['v2.1.224\n', [2, 1, 224]],
  ] as const)('parses %s', (output, expected) => {
    expect(parseClaudeVersion(output)).toEqual(expected);
  });

  it.each(['', 'Claude Code', '2.1', '2.1.x', '1.2.3.4'])('rejects malformed output %j', (output) => {
    expect(parseClaudeVersion(output)).toBeNull();
  });

  it('compares numeric tuples without lexicographic errors', () => {
    expect(compareClaudeVersions([2, 1, 220], CLAUDE_FULLSCREEN_MINIMUM_VERSION)).toBe(0);
    expect(compareClaudeVersions([2, 1, 99], CLAUDE_FULLSCREEN_MINIMUM_VERSION)).toBeLessThan(0);
    expect(compareClaudeVersions([2, 2, 0], CLAUDE_FULLSCREEN_MINIMUM_VERSION)).toBeGreaterThan(0);
  });

  it('accepts the product floor and caches by binary path plus mtime', async () => {
    const execVersion = vi.fn(async () => '2.1.220 (Claude Code)');
    const preflight = createClaudeVersionPreflight({
      execVersion,
      findCommand: vi.fn(async () => '/opt/bin/claude'),
      getMtimeMs: vi.fn(async () => 123),
    });

    await expect(preflight()).resolves.toMatchObject({
      command: '/opt/bin/claude',
      version: [2, 1, 220],
    });
    await expect(preflight()).resolves.toMatchObject({ version: [2, 1, 220] });
    expect(execVersion).toHaveBeenCalledTimes(1);
  });

  it('rechecks when the binary mtime changes', async () => {
    const execVersion = vi.fn()
      .mockResolvedValueOnce('2.1.220')
      .mockResolvedValueOnce('2.1.224');
    const getMtimeMs = vi.fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    const preflight = createClaudeVersionPreflight({
      execVersion,
      findCommand: vi.fn(async () => '/opt/bin/claude'),
      getMtimeMs,
    });

    await expect(preflight()).resolves.toMatchObject({ version: [2, 1, 220] });
    await expect(preflight()).resolves.toMatchObject({ version: [2, 1, 224] });
    expect(execVersion).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['missing binary', { findCommand: vi.fn(async () => null), getMtimeMs: vi.fn(), execVersion: vi.fn() }],
    ['malformed output', { findCommand: vi.fn(async () => '/bin/claude'), getMtimeMs: vi.fn(async () => 1), execVersion: vi.fn(async () => 'unknown') }],
    ['execution failure', { findCommand: vi.fn(async () => '/bin/claude'), getMtimeMs: vi.fn(async () => 1), execVersion: vi.fn(async () => { throw new Error('timeout'); }) }],
  ] as const)('fails actionably for %s', async (_label, dependencies) => {
    const preflight = createClaudeVersionPreflight(dependencies);

    const error = await preflight().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClaudeFullscreenVersionError);
    expect((error as Error).message).toContain('Update Claude');
    expect((error as Error).message).toContain('Use classic compatibility mode');
  });

  it('rejects an installed Claude below the Amux floor', async () => {
    const preflight = createClaudeVersionPreflight({
      execVersion: vi.fn(async () => '2.1.219'),
      findCommand: vi.fn(async () => '/bin/claude'),
      getMtimeMs: vi.fn(async () => 1),
    });

    await expect(preflight()).rejects.toThrow('2.1.220 or newer');
  });
});
