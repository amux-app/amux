import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listCodexSessions } from '../../src/main/services/agent-session/CodexSessionLister';

// The lister resolves ~/.codex at import time, so the fake home must exist before it.
const homeDir = vi.hoisted(() => `/tmp/aumx-codex-lister-${process.pid}`);

vi.mock('os', () => ({
  homedir: () => homeDir,
}));

const codexDir = join(homeDir, '.codex');

function writeIndex(entries: Array<{ id: string; name: string; updated: string }>): void {
  writeFileSync(
    join(codexDir, 'session_index.jsonl'),
    entries
      .map((e) => JSON.stringify({ id: e.id, thread_name: e.name, updated_at: e.updated }))
      .join('\n'),
  );
}

beforeEach(() => {
  mkdirSync(codexDir, { recursive: true });
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe('listCodexSessions', () => {
  it('returns the newest sessions first and reports the full count when limited', () => {
    // Arrange
    writeIndex([
      { id: 'oldest', name: 'Oldest', updated: '2026-07-01T00:00:00.000Z' },
      { id: 'newest', name: 'Newest', updated: '2026-07-03T00:00:00.000Z' },
      { id: 'middle', name: 'Middle', updated: '2026-07-02T00:00:00.000Z' },
    ]);

    // Act
    const limited = listCodexSessions(2);
    const everything = listCodexSessions();

    // Assert
    expect(limited.sessions.map((s) => s.id)).toEqual(['newest', 'middle']);
    expect(limited.total).toBe(3);
    expect(everything.sessions.map((s) => s.id)).toEqual(['newest', 'middle', 'oldest']);
    expect(everything.total).toBe(3);
  });

  it('returns an empty listing when no session index exists', () => {
    // Arrange
    rmSync(codexDir, { recursive: true, force: true });

    // Act + Assert
    expect(listCodexSessions()).toEqual({ sessions: [], total: 0 });
  });
});
