import { describe, expect, it } from 'vitest';
import { computeSessionDisplayMetrics, getUsageSnapshot } from '../../src/shared/agent-session-display-metrics';
import { createEmptySession, type NormalizedMessage } from '../../src/shared/agent-session-types';

function msg(overrides: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    type: overrides.type ?? 'assistant',
    content: overrides.content ?? '',
    thinkingContent: overrides.thinkingContent,
    tokens: overrides.tokens,
    attribution: overrides.attribution,
    toolCalls: overrides.toolCalls ?? [],
    toolResults: overrides.toolResults ?? [],
    timestamp: overrides.timestamp,
  };
}

describe('agent session display metrics', () => {
  it('counts prompts separately from internal events/tool results', () => {
    const session = createEmptySession('claude', 's1');
    session.messages = [
      msg({ type: 'user', content: 'create small node app' }),
      msg({ type: 'assistant', toolCalls: [{ id: 't1', name: 'Bash', input: {} }] }),
      msg({ type: 'tool_result', toolResults: [{ toolCallId: 't1', content: 'ok', isError: false }] }),
      msg({
        type: 'assistant',
        content: 'Done',
        tokens: {
          inputTokens: 3,
          outputTokens: 50,
          cacheReadTokens: 120,
          cacheCreationTokens: 10,
        },
      }),
    ];

    const metrics = computeSessionDisplayMetrics(session);

    expect(metrics.promptCount).toBe(1);
    expect(metrics.eventCount).toBe(4);
    expect(metrics.assistantTurnCount).toBe(2);
    expect(metrics.conversationTurnCount).toBe(2); // user + first assistant after prompt
    expect(metrics.latestAssistantUsage?.contextTokens).toBe(133);
    expect(metrics.latestAssistantUsage?.totalUsageTokens).toBe(183);
  });

  it('computes usage snapshot with cache tokens', () => {
    const usage = getUsageSnapshot({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
    });

    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
      contextTokens: 80,
      totalUsageTokens: 100,
    });
  });
});
