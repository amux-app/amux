import { describe, expect, it } from 'vitest';
import { SessionSearchIndex } from '../../src/main/services/agent-session/SessionSearchIndex';
import type { SessionSearchPane } from '../../src/main/services/agent-session/SessionSearchIndex';
import type {
  NormalizedMessage,
  NormalizedSession,
} from '../../src/shared/agent-session-types';

function makeMessage(id: string, overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    content: '',
    id,
    toolCalls: [],
    toolResults: [],
    type: 'assistant',
    ...overrides,
  };
}

function makeSession(messages: NormalizedMessage[]): NormalizedSession {
  return {
    agent: 'claude',
    compactionEvents: [],
    isOngoing: false,
    messages,
    metrics: {
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      inputTokens: 0,
      messageCount: messages.length,
      outputTokens: 0,
      toolCallCount: 0,
      totalTokens: 0,
    },
    sessionId: 'session-1',
    subagents: [],
  };
}

function createHarness() {
  const panes = new Map<string, SessionSearchPane>();
  const index = new SessionSearchIndex({
    getAllPanes: () => [...panes.values()],
    getPane: (paneId) => panes.get(paneId) ?? null,
  });

  return {
    index,
    removePane(paneId: string): void {
      panes.delete(paneId);
      index.removePane(paneId);
    },
    setPane(paneId: string, paneSlug: string, messages: NormalizedMessage[]): void {
      panes.set(paneId, { paneId, paneSlug, session: makeSession(messages) });
      index.markPaneDirty(paneId);
    },
  };
}

describe('SessionSearchIndex retained search behavior', () => {
  it('finds fuzzy message-content matches', async () => {
    const harness = createHarness();
    harness.setPane('p1', 'auth-pane', [
      makeMessage('m1', { content: 'Configure the authentication middleware' }),
    ]);

    await expect(harness.index.search('authenticaton')).resolves.toMatchObject([
      { messageId: 'm1', paneSlug: 'auth-pane' },
    ]);
  });

  it('finds message content from a token prefix', async () => {
    const harness = createHarness();
    harness.setPane('p1', 'prefix-pane', [
      makeMessage('m1', { content: 'Authentication middleware is configured' }),
    ]);

    await expect(harness.index.search('authent')).resolves.toMatchObject([
      { messageId: 'm1', paneSlug: 'prefix-pane' },
    ]);
  });

  it('indexes bash commands', async () => {
    const harness = createHarness();
    harness.setPane('p1', 'tester', [
      makeMessage('m1', {
        toolCalls: [{ id: 'tc1', input: { command: 'pnpm test --coverage' }, name: 'Bash' }],
      }),
    ]);

    await expect(harness.index.search('coverage')).resolves.toHaveLength(1);
  });

  it.each([
    ['pattern', { pattern: 'handleSubmit' }],
    ['query', { query: 'findCurrentPane' }],
  ])('indexes tool %s inputs', async (_field, input) => {
    const harness = createHarness();
    harness.setPane('p1', 'searcher', [
      makeMessage('m1', {
        toolCalls: [{ id: 'tc1', input, name: 'Grep' }],
      }),
    ]);

    await expect(harness.index.search(Object.values(input)[0])).resolves.toHaveLength(1);
  });

  it('indexes tool names without message content', async () => {
    const harness = createHarness();
    harness.setPane('p1', 'writer', [
      makeMessage('m1', {
        toolCalls: [{ id: 'tc1', input: {}, name: 'Write' }],
      }),
    ]);

    await expect(harness.index.search('Write')).resolves.toHaveLength(1);
  });

  it('ranks content matches above tool-summary matches', async () => {
    const harness = createHarness();
    harness.setPane('p1', 'content-match', [
      makeMessage('m1', { content: 'The authentication middleware validates tokens' }),
    ]);
    harness.setPane('p2', 'tool-match', [
      makeMessage('m1', {
        toolCalls: [{ id: 'tc1', input: { file_path: '/src/authentication.ts' }, name: 'Read' }],
      }),
    ]);

    const results = await harness.index.search('authentication');

    expect(results).toHaveLength(2);
    expect(results[0]?.paneSlug).toBe('content-match');
  });

  it('ranks documents matching more query terms first', async () => {
    const harness = createHarness();
    harness.setPane('p1', 'both', [
      makeMessage('m1', { content: 'Setting up authentication middleware for the API' }),
    ]);
    harness.setPane('p2', 'one-term', [
      makeMessage('m1', { content: 'Authentication is important for security' }),
    ]);

    const results = await harness.index.search('authentication middleware');

    expect(results).toHaveLength(2);
    expect(results[0]?.paneSlug).toBe('both');
  });

  it('omits filePath for text-only messages', async () => {
    const harness = createHarness();
    harness.setPane('p1', 'text-only', [
      makeMessage('m1', { content: 'A simple message about databases' }),
    ]);

    await expect(harness.index.search('databases')).resolves.toMatchObject([
      { filePath: undefined, messageId: 'm1' },
    ]);
  });

  it('keeps empty sessions and empty messages out of the index', async () => {
    const harness = createHarness();
    harness.setPane('empty', 'empty', []);
    harness.setPane('blank', 'blank', [
      makeMessage('m1'),
      makeMessage('m2', { content: '   ' }),
    ]);

    await expect(harness.index.search('anything')).resolves.toEqual([]);
    expect(harness.index.documentCount).toBe(0);
  });

  it('indexes tool-only messages', async () => {
    const harness = createHarness();
    harness.setPane('p1', 'tools', [
      makeMessage('m1', {
        toolCalls: [{ id: 'tc1', input: { file_path: '/important/config.json' }, name: 'Read' }],
      }),
    ]);

    await expect(harness.index.search('config.json')).resolves.toMatchObject([
      { filePath: '/important/config.json', messageId: 'm1' },
    ]);
    expect(harness.index.documentCount).toBe(1);
  });

  it('treats removal of an unknown pane as a no-op', async () => {
    const harness = createHarness();
    harness.setPane('p1', 'stable', [
      makeMessage('m1', { content: 'Stable searchable content' }),
    ]);
    await harness.index.search('stable');

    harness.removePane('unknown');

    await expect(harness.index.search('stable')).resolves.toHaveLength(1);
    expect(harness.index.documentCount).toBe(1);
  });
});
