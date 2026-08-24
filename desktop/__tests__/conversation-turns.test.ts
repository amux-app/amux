import { describe, expect, it } from 'vitest';
import type { MessageType, NormalizedMessage } from '../src/shared/agent-session-types';
import { groupIntoTurns, isRealUserPrompt } from '../src/renderer/lib/conversation-turns';
import { formatSessionOffset } from '../src/renderer/lib/formatters';

function msg(type: MessageType, content: string, timestamp?: number): NormalizedMessage {
  return { id: `${type}-${content.slice(0, 8)}-${timestamp ?? 0}`, type, content, timestamp, toolCalls: [], toolResults: [] };
}

describe('isRealUserPrompt', () => {
  it('accepts genuine text and rejects injected command/system content by content only', () => {
    // Arrange
    const real = msg('user', 'Fix the login bug');
    const injected = [
      msg('user', '<system-reminder>context</system-reminder>'),
      msg('user', '<command-name>/foo</command-name>'),
      msg('user', '<local-command-caveat>x'),
      msg('user', '   '),
    ];

    // Act + Assert
    expect(isRealUserPrompt(real)).toBe(true);
    for (const m of injected) expect(isRealUserPrompt(m)).toBe(false);
  });
});

describe('groupIntoTurns', () => {
  it('pairs each real prompt with its assistant responses until the next prompt', () => {
    // Arrange
    const messages = [
      msg('user', '<system-reminder>skip me</system-reminder>'),
      msg('user', 'first question'),
      msg('assistant', 'first answer'),
      msg('assistant', 'more detail'),
      msg('user', 'second question'),
      msg('assistant', 'second answer'),
    ];

    // Act
    const turns = groupIntoTurns(messages);

    // Assert
    expect(turns).toHaveLength(2);
    expect(turns[0].prompt.content).toBe('first question');
    expect(turns[0].responses.map((r) => r.content)).toEqual(['first answer', 'more detail']);
    expect(turns[1].prompt.content).toBe('second question');
    expect(turns[1].responses.map((r) => r.content)).toEqual(['second answer']);
  });
});

describe('formatSessionOffset', () => {
  it('formats elapsed time from session start and handles missing values', () => {
    // Arrange
    const start = 1_000_000;

    // Act + Assert
    expect(formatSessionOffset(start + 45_000, start)).toBe('45s');
    expect(formatSessionOffset(start + 123_000, start)).toBe('2m 3s');
    expect(formatSessionOffset(start + 120_000, start)).toBe('2m');
    expect(formatSessionOffset(undefined, start)).toBe('');
  });
});
