import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const homeState = vi.hoisted(() => ({ value: '' }));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => homeState.value };
});

async function importPreview() {
  vi.resetModules();
  return (await import('../../src/main/services/agent-session/CodexRolloutPreview.js')).extractCodexRolloutPreview;
}

function dateDir(root: string, timestamp: number): string {
  const date = new Date(timestamp);
  return join(
    root,
    '.codex',
    'sessions',
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  );
}

describe('extractCodexRolloutPreview', () => {
  let home = '';
  const updatedAt = new Date('2026-08-24T12:00:00Z').getTime();

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'aumx-codex-rollout-'));
    homeState.value = home;
  });

  afterEach(async () => {
    await rm(home, { force: true, recursive: true });
  });

  async function writeRollout(lines: string[], timestamp = updatedAt) {
    const directory = dateDir(home, timestamp);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `rollout-session-abc.jsonl`), lines.join('\n'));
  }

  it('returns null when the matching rollout file is absent', async () => {
    const extract = await importPreview();
    expect(extract('abc', updatedAt)).toBeNull();
  });

  it('skips corrupt lines and prefers a real user message over a goal fallback', async () => {
    await writeRollout([
      '{bad-json',
      JSON.stringify({
        payload: {
          goal: { objective: 'fallback objective' },
          type: 'thread_goal_updated',
        },
        type: 'event_msg',
      }),
      JSON.stringify({
        payload: { message: '  real typed request  ', type: 'user_message' },
        type: 'event_msg',
      }),
    ]);
    const extract = await importPreview();
    expect(extract('abc', updatedAt)).toBe('real typed request');
  });

  it('returns the first non-empty goal when no user message exists', async () => {
    await writeRollout([
      JSON.stringify({
        payload: { message: '   ', type: 'user_message' },
        type: 'event_msg',
      }),
      JSON.stringify({
        payload: {
          goal: { objective: 'ship the fix' },
          type: 'thread_goal_updated',
        },
        type: 'event_msg',
      }),
    ]);
    const extract = await importPreview();
    expect(extract('abc', updatedAt)).toBe('ship the fix');
  });

  it('scans at most the first 500 lines', async () => {
    const lines = Array.from({ length: 500 }, () => JSON.stringify({ type: 'response_item' }));
    lines.push(
      JSON.stringify({
        payload: { message: 'too late', type: 'user_message' },
        type: 'event_msg',
      }),
    );
    await writeRollout(lines);
    const extract = await importPreview();
    expect(extract('abc', updatedAt)).toBeNull();
  });

  it('considers adjacent date directories around the persisted update time', async () => {
    await writeRollout(
      [
        JSON.stringify({
          payload: { message: 'previous day request', type: 'user_message' },
          type: 'event_msg',
        }),
      ],
      updatedAt - 86_400_000,
    );
    const extract = await importPreview();
    expect(extract('abc', updatedAt)).toBe('previous day request');
  });
});
