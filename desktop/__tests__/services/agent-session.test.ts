import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/main/services/parsing/AgentLogParser.js', () => ({
  createParser: vi.fn(),
}));

vi.mock('../../src/main/services/Logger.js', () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    infoThrottled: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../../src/main/services/agent-session/SessionFileWatcher.js', () => ({
  SessionFileWatcher: class {
    start = vi.fn();
    stop = vi.fn();
  },
}));

import { AgentSessionService, type HarvestedTitle } from '../../src/main/services/agent-session/AgentSessionService';
import { createParser } from '../../src/main/services/parsing/AgentLogParser';
import type { AgentLogParser } from '../../src/main/services/parsing/AgentLogParser';
import type { NormalizedMessage, NormalizedSession } from '../../src/shared/agent-session-types';
import { createEmptySession } from '../../src/shared/agent-session-types';
import type { MuxBasePane } from 'muxbase/core';

const mockedCreateParser = vi.mocked(createParser);
type MockAgentLogParser = AgentLogParser & {
  findSessionFile: ReturnType<typeof vi.fn>;
  getSessionDirectory: ReturnType<typeof vi.fn>;
  parseSession: ReturnType<typeof vi.fn>;
};

function makePane(overrides: Partial<MuxBasePane> = {}): MuxBasePane {
  return {
    id: 'muxbase-1',
    slug: 'test',
    prompt: 'do something',
    paneId: '%1',
    ...overrides,
  };
}

function makeMockParser(agent: 'claude' | 'codex' | 'opencode' = 'claude'): MockAgentLogParser {
  return {
    agent: agent as const,
    findSessionFile: vi.fn().mockResolvedValue(null),
    getSessionDirectory: vi.fn().mockReturnValue(null),
    parseSession: vi.fn(),
  };
}

function registerMockParser(agent: 'claude' | 'codex' | 'opencode' = 'claude') {
  const parser = makeMockParser(agent);
  mockedCreateParser.mockReturnValue(parser);
  return parser;
}

function makeTestWindow(initialVisible = true, initialMinimized = false) {
  let visible = initialVisible;
  let minimized = initialMinimized;
  const events = new EventEmitter();
  const send = vi.fn();
  const window = Object.assign(events, {
    isDestroyed: () => false,
    isMinimized: () => minimized,
    isVisible: () => visible,
    webContents: { send },
  }) as unknown as NonNullable<Parameters<AgentSessionService['setWindow']>[0]>;

  return {
    send,
    window,
    listenerCount(event: string): number {
      return events.listenerCount(event);
    },
    focus(): void {
      events.emit('focus');
    },
    hide(): void {
      visible = false;
      events.emit('hide');
    },
    minimize(): void {
      minimized = true;
      events.emit('minimize');
    },
    restore(): void {
      minimized = false;
      events.emit('restore');
    },
    show(): void {
      visible = true;
      minimized = false;
      events.emit('show');
    },
  };
}

