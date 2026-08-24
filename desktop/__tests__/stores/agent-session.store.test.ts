import { describe, it, expect, beforeEach } from 'vitest';
import { useAgentSessionStore } from '../../src/renderer/stores/agent-session.store';
import type { NormalizedSession } from '../../src/shared/agent-session-types';
import { createEmptySession } from '../../src/shared/agent-session-types';

function makeSession(agent: 'claude' | 'codex' = 'claude', id = 'sess-1'): NormalizedSession {
  const session = createEmptySession(agent, id);
  session.metrics.totalTokens = 1000;
  session.metrics.messageCount = 2;
  session.lastUpdateTime = 1_000;
  return session;
}

describe('useAgentSessionStore', () => {
  beforeEach(() => {
    useAgentSessionStore.setState({ sessions: {} });
  });

  describe('default state', () => {
    it('has empty sessions record', () => {
      const { sessions } = useAgentSessionStore.getState();
      expect(Object.keys(sessions).length).toBe(0);
    });
  });

  describe('updateSession', () => {
    it('adds a new session', () => {
      const session = makeSession();
      const accepted = useAgentSessionStore.getState().updateSession('pane-1', session);

      const stored = useAgentSessionStore.getState().sessions['pane-1'];
      expect(accepted).toBe(true);
      expect(stored).toBeDefined();
      expect(stored!.agent).toBe('claude');
      expect(stored!.metrics.totalTokens).toBe(1000);
    });

    it('replaces an existing session', () => {
      const session1 = makeSession('claude', 'sess-1');
      const session2 = makeSession('codex', 'sess-2');
      session2.metrics.totalTokens = 5000;

      useAgentSessionStore.getState().updateSession('pane-1', session1);
      useAgentSessionStore.getState().updateSession('pane-1', session2);

      const stored = useAgentSessionStore.getState().sessions['pane-1'];
      expect(stored!.agent).toBe('codex');
      expect(stored!.metrics.totalTokens).toBe(5000);
    });

    it('rejects stale snapshots for the same session', () => {
      const newer = makeSession('claude', 'sess-1');
      newer.messages = [
        { id: 'm1', type: 'user', content: 'hi', toolCalls: [], toolResults: [], timestamp: 1_000 },
        { id: 'm2', type: 'assistant', content: 'hello', toolCalls: [], toolResults: [], timestamp: 2_000 },
      ];
      newer.metrics.messageCount = 2;
      newer.metrics.totalTokens = 2400;
      newer.metrics.toolCallCount = 4;
      newer.lastUpdateTime = 2_000;

      const stale = makeSession('claude', 'sess-1');
      stale.messages = [];
      stale.metrics.messageCount = 0;
      stale.metrics.totalTokens = 500;
      stale.metrics.toolCallCount = 1;
      stale.lastUpdateTime = 1_200;

      useAgentSessionStore.getState().updateSession('pane-1', newer);
      const accepted = useAgentSessionStore.getState().updateSession('pane-1', stale);

      const stored = useAgentSessionStore.getState().sessions['pane-1']!;
      expect(accepted).toBe(false);
      expect(stored.messages).toHaveLength(2);
      expect(stored.metrics.totalTokens).toBe(2400);
      expect(stored.lastUpdateTime).toBe(2_000);
    });

    it('accepts a new session id for the same pane', () => {
      const oldSession = makeSession('claude', 'sess-1');
      oldSession.startTime = 1_000;
      oldSession.messages = [{ id: 'm1', type: 'user', content: 'old', toolCalls: [], toolResults: [], timestamp: 1_100 }];

      const newSession = makeSession('claude', 'sess-2');
      newSession.startTime = 5_000;
      newSession.lastUpdateTime = 5_100;
      newSession.messages = [{ id: 'm1', type: 'user', content: 'new', toolCalls: [], toolResults: [], timestamp: 5_050 }];
      newSession.metrics.totalTokens = 150;

      useAgentSessionStore.getState().updateSession('pane-1', oldSession);
      useAgentSessionStore.getState().updateSession('pane-1', newSession);

      const stored = useAgentSessionStore.getState().sessions['pane-1']!;
      expect(stored.sessionId).toBe('sess-2');
      expect(stored.startTime).toBe(5_000);
      expect(stored.messages[0]?.content).toBe('new');
    });

    it('accepts a corrected Codex session id even when the previous session looked newer', () => {
      const staleSession = makeSession('codex', 'unrelated-session');
      staleSession.startTime = 5_000;
      staleSession.lastUpdateTime = 5_200;
      staleSession.messages = [
        { id: 'm1', type: 'assistant', content: 'unrelated', toolCalls: [], toolResults: [], timestamp: 5_100 },
      ];

      const correctedSession = makeSession('codex', 'current-pane-session');
      correctedSession.startTime = 3_000;
      correctedSession.lastUpdateTime = 3_200;
      correctedSession.messages = [
        { id: 'm1', type: 'assistant', content: 'fresh pane data', toolCalls: [], toolResults: [], timestamp: 3_100 },
      ];

      useAgentSessionStore.getState().updateSession('pane-1', staleSession);
      useAgentSessionStore.getState().updateSession('pane-1', correctedSession);

      const stored = useAgentSessionStore.getState().sessions['pane-1']!;
      expect(stored.sessionId).toBe('current-pane-session');
      expect(stored.messages[0]?.content).toBe('fresh pane data');
    });

    it('rejects duplicate session objects', () => {
      const session = makeSession('claude', 'sess-1');

      useAgentSessionStore.getState().updateSession('pane-1', session);
      const accepted = useAgentSessionStore.getState().updateSession('pane-1', session);

      expect(accepted).toBe(false);
      expect(useAgentSessionStore.getState().sessions['pane-1']).toBe(session);
    });

    it('does not affect other pane sessions', () => {
      const session1 = makeSession('claude', 'sess-1');
      const session2 = makeSession('codex', 'sess-2');

      useAgentSessionStore.getState().updateSession('pane-1', session1);
      useAgentSessionStore.getState().updateSession('pane-2', session2);

      const sessions = useAgentSessionStore.getState().sessions;
      expect(Object.keys(sessions).length).toBe(2);
      expect(sessions['pane-1']!.agent).toBe('claude');
      expect(sessions['pane-2']!.agent).toBe('codex');
    });
  });

  describe('removeSession', () => {
    it('removes an existing session', () => {
      useAgentSessionStore.getState().updateSession('pane-1', makeSession());
      useAgentSessionStore.getState().removeSession('pane-1');

      expect(Object.keys(useAgentSessionStore.getState().sessions).length).toBe(0);
    });

    it('does nothing for unknown paneId', () => {
      useAgentSessionStore.getState().updateSession('pane-1', makeSession());
      useAgentSessionStore.getState().removeSession('pane-unknown');

      expect(Object.keys(useAgentSessionStore.getState().sessions).length).toBe(1);
    });

    it('preserves other sessions when removing one', () => {
      useAgentSessionStore.getState().updateSession('pane-1', makeSession('claude', 'sess-1'));
      useAgentSessionStore.getState().updateSession('pane-2', makeSession('codex', 'sess-2'));

      useAgentSessionStore.getState().removeSession('pane-1');

      const sessions = useAgentSessionStore.getState().sessions;
      expect(Object.keys(sessions).length).toBe(1);
      expect('pane-2' in sessions).toBe(true);
    });
  });

  describe('getSession', () => {
    it('returns session for known paneId', () => {
      const session = makeSession();
      useAgentSessionStore.getState().updateSession('pane-1', session);

      const result = useAgentSessionStore.getState().getSession('pane-1');
      expect(result).toBeDefined();
      expect(result!.sessionId).toBe('sess-1');
    });

    it('returns undefined for unknown paneId', () => {
      const result = useAgentSessionStore.getState().getSession('pane-unknown');
      expect(result).toBeUndefined();
    });
  });
});
