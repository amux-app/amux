import { describe, it, expect } from 'vitest';
import type {
  NormalizedMessage,
  CompactionEvent,
  TokenAttribution,
} from '../../src/shared/agent-session-types';
import {
  createEmptySession,
  createEmptyMetrics,
} from '../../src/shared/agent-session-types';

function makeMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 6)}`,
    type: 'assistant',
    content: '',
    toolCalls: [],
    toolResults: [],
    ...overrides,
  };
}

describe('Compaction event detection (integration shape)', () => {
  it('detects compaction when input tokens drop >30%', () => {
    const session = createEmptySession('claude', 'test');
    session.messages = [
      makeMessage({
        type: 'assistant',
        tokens: { inputTokens: 50_000, outputTokens: 1000 },
      }),
      makeMessage({
        type: 'assistant',
        tokens: { inputTokens: 30_000, outputTokens: 1000 },
      }),
    ];
    // Simulate the detection logic (same as ClaudeLogParser.detectCompactionEvents)
    const events: CompactionEvent[] = [];
    let prevInput: number | null = null;
    for (let i = 0; i < session.messages.length; i++) {
      const msg = session.messages[i];
      if (msg.type !== 'assistant' || !msg.tokens) continue;
      const input = msg.tokens.inputTokens;
      if (prevInput !== null && input < prevInput * 0.7 && prevInput > 10_000) {
        events.push({ turnIndex: i, tokensBefore: prevInput, tokensAfter: input });
      }
      prevInput = input;
    }
    expect(events).toHaveLength(1);
    expect(events[0].tokensBefore).toBe(50_000);
    expect(events[0].tokensAfter).toBe(30_000);
  });

  it('does not flag small drops (<30%)', () => {
    const session = createEmptySession('claude', 'test');
    session.messages = [
      makeMessage({
        type: 'assistant',
        tokens: { inputTokens: 50_000, outputTokens: 1000 },
      }),
      makeMessage({
        type: 'assistant',
        tokens: { inputTokens: 40_000, outputTokens: 1000 },
      }),
    ];
    const events: CompactionEvent[] = [];
    let prevInput: number | null = null;
    for (let i = 0; i < session.messages.length; i++) {
      const msg = session.messages[i];
      if (msg.type !== 'assistant' || !msg.tokens) continue;
      const input = msg.tokens.inputTokens;
      if (prevInput !== null && input < prevInput * 0.7 && prevInput > 10_000) {
        events.push({ turnIndex: i, tokensBefore: prevInput, tokensAfter: input });
      }
      prevInput = input;
    }
    expect(events).toHaveLength(0);
  });

  it('ignores small token counts (<10k)', () => {
    const events: CompactionEvent[] = [];
    let prevInput: number | null = 5000;
    const input = 1000;
    if (prevInput !== null && input < prevInput * 0.7 && prevInput > 10_000) {
      events.push({ turnIndex: 1, tokensBefore: prevInput, tokensAfter: input });
    }
    expect(events).toHaveLength(0);
  });
});

describe('Token attribution shape', () => {
  it('all attribution categories sum to meaningful total', () => {
    const attr: TokenAttribution = {
      systemPrompt: 5000,
      conversationHistory: 10000,
      toolResults: 15000,
      cacheRead: 3000,
    };
    const total = attr.systemPrompt + attr.conversationHistory + attr.toolResults;
    expect(total).toBe(30000);
    expect(attr.cacheRead).toBeLessThan(total);
  });

  it('messages can carry attribution', () => {
    const msg = makeMessage({
      tokens: { inputTokens: 20000, outputTokens: 500 },
      attribution: {
        systemPrompt: 5000,
        conversationHistory: 8000,
        toolResults: 7000,
        cacheRead: 0,
      },
    });
    expect(msg.attribution).toBeDefined();
    expect(msg.attribution!.systemPrompt + msg.attribution!.conversationHistory + msg.attribution!.toolResults).toBe(20000);
  });
});

describe('Subagent session shape', () => {
  it('subagent has its own metrics', () => {
    const session = createEmptySession('claude', 'test');
    session.subagents = [{
      parentToolCallId: 'toolu_abc',
      description: 'Explore codebase',
      messages: [
        makeMessage({ type: 'user', content: 'Find auth files' }),
        makeMessage({ type: 'assistant', content: 'Found 3 files' }),
      ],
      metrics: {
        ...createEmptyMetrics(),
        messageCount: 2,
        totalTokens: 1500,
        inputTokens: 1000,
        outputTokens: 500,
      },
    }];
    expect(session.subagents).toHaveLength(1);
    expect(session.subagents[0].metrics.messageCount).toBe(2);
    expect(session.subagents[0].description).toBe('Explore codebase');
  });

  it('subagent messages include tool calls', () => {
    const subMsg = makeMessage({
      type: 'assistant',
      toolCalls: [{ id: 'tc-1', name: 'Read', input: { file_path: '/foo/bar.ts' } }],
    });
    expect(subMsg.toolCalls).toHaveLength(1);
    expect(subMsg.toolCalls[0].name).toBe('Read');
  });
});

describe('Session with all enhanced fields', () => {
  it('complete session has compaction, subagents, and attributed messages', () => {
    const session = createEmptySession('claude', 'full-test');

    session.messages = [
      makeMessage({
        type: 'assistant',
        tokens: { inputTokens: 20000, outputTokens: 500 },
        attribution: { systemPrompt: 8000, conversationHistory: 5000, toolResults: 7000, cacheRead: 0 },
      }),
      makeMessage({
        type: 'assistant',
        tokens: { inputTokens: 50000, outputTokens: 1000 },
        attribution: { systemPrompt: 8000, conversationHistory: 15000, toolResults: 27000, cacheRead: 5000 },
      }),
      makeMessage({
        type: 'assistant',
        tokens: { inputTokens: 25000, outputTokens: 800 },
        attribution: { systemPrompt: 8000, conversationHistory: 7000, toolResults: 10000, cacheRead: 8000 },
      }),
    ];

    session.compactionEvents = [{
      turnIndex: 2,
      tokensBefore: 50000,
      tokensAfter: 25000,
      timestamp: Date.now(),
    }];

    session.subagents = [{
      parentToolCallId: 'toolu_xyz',
      description: 'Research',
      messages: [makeMessage({ type: 'user', content: 'Find X' })],
      metrics: { ...createEmptyMetrics(), messageCount: 1 },
    }];

    session.metrics = {
      totalTokens: 97300,
      inputTokens: 95000,
      outputTokens: 2300,
      cacheReadTokens: 13000,
      messageCount: 3,
      toolCallCount: 0,
    };

    expect(session.compactionEvents).toHaveLength(1);
    expect(session.subagents).toHaveLength(1);
    expect(session.messages.every((m) => m.attribution !== undefined)).toBe(true);
    expect(session.metrics.totalTokens).toBe(97300);
  });
});