describe('AgentSessionService', () => {
  let service: AgentSessionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AgentSessionService('/tmp/test-project');
  });

  afterEach(() => {
    service.shutdown();
  });

  describe('onPaneCreated', () => {
    it('skips panes with no agent', async () => {
      await service.onPaneCreated(makePane({ agent: undefined }));
      expect(mockedCreateParser).not.toHaveBeenCalled();
    });

    it('creates context for claude agent', async () => {
      registerMockParser('claude');
      await service.onPaneCreated(makePane({ agent: 'claude' }));
      expect(mockedCreateParser).toHaveBeenCalledWith('claude');
    });

    it('creates context for codex agent', async () => {
      registerMockParser('codex');
      await service.onPaneCreated(makePane({ agent: 'codex' }));
      expect(mockedCreateParser).toHaveBeenCalledWith('codex');
    });

    it('creates context for opencode agent', async () => {
      registerMockParser('opencode');
      await service.onPaneCreated(makePane({ agent: 'opencode' }));
      expect(mockedCreateParser).toHaveBeenCalledWith('opencode');
    });

    it('does not create duplicate context for same pane', async () => {
      registerMockParser();
      const pane = makePane({ agent: 'claude' });
      await service.onPaneCreated(pane);
      await service.onPaneCreated(pane);
      expect(mockedCreateParser).toHaveBeenCalledTimes(1);
    });

    it('serializes concurrent onPaneCreated calls for the same pane', async () => {
      registerMockParser();
      const pane = makePane({ agent: 'claude' });
      let release: () => void = () => {};
      const gate = new Promise<string>((resolve) => {
        release = () => resolve('/tmp/test-project');
      });
      const racingService = new AgentSessionService(
        '/tmp/test-project',
        () => gate,
      );

      const calls = await Promise.all([
        racingService.onPaneCreated(pane),
        racingService.onPaneCreated(pane),
        racingService.onPaneCreated(pane),
        racingService.onPaneCreated(pane),
      ].map((p, idx) => {
        if (idx === 0) setImmediate(release);
        return p;
      }));

      expect(calls).toHaveLength(4);
      expect(mockedCreateParser).toHaveBeenCalledTimes(1);
      expect(racingService.hasContext(pane.id)).toBe(true);
      racingService.shutdown();
    });

    it('serializes concurrent ensureTracking calls for the same pane', async () => {
      registerMockParser();
      const pane = makePane({ id: 'muxbase-shell', agent: undefined });
      let release: () => void = () => {};
      const gate = new Promise<string>((resolve) => {
        release = () => resolve('/tmp/test-project');
      });
      const racingService = new AgentSessionService(
        '/tmp/test-project',
        () => gate,
      );

      const promises = [
        racingService.ensureTracking(pane, 'claude'),
        racingService.ensureTracking(pane, 'claude'),
        racingService.ensureTracking(pane, 'claude'),
        racingService.ensureTracking(pane, 'claude'),
      ];
      setImmediate(release);
      await Promise.all(promises);

      expect(mockedCreateParser).toHaveBeenCalledTimes(1);
      expect(racingService.hasContext(pane.id)).toBe(true);
      racingService.shutdown();
    });

    it('mixed concurrent onPaneCreated and ensureTracking still creates one context', async () => {
      registerMockParser();
      const pane = makePane({ agent: 'claude' });
      let release: () => void = () => {};
      const gate = new Promise<string>((resolve) => {
        release = () => resolve('/tmp/test-project');
      });
      const racingService = new AgentSessionService(
        '/tmp/test-project',
        () => gate,
      );

      const promises = [
        racingService.onPaneCreated(pane),
        racingService.ensureTracking(pane, 'claude'),
        racingService.onPaneCreated(pane),
        racingService.ensureTracking(pane, 'claude'),
      ];
      setImmediate(release);
      await Promise.all(promises);

      expect(mockedCreateParser).toHaveBeenCalledTimes(1);
      racingService.shutdown();
    });

    it('allows a fresh start after the pane is destroyed', async () => {
      registerMockParser();
      const pane = makePane({ agent: 'claude' });
      await service.onPaneCreated(pane);
      expect(mockedCreateParser).toHaveBeenCalledTimes(1);

      service.onPaneDestroyed(pane.id);
      await service.onPaneCreated(pane);
      expect(mockedCreateParser).toHaveBeenCalledTimes(2);
    });

    it('registers no context when the start fails, so a later attempt can retry', async () => {
      // Arrange
      const mockParser = registerMockParser('opencode');
      mockParser.getSessionDirectory.mockImplementationOnce(() => {
        throw new Error('session store unreadable');
      });
      const pane = makePane({ agent: 'opencode' });

      // Act
      await service.onPaneCreated(pane);
      const registeredAfterFailure = service.hasContext(pane.id);
      await service.onPaneCreated(pane);

      // Assert
      expect(registeredAfterFailure).toBe(false);
      expect(service.hasContext(pane.id)).toBe(true);
      expect(mockedCreateParser).toHaveBeenCalledTimes(2);
    });

    it('aborts an in-flight start when the pane is destroyed mid-resolve', async () => {
      const mockParser = registerMockParser();
      const pane = makePane({ agent: 'claude' });
      let release: () => void = () => {};
      const gate = new Promise<string>((resolve) => {
        release = () => resolve('/tmp/test-project');
      });
      const racingService = new AgentSessionService(
        '/tmp/test-project',
        () => gate,
      );

      const startPromise = racingService.onPaneCreated(pane);
      racingService.onPaneDestroyed(pane.id);
      release();
      await startPromise;

      expect(racingService.hasContext(pane.id)).toBe(false);
      expect(mockParser.findSessionFile).not.toHaveBeenCalled();
      racingService.shutdown();
    });

    it('does not serialize different panes against each other', async () => {
      registerMockParser();
      const pane1 = makePane({ id: 'pane-a', agent: 'claude' });
      const pane2 = makePane({ id: 'pane-b', agent: 'claude' });
      let release: () => void = () => {};
      const gate = new Promise<string>((resolve) => {
        release = () => resolve('/tmp/test-project');
      });
      const racingService = new AgentSessionService(
        '/tmp/test-project',
        () => gate,
      );

      const promises = [
        racingService.onPaneCreated(pane1),
        racingService.onPaneCreated(pane2),
      ];
      setImmediate(release);
      await Promise.all(promises);

      expect(mockedCreateParser).toHaveBeenCalledTimes(2);
      expect(racingService.hasContext(pane1.id)).toBe(true);
      expect(racingService.hasContext(pane2.id)).toBe(true);
      racingService.shutdown();
    });

    it('uses live pane cwd resolver for session discovery', async () => {
      const mockParser = registerMockParser();
      const serviceWithResolver = new AgentSessionService(
        '/tmp/test-project',
        async () => '/tmp/live-pane-cwd',
      );

      await serviceWithResolver.onPaneCreated(makePane({ agent: 'claude' }));

      expect(mockParser.findSessionFile).toHaveBeenCalledWith(
        expect.any(Object),
        '/tmp/live-pane-cwd',
        expect.any(Set),
        'initial',
      );
    });

    it('prefers pane project root when live cwd is outside pane root', async () => {
      const mockParser = registerMockParser();
      const serviceWithResolver = new AgentSessionService(
        '/tmp/fallback-root',
        async () => '/tmp/other-project',
      );

      await serviceWithResolver.onPaneCreated(
        makePane({ agent: 'claude', projectRoot: '/tmp/expected-project' }),
      );

      expect(mockParser.findSessionFile).toHaveBeenCalledWith(
        expect.any(Object),
        '/tmp/expected-project',
        expect.any(Set),
        'initial',
      );
    });

    it('uses the worktree path for worktree pane session matching', async () => {
      const mockParser = registerMockParser();
      const serviceWithResolver = new AgentSessionService(
        '/tmp/fallback-root',
        async () => '/Users/user/my-repo/.muxbase/worktrees/fix-123/src',
      );

      await serviceWithResolver.onPaneCreated(
        makePane({
          agent: 'claude',
          projectRoot: '/Users/user/my-repo',
          worktreePath: '/Users/user/my-repo/.muxbase/worktrees/fix-123',
        }),
      );

      expect(mockParser.findSessionFile).toHaveBeenCalledWith(
        expect.any(Object),
        '/Users/user/my-repo/.muxbase/worktrees/fix-123/src',
        expect.any(Set),
        'initial',
      );
    });

    it('uses worktree path when projectRoot is missing', async () => {
      const mockParser = registerMockParser();

      await service.onPaneCreated(
        makePane({
          agent: 'claude',
          projectRoot: undefined,
          worktreePath: '/Users/user/my-repo/.muxbase/worktrees/fix-123',
        }),
      );

      expect(mockParser.findSessionFile).toHaveBeenCalledWith(
        expect.any(Object),
        '/Users/user/my-repo/.muxbase/worktrees/fix-123',
        expect.any(Set),
        'initial',
      );
    });

    it('uses worktreePath as fallback when projectRoot is missing', async () => {
      const mockParser = registerMockParser();

      await service.onPaneCreated(
        makePane({
          agent: 'claude',
          projectRoot: undefined,
          worktreePath: '/tmp/worktree-only',
        }),
      );

      expect(mockParser.findSessionFile).toHaveBeenCalledWith(
        expect.any(Object),
        expect.stringContaining('worktree-only'),
        expect.any(Set),
        'initial',
      );
    });

    it('uses live cwd for non-worktree panes when cwd is inside project', async () => {
      const mockParser = registerMockParser();
      const serviceWithResolver = new AgentSessionService(
        '/tmp/fallback',
        async () => '/Users/user/my-repo/src/components',
      );

      await serviceWithResolver.onPaneCreated(
        makePane({ agent: 'claude', projectRoot: '/Users/user/my-repo' }),
      );

      expect(mockParser.findSessionFile).toHaveBeenCalledWith(
        expect.any(Object),
        '/Users/user/my-repo/src/components',
        expect.any(Set),
        'initial',
      );
    });

    it('uses live cwd inside a worktree when available', async () => {
      const mockParser = registerMockParser();
      const serviceWithResolver = new AgentSessionService(
        '/tmp/fallback',
        async () => '/Users/user/my-repo/.muxbase/worktrees/feature/src',
      );

      await serviceWithResolver.onPaneCreated(
        makePane({
          agent: 'claude',
          projectRoot: '/Users/user/my-repo',
          worktreePath: '/Users/user/my-repo/.muxbase/worktrees/feature',
        }),
      );

      expect(mockParser.findSessionFile).toHaveBeenCalledWith(
        expect.any(Object),
        '/Users/user/my-repo/.muxbase/worktrees/feature/src',
        expect.any(Set),
        'initial',
      );
    });

    it('falls back to service projectRoot when pane has no paths', async () => {
      const mockParser = registerMockParser();
      const serviceWithResolver = new AgentSessionService(
        '/tmp/service-root',
        async () => null,
      );

      await serviceWithResolver.onPaneCreated(
        makePane({ agent: 'claude', projectRoot: undefined }),
      );

      expect(mockParser.findSessionFile).toHaveBeenCalledWith(
        expect.any(Object),
        '/tmp/service-root',
        expect.any(Set),
        'initial',
      );
    });

    it('passes shared claimedFiles set to parser via context', async () => {
      const mockParser = registerMockParser();

      const paneA = makePane({ id: 'muxbase-1', agent: 'claude' });
      const paneB = makePane({ id: 'muxbase-2', agent: 'claude' });
      await service.onPaneCreated(paneA);
      await service.onPaneCreated(paneB);

      const callsA = mockParser.findSessionFile.mock.calls.filter(
        (c: unknown[]) => (c[0] as MuxBasePane).id === 'muxbase-1',
      );
      const callsB = mockParser.findSessionFile.mock.calls.filter(
        (c: unknown[]) => (c[0] as MuxBasePane).id === 'muxbase-2',
      );
      expect(callsA[0][2]).toBe(callsB[0][2]);
      expect(callsA[0][2]).toBeInstanceOf(Set);
    });

    it('resolves tracking startup after binding a session file while parsing remains active', async () => {
      const mockParser = registerMockParser();
      mockParser.findSessionFile.mockResolvedValue('/tmp/session.jsonl');
      mockParser.parseSession.mockReturnValue(new Promise<NormalizedSession>(() => {}));

      const startPromise = service.onPaneCreated(makePane({ agent: 'claude' }));

      await vi.waitFor(() => expect(mockParser.parseSession).toHaveBeenCalledTimes(1));

      const outcome = await Promise.race([
        startPromise.then(() => 'resolved'),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 0)),
      ]);

      expect(outcome).toBe('resolved');
    });

    it('notifies when a pane session id changes after rebinding', () => {
      const discovered: string[] = [];
      const serviceWithCallback = new AgentSessionService(
        '/tmp/service-root',
        undefined,
        (_paneId, sessionId) => discovered.push(sessionId),
      );
      const emitter = serviceWithCallback as unknown as {
        emitUpdate(paneId: string, session: NormalizedSession): void;
      };

      emitter.emitUpdate('pane-1', createEmptySession('codex', 'old-session'));
      emitter.emitUpdate('pane-1', createEmptySession('codex', 'old-session'));
      emitter.emitUpdate('pane-1', createEmptySession('codex', 'new-session'));

      expect(discovered).toEqual(['old-session', 'new-session']);
    });

    it('uses the OpenCode session title instead of synthetic editor context', () => {
      const titles: string[] = [];
      const serviceWithCallback = new AgentSessionService(
        '/tmp/service-root',
        undefined,
        undefined,
        (_paneId, harvested) => titles.push(harvested.title),
      );
      const emitter = serviceWithCallback as unknown as {
        emitUpdate(paneId: string, session: NormalizedSession): void;
      };
      const session = createEmptySession('opencode', 'opencode-session');
      session.title = 'Fix terminal scrollback';
      session.messages = [
        {
          content: '<system-reminder>Note: file opened</system-reminder>\nFix terminal scrollback',
          id: 'msg-1',
          timestamp: 1,
          toolCalls: [],
          toolResults: [],
          type: 'user',
        },
      ];

      emitter.emitUpdate('pane-1', session);

      expect(titles).toEqual(['Fix terminal scrollback']);
    });

    it('does not derive a Codex title from user messages', () => {
      const titles: string[] = [];
      const serviceWithCallback = new AgentSessionService(
        '/tmp/service-root',
        undefined,
        undefined,
        (_paneId, harvested) => titles.push(harvested.title),
      );
      const emitter = serviceWithCallback as unknown as {
        emitUpdate(paneId: string, session: NormalizedSession): void;
      };
      const session = createEmptySession('codex', 'codex-session');
      session.messages = [
        {
          content: '<system-reminder>Note: file opened</system-reminder>\nImplement review flow',
          id: 'msg-1',
          timestamp: 1,
          toolCalls: [],
          toolResults: [],
          type: 'user',
        },
      ];

      emitter.emitUpdate('pane-1', session);

      expect(titles).toEqual([]);
    });
  });

  describe('onPaneDestroyed', () => {
    it('does not throw for unknown paneId', () => {
      expect(() => service.onPaneDestroyed('unknown-pane')).not.toThrow();
    });

    it('cleans up existing context', async () => {
      registerMockParser();
      const pane = makePane({ agent: 'claude' });
      await service.onPaneCreated(pane);
      service.onPaneDestroyed(pane.id);
      expect(service.getSession(pane.id)).toBeNull();
    });

    it('emits AGENT_SESSION_REMOVED event when window is set', async () => {
      registerMockParser();

      const testWindow = makeTestWindow();

      service.setWindow(testWindow.window);
      const pane = makePane({ agent: 'claude' });
      await service.onPaneCreated(pane);
      service.onPaneDestroyed(pane.id);

      expect(testWindow.send).toHaveBeenCalledWith('event:agent-session-removed', { paneId: pane.id });
    });

    it('does not emit a late session update after pane destruction', async () => {
      let resolveParse: ((session: NormalizedSession) => void) | undefined;
      const parsePromise = new Promise<NormalizedSession>((resolve) => {
        resolveParse = resolve;
      });
      const mockParser = registerMockParser();
      mockParser.findSessionFile.mockResolvedValue('/tmp/session.jsonl');
      mockParser.parseSession.mockReturnValue(parsePromise);

      const testWindow = makeTestWindow();

      service.setWindow(testWindow.window);
      const pane = makePane({ agent: 'claude' });

      await service.onPaneCreated(pane);
      await vi.waitFor(() => expect(mockParser.parseSession).toHaveBeenCalledTimes(1));

      service.onPaneDestroyed(pane.id);
      testWindow.send.mockClear();
      expect(resolveParse).toBeDefined();
      resolveParse!(createEmptySession('claude', 'late-session'));
      await Promise.resolve();

      expect(testWindow.send).not.toHaveBeenCalledWith(
        'event:agent-session-updated',
        expect.objectContaining({ paneId: pane.id }),
      );
      expect(service.getSession(pane.id)).toBeNull();
    });

  });

  describe('getSession', () => {
    it('returns null for unknown paneId', () => {
      expect(service.getSession('unknown')).toBeNull();
    });
  });

  describe('session search', () => {
    it('marks an active index dirty without indexing messages during session emits', () => {
      const searchIndex = Reflect.get(service, 'searchIndex') as {
        documentCount: number;
        markPaneDirty(paneId: string): void;
      };
      const markPaneDirty = vi.spyOn(searchIndex, 'markPaneDirty');
      const session = createEmptySession('claude', 'session-1');
      session.messages = [{
        content: 'Deferred searchable content',
        id: 'message-1',
        toolCalls: [{
          id: 'tool-1',
          input: { file_path: '/src/deferred.ts' },
          name: 'Read',
        }],
        toolResults: [],
        type: 'assistant',
      }];
      const emitter = service as unknown as {
        emitUpdate(paneId: string, session: NormalizedSession): void;
      };

      emitter.emitUpdate('pane-1', session);

      expect(markPaneDirty).toHaveBeenCalledWith('pane-1');
      expect(searchIndex.documentCount).toBe(0);
    });
  });

  describe('renderer delivery', () => {
    it('relies on the application visibility monitor instead of attaching window listeners', () => {
      const testWindow = makeTestWindow(false);

      service.setWindow(testWindow.window);

      expect(['focus', 'hide', 'minimize', 'restore', 'show']
        .every((event) => testWindow.listenerCount(event) === 0)).toBe(true);
    });

    it('defers hidden updates and flushes the newest session before topics once', () => {
      const hiddenService = new AgentSessionService(
        '/tmp/test-project',
        undefined,
        undefined,
        undefined,
        undefined,
        () => true,
      );
      const testWindow = makeTestWindow(false);
      let latest = createEmptySession('claude', 'session-1');
      Reflect.set(hiddenService, 'contexts', new Map([
        ['pane-1', { getSession: () => latest, stop: vi.fn() }],
      ]));
      hiddenService.setWindow(testWindow.window);
      const topicService = Reflect.get(hiddenService, 'topicService') as {
        computeTopics(session: NormalizedSession): unknown;
      };
      const computeTopics = vi.spyOn(topicService, 'computeTopics');
      const emitter = hiddenService as unknown as {
        emitUpdate(paneId: string, session: NormalizedSession): void;
      };

      for (let update = 1; update <= 3; update++) {
        latest = createEmptySession('claude', `session-${update}`);
        latest.messages = [{
          content: `Newest topic ${update}`,
          id: `message-${update}`,
          toolCalls: [],
          toolResults: [],
          type: 'user',
        }];
        emitter.emitUpdate('pane-1', latest);
      }

      expect(testWindow.send).not.toHaveBeenCalled();
      expect(computeTopics).not.toHaveBeenCalled();

      testWindow.show();
      hiddenService.syncWindowVisibility();

      expect(testWindow.send.mock.calls.map(([channel]) => channel)).toEqual([
        'event:agent-session-updated',
        'event:topics-updated',
      ]);
      expect(testWindow.send.mock.calls[0][1]).toMatchObject({
        paneId: 'pane-1',
        session: { sessionId: 'session-3' },
      });
      expect(computeTopics).toHaveBeenCalledTimes(1);
      hiddenService.shutdown();
    });

    it('treats a minimized window as hidden and flushes on restore', () => {
      const testWindow = makeTestWindow(true, true);
      const latest = createEmptySession('claude', 'minimized-session');
      Reflect.set(service, 'contexts', new Map([
        ['pane-1', { getSession: () => latest, stop: vi.fn() }],
      ]));
      service.setWindow(testWindow.window);
      const emitter = service as unknown as {
        emitUpdate(paneId: string, session: NormalizedSession): void;
      };

      emitter.emitUpdate('pane-1', latest);
      expect(testWindow.send).not.toHaveBeenCalled();

      testWindow.restore();
      service.syncWindowVisibility();
      expect(testWindow.send).toHaveBeenCalledOnce();
      expect(testWindow.send).toHaveBeenCalledWith(
        'event:agent-session-updated',
        { paneId: 'pane-1', session: latest },
      );
    });

    it('does not flush a pane removed while hidden', () => {
      const testWindow = makeTestWindow(false);
      const latest = createEmptySession('claude', 'removed-session');
      Reflect.set(service, 'contexts', new Map([
        ['pane-1', { getSession: () => latest, stop: vi.fn() }],
      ]));
      service.setWindow(testWindow.window);
      const emitter = service as unknown as {
        emitUpdate(paneId: string, session: NormalizedSession): void;
      };
      emitter.emitUpdate('pane-1', latest);

      service.onPaneDestroyed('pane-1');
      testWindow.send.mockClear();
      testWindow.show();
      service.syncWindowVisibility();

      expect(testWindow.send).not.toHaveBeenCalled();
    });

    it('keeps the hidden pull model cost-enriched', () => {
      const testWindow = makeTestWindow(false);
      const latest = createEmptySession('codex', 'cost-session');
      latest.messages = [{
        content: 'Costed response',
        id: 'message-1',
        model: 'gpt-5',
        tokens: {
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          inputTokens: 1_000,
          outputTokens: 500,
        },
        toolCalls: [],
        toolResults: [],
        type: 'assistant',
      }];
      Reflect.set(service, 'contexts', new Map([
        ['pane-1', { getSession: () => latest, stop: vi.fn() }],
      ]));
      service.setWindow(testWindow.window);
      const emitter = service as unknown as {
        emitUpdate(paneId: string, session: NormalizedSession): void;
      };

      emitter.emitUpdate('pane-1', latest);

      expect(service.getSession('pane-1')).toBe(latest);
      expect(latest.metrics.costSource).toBe('estimate');
      expect(latest.metrics.costUSD).toBeGreaterThan(0);
      expect(testWindow.send).not.toHaveBeenCalled();
    });

    it('clears hidden dirty state when the window is replaced', () => {
      const hiddenWindow = makeTestWindow(false);
      const replacement = makeTestWindow(true);
      const latest = createEmptySession('claude', 'old-window-session');
      Reflect.set(service, 'contexts', new Map([
        ['pane-1', { getSession: () => latest, stop: vi.fn() }],
      ]));
      service.setWindow(hiddenWindow.window);
      const emitter = service as unknown as {
        emitUpdate(paneId: string, session: NormalizedSession): void;
      };
      emitter.emitUpdate('pane-1', latest);

      service.setWindow(replacement.window);
      replacement.focus();

      expect(replacement.send).not.toHaveBeenCalled();
    });

    it('continues sending every visible update immediately', () => {
      const testWindow = makeTestWindow();
      service.setWindow(testWindow.window);
      const emitter = service as unknown as {
        emitUpdate(paneId: string, session: NormalizedSession): void;
      };
      const first = createEmptySession('claude', 'visible-1');
      const second = createEmptySession('claude', 'visible-2');

      emitter.emitUpdate('pane-1', first);
      emitter.emitUpdate('pane-1', second);

      expect(testWindow.send).toHaveBeenNthCalledWith(
        1,
        'event:agent-session-updated',
        { paneId: 'pane-1', session: first },
      );
      expect(testWindow.send).toHaveBeenNthCalledWith(
        2,
        'event:agent-session-updated',
        { paneId: 'pane-1', session: second },
      );
    });
  });

  describe('conversation topics', () => {
    it('does not compute or publish topics while the feature is disabled', () => {
      const testWindow = makeTestWindow();
      service.setWindow(testWindow.window);
      const topicService = Reflect.get(service, 'topicService') as {
        computeTopics(session: NormalizedSession): unknown;
      };
      const computeTopics = vi.spyOn(topicService, 'computeTopics');
      const emitter = service as unknown as {
        emitUpdate(paneId: string, session: NormalizedSession): void;
      };

      emitter.emitUpdate('pane-1', createEmptySession('claude', 'session-1'));

      expect(computeTopics).not.toHaveBeenCalled();
      expect(testWindow.send).not.toHaveBeenCalledWith(
        'event:topics-updated',
        expect.anything(),
      );
    });

    it('derives an explicit topic-list snapshot directly from current contexts', () => {
      const session = createEmptySession('claude', 'session-1');
      session.messages = [{
        content: 'Investigate terminal performance',
        id: 'message-1',
        toolCalls: [],
        toolResults: [],
        type: 'user',
      }];
      Reflect.set(service, 'contexts', new Map([
        ['pane-1', { getSession: () => session, stop: vi.fn() }],
      ]));

      expect(service.getAllTopics()).toEqual([
        expect.objectContaining({
          paneId: 'pane-1',
          sessionId: 'session-1',
          topics: [expect.objectContaining({ label: 'Investigate terminal performance' })],
        }),
      ]);
    });

    it('publishes future topic updates while the feature is enabled', () => {
      const enabledService = new AgentSessionService(
        '/tmp/test-project',
        undefined,
        undefined,
        undefined,
        undefined,
        () => true,
      );
      const testWindow = makeTestWindow();
      enabledService.setWindow(testWindow.window);
      const emitter = enabledService as unknown as {
        emitUpdate(paneId: string, session: NormalizedSession): void;
      };
      const session = createEmptySession('claude', 'session-1');
      session.messages = [{
        content: 'Optimize topic delivery',
        id: 'message-1',
        toolCalls: [],
        toolResults: [],
        type: 'user',
      }];

      emitter.emitUpdate('pane-1', session);

      expect(testWindow.send).toHaveBeenCalledWith(
        'event:topics-updated',
        expect.objectContaining({
          paneId: 'pane-1',
          topics: expect.objectContaining({
            topics: [expect.objectContaining({ label: 'Optimize topic delivery' })],
          }),
        }),
      );
      enabledService.shutdown();
    });
  });

  describe('shutdown', () => {
    it('clears all contexts', async () => {
      registerMockParser();

      await service.onPaneCreated(makePane({ id: 'muxbase-1', agent: 'claude' }));
      await service.onPaneCreated(makePane({ id: 'muxbase-2', agent: 'claude' }));

      service.shutdown();

      expect(service.getSession('muxbase-1')).toBeNull();
      expect(service.getSession('muxbase-2')).toBeNull();
    });
  });
});

