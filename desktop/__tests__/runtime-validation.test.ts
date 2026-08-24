import { describe, expect, it } from 'vitest';
import { createEmptyMetrics } from '../src/shared/agent-session-types';
import {
  sanitizeAgentSessionUpdatedEvent,
  sanitizeFileListResponse,
  sanitizeFileMutationResponse,
  sanitizeFileReadResponse,
  sanitizeFileWriteResponse,
  sanitizeFormatDocumentResponse,
  sanitizePaneList,
  sanitizePaneActivityChangedEvent,
  sanitizePaneActivitySnapshot,
  sanitizePaneTopicsList,
  sanitizePaneTopicsUpdatedEvent,
  sanitizeProjectTextSearchResults,
} from '../src/renderer/lib/runtimeValidation';

describe('runtimeValidation', () => {
  const activity = {
    activityRevision: 3,
    adapterCapabilities: ['turnIds', 'backgroundEntities'],
    adapterHealth: 'healthy',
    adapterSupport: 'full',
    adapterVersion: '1.0.0',
    certainty: 'confirmed',
    liveness: 'running',
    openBackgroundWork: [{ entityId: 'task-1', kind: 'task', mutating: false, sinceWallMs: 10 }],
    origin: 'adapter',
    paneIncarnationId: 'incarnation-1',
    sessionId: 'session-1',
    sinceWallMs: 10,
    state: 'idle',
    turnId: 'turn-1',
    waitReason: undefined,
  };

  it('validates pane activity snapshots and changed events with revision metadata', () => {
    const snapshot = sanitizePaneActivitySnapshot({
      epochId: 'epoch-1',
      panes: { 'pane-1': activity },
      revision: 4,
    });

    expect(snapshot).toEqual({
      epochId: 'epoch-1',
      panes: { 'pane-1': activity },
      revision: 4,
    });
    expect(
      sanitizePaneActivityChangedEvent({
        changes: [{ activity, paneId: 'pane-1' }],
        epochId: 'epoch-1',
        removedPaneIds: ['pane-old'],
        revision: 5,
      }),
    ).toEqual({
      changes: [{ activity, paneId: 'pane-1' }],
      epochId: 'epoch-1',
      removedPaneIds: ['pane-old'],
      revision: 5,
    });
  });

  it.each([
    ['invalid snapshot epoch', { epochId: 42, panes: {}, revision: 1 }],
    ['negative snapshot revision', { epochId: 'epoch', panes: {}, revision: -1 }],
    [
      'invalid activity state',
      {
        epochId: 'epoch',
        panes: { pane: { ...activity, state: 'busy' } },
        revision: 1,
      },
    ],
    [
      'invalid background work',
      {
        epochId: 'epoch',
        panes: {
          pane: {
            ...activity,
            openBackgroundWork: [{ ...activity.openBackgroundWork[0], mutating: 'yes' }],
          },
        },
        revision: 1,
      },
    ],
  ])('rejects %s', (_name, payload) => {
    expect(sanitizePaneActivitySnapshot(payload)).toBeNull();
  });

  it('rejects malformed changed events rather than partially applying them', () => {
    expect(
      sanitizePaneActivityChangedEvent({
        changes: [{ activity, paneId: 42 }],
        epochId: 'epoch-1',
        revision: 1,
      }),
    ).toBeNull();
    expect(
      sanitizePaneActivityChangedEvent({
        changes: [],
        epochId: 'epoch-1',
        removedPaneIds: ['pane-1', 2],
        revision: 1,
      }),
    ).toBeNull();
  });

  it('keeps only valid panes from a pane list payload', () => {
    const panes = sanitizePaneList([
      {
        id: 'pane-1',
        paneId: '%1',
        prompt: 'hello',
        slug: 'pane-1',
      },
      {
        id: 'pane-2',
        paneId: 42,
        prompt: 'bad',
        slug: 'pane-2',
      },
      {
        id: 'pane-3',
        paneId: '%3',
        prompt: 'bad title',
        slug: 'pane-3',
        title: 42,
      },
    ]);

    expect(panes).toEqual([
      {
        id: 'pane-1',
        paneId: '%1',
        prompt: 'hello',
        slug: 'pane-1',
      },
    ]);
  });

  it('keeps review metadata with a durable source worktree path', () => {
    // Arrange
    const reviewPane = {
      id: 'review-pane',
      paneId: '%2',
      prompt: 'review',
      role: 'review',
      review: {
        changedFiles: 2,
        handedOffAt: 456,
        reviewId: 'review-1',
        sourcePaneId: 'source-pane',
        sourceSlug: 'feature-pane',
        sourceWorktreePath: '/repo/worktrees/feature-pane',
        startedAt: 123,
      },
      slug: 'review-feature-pane',
    };

    // Act
    const panes = sanitizePaneList([reviewPane]);

    // Assert
    expect(panes).toEqual([reviewPane]);
  });

  it('accepts the complete persisted pane metadata contract', () => {
    const pane = {
      agent: 'claude',
      claudeRenderer: 'classic',
      effort: 'high',
      id: 'pane-1',
      model: 'opus',
      paneId: '%1',
      prompt: 'hello',
      slug: 'pane-1',
      sourceBacklogId: 'backlog-7',
      terminalFixedCols: 100,
    };

    expect(sanitizePaneList([pane])).toEqual([pane]);
  });

  it('keeps a legacy Claude pane that predates the renderer field', () => {
    const pane = {
      agent: 'claude',
      id: 'pane-1',
      paneId: '%1',
      prompt: 'hello',
      slug: 'pane-1',
    };

    expect(sanitizePaneList([pane])).toEqual([pane]);
  });

  it('keeps a valid persisted Pi pane', () => {
    const pane = {
      agent: 'pi',
      effort: 'high',
      id: 'pane-pi',
      model: 'openai/gpt-5.5',
      paneId: '%4',
      prompt: 'hello',
      slug: 'pane-pi',
    };

    expect(sanitizePaneList([pane])).toEqual([pane]);
  });

  it('rejects noncanonical persisted widths for classic Claude panes', () => {
    const panes = [2, 99, 101, 112, 1000].map((terminalFixedCols, index) => ({
      agent: 'claude',
      claudeRenderer: 'classic',
      id: `pane-${index}`,
      paneId: `%${index}`,
      prompt: 'hello',
      slug: `pane-${index}`,
      terminalFixedCols,
    }));

    expect(sanitizePaneList(panes)).toEqual([]);
  });

  it.each([
    ['unknown Claude renderer', { agent: 'claude', claudeRenderer: 'inline', terminalFixedCols: 100 }],
    ['classic Claude without fixed columns', { agent: 'claude', claudeRenderer: 'classic' }],
    ['classic Claude with zero columns', { agent: 'claude', claudeRenderer: 'classic', terminalFixedCols: 0 }],
    ['classic Claude below the IPC column minimum', { agent: 'claude', claudeRenderer: 'classic', terminalFixedCols: 1 }],
    ['classic Claude above the IPC column maximum', { agent: 'claude', claudeRenderer: 'classic', terminalFixedCols: 1001 }],
    ['classic Claude with fractional columns', { agent: 'claude', claudeRenderer: 'classic', terminalFixedCols: 99.5 }],
    ['classic Claude with a noncanonical width', { agent: 'claude', claudeRenderer: 'classic', terminalFixedCols: 112 }],
    ['fullscreen Claude with fixed columns', { agent: 'claude', claudeRenderer: 'fullscreen', terminalFixedCols: 100 }],
    ['non-Claude pane with Claude renderer', { agent: 'codex', claudeRenderer: 'classic' }],
    ['non-Claude pane with fixed columns', { agent: 'opencode', terminalFixedCols: 100 }],
    ['shell pane with fixed columns', { type: 'shell', terminalFixedCols: 100 }],
    ['shell pane with an agent', { type: 'shell', agent: 'codex' }],
    ['non-string model', { agent: 'codex', model: 42 }],
    ['non-string effort', { agent: 'opencode', effort: false }],
    ['non-string source backlog id', { sourceBacklogId: 7 }],
  ])('rejects %s', (_name, invalidFields) => {
    const pane = {
      id: 'pane-1',
      paneId: '%1',
      prompt: 'hello',
      slug: 'pane-1',
      ...invalidFields,
    };

    expect(sanitizePaneList([pane])).toEqual([]);
  });

  it('keeps a pane carrying valid duel metadata', () => {
    // Arrange
    const duelPane = {
      duel: {
        groupId: 'duel-1',
        prompt: 'build a login form',
        role: 'a',
        siblingPaneId: 'pane-b',
      },
      id: 'pane-a',
      paneId: '%1',
      prompt: 'build a login form',
      slug: 'login-form-a',
    };

    // Act
    const panes = sanitizePaneList([duelPane]);

    // Assert
    expect(panes).toEqual([duelPane]);
  });

  it.each([
    ['invalid duel role', { groupId: 'duel-1', prompt: 'p', role: 'c' }],
    ['missing duel groupId', { prompt: 'p', role: 'a' }],
    ['empty duel groupId', { groupId: '', prompt: 'p', role: 'a' }],
    ['empty duel prompt', { groupId: 'duel-1', prompt: '   ', role: 'a' }],
    ['non-string duel prompt', { groupId: 'duel-1', prompt: 42, role: 'a' }],
    ['empty duel siblingPaneId', { groupId: 'duel-1', prompt: 'p', role: 'a', siblingPaneId: '' }],
    ['non-string duel siblingPaneId', { groupId: 'duel-1', prompt: 'p', role: 'a', siblingPaneId: 7 }],
  ])('rejects a pane with %s', (_name, duel) => {
    const pane = {
      duel,
      id: 'pane-a',
      paneId: '%1',
      prompt: 'p',
      slug: 'pane-a',
    };

    expect(sanitizePaneList([pane])).toEqual([]);
  });

  it('rejects a non-numeric review handoff timestamp', () => {
    const pane = {
      id: 'review-pane',
      paneId: '%2',
      prompt: 'review',
      role: 'review',
      review: {
        changedFiles: 2,
        handedOffAt: 'later',
        reviewId: 'review-1',
        sourcePaneId: 'source-pane',
        sourceSlug: 'feature-pane',
        startedAt: 123,
      },
      slug: 'review-feature-pane',
    };

    expect(sanitizePaneList([pane])).toEqual([]);
  });

  it('rejects malformed file read responses', () => {
    expect(sanitizeFileReadResponse({
      kind: 'editable-text',
      content: 'ok',
      contentVersion: 'abc123',
      encoding: 'utf8',
      hasBom: false,
      eol: 'lf',
    })).toEqual({
      kind: 'editable-text',
      content: 'ok',
      contentVersion: 'abc123',
      encoding: 'utf8',
      hasBom: false,
      eol: 'lf',
    });
    expect(sanitizeFileReadResponse({ kind: 'editable-text', content: 'ok' })).toBeNull();
    expect(sanitizeFileReadResponse({
      kind: 'unsupported',
      reason: 'binary',
      sizeBytes: 3,
    })).toEqual({ kind: 'unsupported', reason: 'binary', sizeBytes: 3 });
  });

  it('validates file write response identities and hashes', () => {
    expect(sanitizeFileWriteResponse({
      success: true,
      contentVersion: 'next-hash',
      documentVersion: 2,
      editorSessionId: 'session-1',
      saveSequence: 3,
    })).toEqual({
      success: true,
      contentVersion: 'next-hash',
      documentVersion: 2,
      editorSessionId: 'session-1',
      saveSequence: 3,
    });
    expect(sanitizeFileWriteResponse({ success: true, contentVersion: 'hash' })).toBeNull();
  });

  it('validates bounded formatter changes and request identity', () => {
    expect(sanitizeFormatDocumentResponse({
      success: true,
      changes: [{ from: 1, to: 2, insert: 'x' }],
      documentVersion: 3,
      editorSessionId: 'session-1',
      fileKey: 'file-key',
      requestId: 'request-1',
      status: 'formatted',
    })).toEqual({
      success: true,
      changes: [{ from: 1, to: 2, insert: 'x' }],
      documentVersion: 3,
      editorSessionId: 'session-1',
      fileKey: 'file-key',
      requestId: 'request-1',
      status: 'formatted',
    });
    expect(sanitizeFormatDocumentResponse({
      success: true,
      changes: [{ from: -1, to: 2, insert: 'x' }],
      documentVersion: 3,
      editorSessionId: 'session-1',
      fileKey: 'file-key',
      requestId: 'request-1',
      status: 'formatted',
    })).toBeNull();
  });

  it('preserves valid file mutation conflict types and drops unknown values', () => {
    expect(sanitizeFileMutationResponse({
      success: false,
      conflict: true,
      conflictType: 'deleted',
    })).toEqual({
      success: false,
      conflict: true,
      conflictType: 'deleted',
      currentMtimeMs: undefined,
      error: undefined,
      mtimeMs: undefined,
    });
    expect(sanitizeFileMutationResponse({
      success: false,
      conflict: true,
      conflictType: 'unexpected',
    })?.conflictType).toBeUndefined();
  });

  it('filters invalid file list entries', () => {
    expect(sanitizeFileListResponse({
      entries: [
        { name: 'src', path: 'src', isDirectory: true },
        { name: 'broken', path: 42, isDirectory: false },
      ],
    })).toEqual({
      entries: [{ name: 'src', path: 'src', isDirectory: true }],
      error: undefined,
    });
  });

  it('validates agent session update events before they reach stores', () => {
    const event = sanitizeAgentSessionUpdatedEvent({
      paneId: 'pane-1',
      session: {
        agent: 'claude',
        aiTitle: 'Clean title',
        sessionId: 'session-1',
        messages: [],
        metrics: createEmptyMetrics(),
        compactionEvents: [],
        subagents: [],
        isOngoing: false,
      },
    });

    expect(event?.paneId).toBe('pane-1');
    expect(sanitizeAgentSessionUpdatedEvent({ paneId: 'pane-1', session: { sessionId: 'missing-agent' } })).toBeNull();
    expect(sanitizeAgentSessionUpdatedEvent({
      paneId: 'pane-1',
      session: {
        agent: 'claude',
        aiTitle: 42,
        sessionId: 'session-1',
        messages: [],
        metrics: createEmptyMetrics(),
        compactionEvents: [],
        subagents: [],
        isOngoing: false,
      },
    })).toBeNull();
  });

  it('filters malformed topic list entries', () => {
    const validPaneTopics = {
      paneId: 'pane-1',
      sessionId: 'session-1',
      agent: 'claude',
      topics: [
        {
          id: 'session-1:0',
          label: 'Fix terminal geometry',
          refined: true,
          messageStartIndex: 0,
          messageEndIndex: 2,
          messageCount: 3,
          startTime: 1,
          endTime: 2,
        },
      ],
      updatedAt: 10,
    };

    const result = sanitizePaneTopicsList([
      validPaneTopics,
      { ...validPaneTopics, paneId: 42 },
      {
        ...validPaneTopics,
        paneId: 'pane-2',
        topics: [{ ...validPaneTopics.topics[0], messageEndIndex: 0, messageStartIndex: 1 }],
      },
    ]);

    expect(result).toEqual([validPaneTopics]);
  });

  it('validates topic update event identity before store writes', () => {
    const topics = {
      paneId: 'pane-1',
      sessionId: 'session-1',
      agent: 'codex',
      topics: [
        {
          id: 'session-1:0',
          label: 'Review branch quality',
          refined: false,
          messageStartIndex: 0,
          messageEndIndex: 0,
          messageCount: 1,
        },
      ],
      updatedAt: 10,
    };

    expect(sanitizePaneTopicsUpdatedEvent({ paneId: 'pane-1', topics })).toEqual({ paneId: 'pane-1', topics });
    expect(sanitizePaneTopicsUpdatedEvent({ paneId: 'pane-2', topics })).toBeNull();
    expect(sanitizePaneTopicsUpdatedEvent({ paneId: 'pane-1', topics: { ...topics, updatedAt: 'later' } })).toBeNull();
  });

  it('caps and filters project text search results', () => {
    const payload = Array.from({ length: 55 }, (_, index) => ({
      rootPath: '/repo',
      path: `src/file-${index}.ts`,
      filename: `file-${index}.ts`,
      lineNumber: index + 1,
      lineContent: 'match',
    }));
    payload.push({ rootPath: '/repo', path: 'broken.ts', filename: 'broken.ts', lineNumber: 'oops', lineContent: 'bad' } as never);

    const results = sanitizeProjectTextSearchResults(payload);

    expect(results).toHaveLength(50);
    expect(results?.[0]).toEqual({
      rootPath: '/repo',
      path: 'src/file-0.ts',
      filename: 'file-0.ts',
      lineNumber: 1,
      lineContent: 'match',
    });
  });
});
