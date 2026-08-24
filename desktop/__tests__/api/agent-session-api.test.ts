import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyMetrics } from '../../src/shared/agent-session-types';
import { getSession, searchSessions } from '../../src/renderer/api/agent-session.api';
import { IPC } from '../../src/shared/ipc-channels';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/api/ipc.js', () => ({ invoke: invokeMock }));

const session = {
  agent: 'codex',
  compactionEvents: [],
  isOngoing: false,
  messages: [],
  metrics: createEmptyMetrics(),
  sessionId: 'session-1',
  subagents: [],
};

describe('agent session API response validation', () => {
  beforeEach(() => invokeMock.mockReset());

  it('returns null for absent sessions and validates present sessions', async () => {
    invokeMock.mockResolvedValueOnce({ session: null });
    await expect(getSession('pane-1')).resolves.toBeNull();

    invokeMock.mockResolvedValueOnce({ session });
    await expect(getSession('pane-1')).resolves.toEqual(session);
    expect(invokeMock).toHaveBeenLastCalledWith(IPC.AGENT_SESSION_GET, {
      paneId: 'pane-1',
    });
  });

  it('drops malformed search results and uses a safe fallback for invalid payloads', async () => {
    invokeMock.mockResolvedValueOnce([
      {
        messageId: 'm1',
        messageType: 'assistant',
        paneId: 'pane-1',
        paneSlug: 'task',
        snippet: 'found',
      },
      { paneId: 42 },
    ]);
    await expect(searchSessions('found')).resolves.toHaveLength(1);

    invokeMock.mockResolvedValueOnce({ results: [] });
    await expect(searchSessions('found')).resolves.toEqual([]);
  });

  it('returns null instead of exposing malformed session objects', async () => {
    invokeMock.mockResolvedValue({
      session: { agent: 'codex', sessionId: 'missing-fields' },
    });
    await expect(getSession('pane-1')).resolves.toBeNull();
  });
});
