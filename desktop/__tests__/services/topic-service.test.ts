import { describe, expect, it } from 'vitest';
import { TopicService } from '../../src/main/services/topics/TopicService';
import type { AgentType, NormalizedMessage, NormalizedSession } from '../../src/shared/agent-session-types';
import { createEmptyMetrics, createEmptySession } from '../../src/shared/agent-session-types';

function makeMessage(
  id: string,
  type: NormalizedMessage['type'],
  content: string,
  timestamp?: number,
): NormalizedMessage {
  return {
    id,
    type,
    content,
    timestamp,
    toolCalls: [],
    toolResults: [],
  };
}

function makeSession(messages: NormalizedMessage[], agent: AgentType = 'claude'): NormalizedSession {
  return {
    ...createEmptySession(agent, 'session-1'),
    messages,
    metrics: {
      ...createEmptyMetrics(),
      messageCount: messages.length,
    },
  };
}

describe('TopicService', () => {
  it('segments topics at user-turn boundaries', () => {
    const service = new TopicService();
    const session = makeSession([
      makeMessage('m1', 'user', 'Fix the terminal geometry on launch', 1),
      makeMessage('m2', 'assistant', 'Working on it', 2),
      makeMessage('m3', 'user', 'Now review the branch quality', 3),
      makeMessage('m4', 'assistant', 'Review complete', 4),
    ]);

    const topics = service.computeTopics(session);

    expect(topics).toEqual([
      {
        id: 'session-1:0',
        label: 'Fix the terminal geometry on launch',
        refined: false,
        messageStartIndex: 0,
        messageEndIndex: 1,
        messageCount: 2,
        startTime: 1,
        endTime: 2,
      },
      {
        id: 'session-1:2',
        label: 'Now review the branch quality',
        refined: false,
        messageStartIndex: 2,
        messageEndIndex: 3,
        messageCount: 2,
        startTime: 3,
        endTime: 4,
      },
    ]);
  });

  it('builds a short local label from the first non-empty prompt line', () => {
    const service = new TopicService();
    const session = makeSession([
      makeMessage(
        'm1',
        'user',
        '\nFix the terminal geometry on launch without changing existing pane behavior today',
      ),
    ]);

    expect(service.computeTopics(session)[0]).toMatchObject({
      label: 'Fix the terminal geometry on launch without changing',
      refined: false,
    });
  });

  it('bounds a single-token prompt label to 80 characters', () => {
    const service = new TopicService();
    const session = makeSession([
      makeMessage('m1', 'user', 'x'.repeat(5000)),
    ]);

    expect(service.computeTopics(session)[0]?.label).toHaveLength(80);
  });

  it('does not split a Unicode code point at the label boundary', () => {
    const service = new TopicService();
    const session = makeSession([
      makeMessage('m1', 'user', `${'x'.repeat(79)}😀tail`),
    ]);

    const label = service.computeTopics(session)[0]?.label ?? '';

    expect(label).toBe(`${'x'.repeat(79)}😀`);
    expect(Array.from(label)).toHaveLength(80);
  });
});