describe('AgentSessionService — pane title harvesting', () => {
  function makeHarvest() {
    const harvests: HarvestedTitle[] = [];
    const titles: string[] = [];
    const service = new AgentSessionService(
      '/tmp/service-root',
      undefined,
      undefined,
      (_paneId, harvested) => {
        harvests.push(harvested);
        titles.push(harvested.title);
      },
    );
    const emit = (session: NormalizedSession, paneId = 'pane-1'): void => {
      (service as unknown as { emitUpdate(paneId: string, session: NormalizedSession): void })
        .emitUpdate(paneId, session);
    };
    return { emit, harvests, service, titles };
  }

  function userMessage(id: string, content: string): NormalizedMessage {
    return { content, id, timestamp: 1, toolCalls: [], toolResults: [], type: 'user' };
  }

  it('harvests a genuine Claude AI title and ignores the first user prompt', () => {
    // Arrange
    const { emit, service, titles } = makeHarvest();
    const session = createEmptySession('claude', 'claude-session');
    session.title = '✳ Introduce Claude Code Capabilities';
    session.aiTitle = 'Fix sidebar rename bug';
    session.messages = [userMessage('msg-1', 'Fix the sidebar rename bug')];

    // Act
    emit(session);

    // Assert
    expect(titles).toEqual(['Fix sidebar rename bug']);
    service.shutdown();
  });

  it('does not turn any Claude user message into a title callback', () => {
    // Arrange
    const { emit, service, titles } = makeHarvest();
    const session = createEmptySession('claude', 'claude-session');
    session.messages = [
      userMessage('msg-1', '<system-reminder>CLAUDE.md was updated</system-reminder>'),
      userMessage('msg-2', 'Caveat: The messages below were generated by the user while running local commands.'),
      userMessage('msg-3', '<local-command-stdout>Set effort level to xhigh</local-command-stdout>'),
      userMessage('msg-4', '<bash-input>git status</bash-input>'),
      userMessage('msg-5', 'Add a typewriter effect to the sidebar'),
    ];

    // Act
    emit(session);

    // Assert
    expect(titles).toEqual([]);
    service.shutdown();
  });

  it('rejects the OpenCode placeholder title and adopts the generated one once it lands', () => {
    // Arrange
    const { emit, service, titles } = makeHarvest();
    const messages = [userMessage('msg-1', 'Investigate flaky terminal tests')];
    const placeholder = createEmptySession('opencode', 'opencode-session');
    placeholder.title = 'New session - 2026-08-03T10:15:00.000Z';
    placeholder.messages = messages;
    const named = createEmptySession('opencode', 'opencode-session');
    named.title = 'Flaky terminal test triage';
    named.messages = messages;

    // Act
    emit(placeholder);
    emit(named);

    // Assert
    expect(titles).toEqual(['Flaky terminal test triage']);
    service.shutdown();
  });

  it('harvests nothing while OpenCode only has a placeholder title and no prompt', () => {
    // Arrange
    const { emit, service, titles } = makeHarvest();
    const session = createEmptySession('opencode', 'opencode-session');
    session.title = 'Child session - 2026-08-03T10:15:00.000Z';

    // Act
    emit(session);

    // Assert
    expect(titles).toEqual([]);
    service.shutdown();
  });

  it('does not claim the current Codex parsed title is native metadata', () => {
    // Arrange
    const { emit, service, titles } = makeHarvest();
    const session = createEmptySession('codex', 'codex-session');
    session.title = 'Codex parsed title';
    session.messages = [userMessage('msg-1', 'Refactor the pane watcher')];

    // Act
    emit(session);

    // Assert
    expect(titles).toEqual([]);
    service.shutdown();
  });

  it('never emits the first user message as a derived title', () => {
    // Arrange
    const { emit, harvests, service } = makeHarvest();
    const session = createEmptySession('claude', 'claude-session');
    session.messages = [userMessage('msg-1', 'see the right pane , for each agent it provide some dummy text , the rest')];

    // Act
    emit(session);

    // Assert
    expect(harvests).toEqual([]);
    service.shutdown();
  });

  it('reports a harvested title once while it stays the same', () => {
    // Arrange
    const { emit, service, titles } = makeHarvest();
    const session = createEmptySession('claude', 'claude-session');
    session.aiTitle = 'Ship the rename fix';
    session.messages = [userMessage('msg-1', 'Please ship the rename fix')];

    // Act
    emit(session);
    emit(session);

    // Assert
    expect(titles).toEqual(['Ship the rename fix']);
    service.shutdown();
  });
});

