import MiniSearch from 'minisearch';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionSearchIndex } from '../../src/main/services/agent-session/SessionSearchIndex';
import type {
  SessionSearchIndexOptions,
  SessionSearchPane,
} from '../../src/main/services/agent-session/SessionSearchIndex';
import type {
  NormalizedMessage,
  NormalizedSession,
} from '../../src/shared/agent-session-types';

function makeMessage(id: string, overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id,
    type: 'assistant',
    content: '',
    toolCalls: [],
    toolResults: [],
    ...overrides,
  };
}

function makeSession(messages: NormalizedMessage[]): NormalizedSession {
  return {
    agent: 'claude',
    sessionId: 'session-1',
    messages,
    metrics: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      messageCount: messages.length,
      toolCallCount: 0,
    },
    compactionEvents: [],
    subagents: [],
    isOngoing: false,
  };
}

function pane(
  paneId: string,
  paneSlug: string,
  messages: NormalizedMessage[],
): SessionSearchPane {
  return { paneId, paneSlug, session: makeSession(messages) };
}

function createHarness(options: SessionSearchIndexOptions = {}) {
  const panes = new Map<string, SessionSearchPane>();
  const getPane = vi.fn((paneId: string) => panes.get(paneId) ?? null);
  const index = new SessionSearchIndex({
    getAllPanes: () => [...panes.values()],
    getPane,
  }, options);

  return {
    getPane,
    index,
    removePane(paneId: string): void {
      panes.delete(paneId);
      index.removePane(paneId);
    },
    setPane(nextPane: SessionSearchPane): void {
      panes.set(nextPane.paneId, nextPane);
      index.markPaneDirty(nextPane.paneId);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('SessionSearchIndex', () => {
  it('keeps no index before the first valid search', async () => {
    const harness = createHarness();
    harness.setPane(pane('p1', 'lazy', [
      makeMessage('m1', { content: 'Lazy searchable content' }),
    ]));

    expect(harness.index.documentCount).toBe(0);
    await expect(harness.index.search('')).resolves.toEqual([]);
    await expect(harness.index.search('a')).resolves.toEqual([]);
    expect(harness.index.documentCount).toBe(0);
  });

  it('builds all panes and messages on the first search', async () => {
    const harness = createHarness();
    harness.setPane(pane('p1', 'frontend', [
      makeMessage('old', { content: 'Old React component' }),
      makeMessage('new', { content: 'New authorization flow' }),
    ]));
    harness.setPane(pane('p2', 'backend', [
      makeMessage('db', { content: 'Database schema migration' }),
    ]));

    await expect(harness.index.search('React')).resolves.toMatchObject([
      { paneId: 'p1', messageId: 'old' },
    ]);
    await expect(harness.index.search('authorization')).resolves.toHaveLength(1);
    await expect(harness.index.search('database')).resolves.toMatchObject([
      { paneId: 'p2', paneSlug: 'backend' },
    ]);
    expect(harness.index.documentCount).toBe(3);
  });

  it('yields to the event loop during a large first build', async () => {
    const harness = createHarness({ chunkSize: 25 });
    harness.setPane(pane('p1', 'large', Array.from({ length: 1_000 }, (_, index) =>
      makeMessage(`m${index}`, { content: `Searchable document ${index}` }))));
    let timerRan = false;
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerRan = true;
        resolve();
      }, 0);
    });

    const search = harness.index.search('searchable');
    await timer;

    expect(timerRan).toBe(true);
    await expect(search).resolves.not.toHaveLength(0);
  });

  it('yields while preparing documents before the initial MiniSearch insertion', async () => {
    const harness = createHarness({ chunkSize: 25 });
    harness.setPane(pane('p1', 'large-preparation', Array.from({ length: 1_000 }, (_, index) =>
      makeMessage(`m${index}`, { content: `Prepared document ${index}` }))));
    const addAll = vi.spyOn(MiniSearch.prototype, 'addAllAsync');

    const search = harness.index.search('prepared');
    expect(addAll).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(addAll).not.toHaveBeenCalled();
    await search;

    expect(addAll).toHaveBeenCalledOnce();
  });

  it('shares one in-flight build across concurrent searches', async () => {
    const harness = createHarness({ chunkSize: 10 });
    harness.setPane(pane('p1', 'shared', Array.from({ length: 200 }, (_, index) =>
      makeMessage(`m${index}`, { content: `Concurrent alpha beta ${index}` }))));
    const addAll = vi.spyOn(MiniSearch.prototype, 'addAllAsync');

    const [alpha, beta] = await Promise.all([
      harness.index.search('alpha'),
      harness.index.search('beta'),
    ]);

    expect(alpha).not.toHaveLength(0);
    expect(beta).not.toHaveLength(0);
    expect(addAll).toHaveBeenCalledTimes(1);
  });

  it('reconciles growing and same-length content edits', async () => {
    const harness = createHarness();
    harness.setPane(pane('p1', 'editor', [
      makeMessage('m1', { content: 'Initial note' }),
    ]));
    await harness.index.search('initial');

    harness.setPane(pane('p1', 'editor', [
      makeMessage('m1', { content: 'Initial note expanded with deployment' }),
    ]));
    await expect(harness.index.search('deployment')).resolves.toHaveLength(1);

    harness.setPane(pane('p1', 'editor', [
      makeMessage('m1', { content: 'Updated note expanded with deployment' }),
    ]));
    await expect(harness.index.search('updated')).resolves.toHaveLength(1);
    await expect(harness.index.search('initial')).resolves.toHaveLength(0);
    expect(harness.index.documentCount).toBe(1);
  });

  it('reconciles tool-call and tool-result changes', async () => {
    const harness = createHarness();
    harness.setPane(pane('p1', 'tools', [
      makeMessage('m1', {
        toolCalls: [{ id: 'tc1', name: 'Read', input: { file_path: '/src/alphaonly.zzz' } }],
      }),
    ]));
    await expect(harness.index.search('alphaonly')).resolves.toHaveLength(1);

    harness.setPane(pane('p1', 'tools', [
      makeMessage('m1', {
        toolCalls: [{ id: 'tc1', name: 'Read', input: { file_path: '/src/bravonly.zzz' } }],
        toolResults: [{ toolCallId: 'tc1', content: 'Unique compiler failure', isError: true }],
      }),
    ]));

    await expect(harness.index.search('bravonly')).resolves.toMatchObject([
      { filePath: '/src/bravonly.zzz' },
    ]);
    await expect(harness.index.search('compiler')).resolves.toHaveLength(1);
    await expect(harness.index.search('alphaonly')).resolves.toHaveLength(0);
  });

  it('reconciles an update that races the initial build', async () => {
    const harness = createHarness({ chunkSize: 5 });
    harness.setPane(pane('p1', 'racing', Array.from({ length: 500 }, (_, index) =>
      makeMessage(`m${index}`, { content: `Original content ${index}` }))));

    const search = harness.index.search('racewinner');
    harness.setPane(pane('p1', 'racing', [
      makeMessage('latest', { content: 'The racewinner is current' }),
    ]));

    await expect(search).resolves.toMatchObject([{ messageId: 'latest' }]);
    expect(harness.index.documentCount).toBe(1);
  });

  it('removes a pane that races the initial build', async () => {
    const harness = createHarness({ chunkSize: 5 });
    harness.setPane(pane('p1', 'removed', Array.from({ length: 500 }, (_, index) =>
      makeMessage(`m${index}`, { content: `Ghost marker ${index}` }))));

    const search = harness.index.search('ghost');
    harness.removePane('p1');

    await expect(search).resolves.toEqual([]);
    expect(harness.index.documentCount).toBe(0);
  });

  it('discards an active pane immediately', async () => {
    const harness = createHarness();
    harness.setPane(pane('p1', 'temporary', [
      makeMessage('m1', { content: 'Temporary searchable work' }),
    ]));
    await harness.index.search('temporary');

    harness.removePane('p1');

    await expect(harness.index.search('temporary')).resolves.toEqual([]);
    expect(harness.index.documentCount).toBe(0);
  });

  it('collapses multiple dirty marks into one pane reconciliation', async () => {
    const harness = createHarness();
    harness.setPane(pane('p1', 'collapsed', [
      makeMessage('m1', { content: 'Initial state' }),
    ]));
    await harness.index.search('initial');
    harness.getPane.mockClear();

    harness.setPane(pane('p1', 'collapsed', [
      makeMessage('m1', { content: 'Intermediate state' }),
    ]));
    harness.setPane(pane('p1', 'collapsed', [
      makeMessage('m1', { content: 'Another interim state' }),
    ]));
    harness.setPane(pane('p1', 'collapsed', [
      makeMessage('m1', { content: 'Final searchable state' }),
    ]));

    await expect(harness.index.search('final')).resolves.toHaveLength(1);
    expect(harness.getPane).toHaveBeenCalledTimes(1);
  });

  it('makes concurrent searches wait for an active reconciliation', async () => {
    const harness = createHarness({ chunkSize: 10 });
    harness.setPane(pane('p1', 'concurrent-reconciliation', [
      makeMessage('before', { content: 'Content before reconciliation' }),
    ]));
    await harness.index.search('before');
    harness.setPane(pane('p1', 'concurrent-reconciliation', [
      ...Array.from({ length: 499 }, (_, index) =>
        makeMessage(`m${index}`, { content: `Intermediate content ${index}` })),
      makeMessage('winner', { content: 'Concurrentwinner after reconciliation' }),
    ]));

    const [first, second] = await Promise.all([
      harness.index.search('concurrentwinner'),
      harness.index.search('concurrentwinner'),
    ]);

    expect(first).toMatchObject([{ messageId: 'winner' }]);
    expect(second).toMatchObject([{ messageId: 'winner' }]);
  });

  it('keeps document count stable through repeated replacements', async () => {
    const harness = createHarness();
    harness.setPane(pane('p1', 'stable', [
      makeMessage('m1', { content: 'Version 0 stable token' }),
    ]));
    await harness.index.search('stable');

    for (let version = 1; version <= 50; version++) {
      harness.setPane(pane('p1', 'stable', [
        makeMessage('m1', { content: `Version ${version} stable token` }),
      ]));
      await harness.index.search(`version ${version}`);
      expect(harness.index.documentCount).toBe(1);
    }

    await expect(harness.index.search('version 50')).resolves.toHaveLength(1);
    const miniSearch = Reflect.get(harness.index, 'index') as MiniSearch;
    expect(miniSearch.dirtCount).toBe(0);
  });

  it('does not vacuum after an append-only reconciliation', async () => {
    const harness = createHarness();
    harness.setPane(pane('p1', 'append-only', [
      makeMessage('m1', { content: 'Existing searchable content' }),
    ]));
    await harness.index.search('existing');
    const vacuum = vi.spyOn(MiniSearch.prototype, 'vacuum');

    harness.setPane(pane('p1', 'append-only', [
      makeMessage('m1', { content: 'Existing searchable content' }),
      makeMessage('m2', { content: 'Newly appended marker' }),
    ]));

    await expect(harness.index.search('appended')).resolves.toHaveLength(1);
    expect(vacuum).not.toHaveBeenCalled();
  });

  it('reconciles a dirty mark that arrives while vacuuming', async () => {
    const harness = createHarness();
    harness.setPane(pane('p1', 'late-dirty', [
      makeMessage('m1', { content: 'Original searchable content' }),
    ]));
    await harness.index.search('original');
    let releaseVacuum: () => void = () => {};
    const firstVacuum = new Promise<void>((resolve) => {
      releaseVacuum = resolve;
    });
    const vacuum = vi.spyOn(MiniSearch.prototype, 'vacuum')
      .mockImplementationOnce(() => firstVacuum)
      .mockResolvedValue(undefined);
    harness.setPane(pane('p1', 'late-dirty', [
      makeMessage('m1', { content: 'Intermediate searchable content' }),
    ]));

    const search = harness.index.search('latewinner');
    await vi.waitFor(() => expect(vacuum).toHaveBeenCalledOnce());
    harness.setPane(pane('p1', 'late-dirty', [
      makeMessage('m1', { content: 'Intermediate searchable content' }),
      makeMessage('m2', { content: 'Latewinner arrived during vacuum' }),
    ]));
    releaseVacuum();

    await expect(search).resolves.toMatchObject([{ messageId: 'm2' }]);
  });

  it('bounds reconciliation work when a pane stays continuously dirty', async () => {
    const harness = createHarness({ chunkSize: 10 });
    harness.setPane(pane('p1', 'streaming', [
      makeMessage('m1', { content: 'Continuously updated content' }),
    ]));
    await harness.index.search('continuously');
    harness.setPane(pane('p1', 'streaming', [
      makeMessage('m1', { content: 'Continuously updated content now' }),
    ]));
    let remainingStreamingUpdates = 10;
    harness.getPane.mockImplementation((paneId) => {
      if (remainingStreamingUpdates > 0) {
        remainingStreamingUpdates -= 1;
        harness.index.markPaneDirty(paneId);
      }
      return pane('p1', 'streaming', [
        makeMessage('m1', { content: 'Continuously updated content now' }),
      ]);
    });

    await expect(harness.index.search('updated')).resolves.toHaveLength(1);

    expect(harness.getPane.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('yields while reconciling a large dirty pane', async () => {
    const harness = createHarness({ chunkSize: 100 });
    const messages = Array.from({ length: 24_000 }, (_, index) =>
      makeMessage(`m${index}`, { content: `Original reconciliation content ${index}` }));
    harness.setPane(pane('p1', 'large-reconciliation', messages));
    await harness.index.search('original');
    harness.setPane(pane('p1', 'large-reconciliation', messages.map((message) => ({
      ...message,
      content: message.content.replace('Original', 'Updated'),
    }))));
    const startedAt = performance.now();
    let timerDelay = Number.POSITIVE_INFINITY;
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerDelay = performance.now() - startedAt;
        resolve();
      }, 0);
    });

    const search = harness.index.search('updated');
    await timer;

    expect(timerDelay).toBeLessThan(50);
    await expect(search).resolves.not.toHaveLength(0);
  });

  it('clears after inactivity and rebuilds from current state', async () => {
    const harness = createHarness({ inactivityMs: 1_000 });
    harness.setPane(pane('p1', 'expiring', [
      makeMessage('m1', { content: 'Before expiry' }),
    ]));
    vi.useFakeTimers();
    await harness.index.search('before');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.index.documentCount).toBe(0);

    harness.setPane(pane('p1', 'expiring', [
      makeMessage('m2', { content: 'After rebuild' }),
    ]));
    await expect(harness.index.search('rebuild')).resolves.toMatchObject([
      { messageId: 'm2' },
    ]);
  });

  it('does not evict the index while a search is actively reconciling', async () => {
    const harness = createHarness({ inactivityMs: 1_000 });
    harness.setPane(pane('p1', 'active-search', [
      makeMessage('m1', { content: 'Before active reconciliation' }),
    ]));
    vi.useFakeTimers();
    await harness.index.search('before');
    await vi.advanceTimersByTimeAsync(900);

    let releaseVacuum: () => void = () => {};
    const vacuumBlocked = new Promise<void>((resolve) => {
      releaseVacuum = resolve;
    });
    const vacuum = vi.spyOn(MiniSearch.prototype, 'vacuum')
      .mockImplementationOnce(() => vacuumBlocked);
    harness.setPane(pane('p1', 'active-search', [
      makeMessage('m1', { content: 'After active reconciliation' }),
    ]));

    const search = harness.index.search('after');
    await vi.waitFor(() => expect(vacuum).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(200);

    expect(harness.index.documentCount).toBe(1);
    releaseVacuum();
    await expect(search).resolves.toHaveLength(1);
  });

  it('clears all active documents explicitly', async () => {
    const harness = createHarness();
    harness.setPane(pane('p1', 'clearable', [
      makeMessage('m1', { content: 'Clear this index' }),
    ]));
    await harness.index.search('clear');

    harness.index.clear();

    expect(harness.index.documentCount).toBe(0);
  });

  it('does not resurrect an index when disposal races a search', async () => {
    const harness = createHarness({ chunkSize: 10 });
    harness.setPane(pane('p1', 'disposed', Array.from({ length: 500 }, (_, index) =>
      makeMessage(`m${index}`, { content: `Disposed searchable content ${index}` }))));
    const search = harness.index.search('disposed');
    harness.index.dispose();

    await expect(search).resolves.toEqual([]);
    await expect(harness.index.search('disposed')).resolves.toEqual([]);
    expect(harness.index.documentCount).toBe(0);
  });

  it('preserves result ranking, snippets, limits, and special paths', async () => {
    const harness = createHarness();
    harness.setPane(pane('p1', 'exact', [
      makeMessage('m1', {
        content: `This long message has ${'context '.repeat(10)}models.yaml in the center`,
        toolCalls: [{ id: 'tc1', name: 'Read', input: { file_path: '/src/models.yaml' } }],
      }),
      ...Array.from({ length: 60 }, (_, index) =>
        makeMessage(`extra${index}`, { content: `models.yaml repeated result ${index}` })),
    ]));
    harness.setPane(pane('p2', 'partial', [
      makeMessage('m1', { content: 'Updated data models' }),
    ]));

    const results = await harness.index.search('models.yaml');

    expect(results).toHaveLength(50);
    expect(results[0]).toMatchObject({
      paneSlug: 'exact',
      filePath: '/src/models.yaml',
    });
    expect(results[0].snippet).toContain('models.yaml');
    expect(results[0].snippet.length).toBeLessThan(200);
  });

  it('keeps synchronous preparation below the event-loop budget', async () => {
    const harness = createHarness({ chunkSize: 50 });
    harness.setPane(pane('p1', 'benchmark', Array.from({ length: 4_346 }, (_, index) =>
      makeMessage(`m${index}`, {
        content: `Message ${index} with realistic searchable content and source details`,
        toolCalls: index % 3 === 0
          ? [{ id: `tc${index}`, name: 'Read', input: { file_path: `/src/file-${index}.ts` } }]
          : [],
      }))));
    const startedAt = performance.now();
    let timerDelay = Number.POSITIVE_INFINITY;
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerDelay = performance.now() - startedAt;
        resolve();
      }, 0);
    });

    const search = harness.index.search('searchable');
    await timer;

    expect(timerDelay).toBeLessThan(50);
    await expect(search).resolves.not.toHaveLength(0);
  });
});