describe('AgentSessionService.enrichWithCost', () => {
  // End-to-end check: push a real-shape OTLP payload into the receiver, then run
  // enrichWithCost on a NormalizedSession with the matching sessionId; the session
  // should pick up the OTLP cost (no Anthropic-list-price estimate fallback).
  const SESSION_ID = 'a7ffdcf7-8955-4d4f-945d-e5245e21e5ca';

  function makeSession(): NormalizedSession {
    const session = createEmptySession('claude', SESSION_ID);
    session.messages.push({
      id: 'm1',
      type: 'assistant',
      content: 'hello',
      toolCalls: [],
      toolResults: [],
      timestamp: 1_750_000_000_000,
      model: 'claude-opus-4-8',
      tokens: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    return session;
  }

  it('uses OTLP cost when receiver has a record for the session', async () => {
    const { ClaudeCodeOtlpReceiver } = await import('../../src/main/services/agent-session/ClaudeCodeOtlpReceiver.js');
    const receiver = new ClaudeCodeOtlpReceiver();
    receiver.ingestForTesting({
      resourceMetrics: [{
        scopeMetrics: [{
          metrics: [{
            name: 'claude_code.cost.usage',
            sum: {
              dataPoints: [{
                attributes: [
                  { key: 'session.id', value: { stringValue: SESSION_ID } },
                  { key: 'model', value: { stringValue: 'claude-opus-4-8' } },
                ],
                asDouble: 0.4131,
              }],
            },
          }],
        }],
      }],
    });

    const service = new AgentSessionService('/tmp/test', undefined, undefined, undefined, receiver);
    const session = makeSession();
    (service as any).enrichWithCost(session);

    expect(session.metrics.costSource).toBe('otlp');
    expect(session.metrics.costUSD).toBeCloseTo(0.4131, 6);
    expect(session.messages[0].tokens?.costSource).toBe('otlp');
    expect(session.messages[0].tokens?.costUSD).toBeCloseTo(0.4131, 6);
    service.shutdown();
  });

  it('falls back to local estimate when receiver has no record', () => {
    const service = new AgentSessionService('/tmp/test');
    const session = makeSession();
    (service as any).enrichWithCost(session);

    expect(session.metrics.costSource).toBe('estimate');
    // Opus list: 100*$15/M + 50*$75/M = $0.0015 + $0.00375 = $0.00525
    expect(session.metrics.costUSD).toBeCloseTo(0.00525, 6);
    expect(session.messages[0].tokens?.costSource).toBe('estimate');
    service.shutdown();
  });
});
