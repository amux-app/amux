import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeLogParser } from '../../src/main/services/parsing/ClaudeLogParser';
import { CodexLogParser } from '../../src/main/services/parsing/CodexLogParser';

const tempDirs: string[] = [];

function writeJsonl(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'muxbase-parser-'));
  tempDirs.push(dir);
  const filePath = join(dir, 'session.jsonl');
  writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n'));
  return filePath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('session turn-state parsers', () => {
  it('Claude parser marks AskUserQuestion turns as awaiting input (not review-ready)', async () => {
    const filePath = writeJsonl([
      {
        type: 'user',
        timestamp: '2026-02-26T12:00:00.000Z',
        message: { role: 'user', content: 'Start task' },
      },
      {
        type: 'assistant',
        timestamp: '2026-02-26T12:00:01.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'AskUserQuestion',
              input: {
                questions: [{ question: 'Where should I create the app?' }],
              },
            },
          ],
        },
      },
    ]);

    const session = await new ClaudeLogParser().parseSession(filePath);

    expect(session.awaitingUserInput).toBe(true);
    expect(session.turnCompleted).toBe(false);
    expect(session.pendingUserQuestion).toContain('Where should I create');
  });

  it('Claude parser marks turn as complete after turn_duration marker', async () => {
    const filePath = writeJsonl([
      {
        type: 'user',
        timestamp: '2026-02-26T12:00:00.000Z',
        message: { role: 'user', content: 'Start task' },
      },
      {
        type: 'assistant',
        timestamp: '2026-02-26T12:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done.' }],
        },
      },
      {
        type: 'system',
        subtype: 'turn_duration',
        timestamp: '2026-02-26T12:00:03.000Z',
        durationMs: 1200,
      },
    ]);

    const session = await new ClaudeLogParser().parseSession(filePath);

    expect(session.awaitingUserInput).toBe(false);
    expect(session.turnCompleted).toBe(true);
    expect(session.isOngoing).toBe(false);
  });

  it('Claude parser marks turn complete from assistant stop_reason=end_turn', async () => {
    const filePath = writeJsonl([
      {
        type: 'user',
        timestamp: '2026-03-03T14:11:58.602Z',
        message: { role: 'user', content: 'create nodejs with html hello world' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-03T14:12:26.633Z',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Done. Three files created.' }],
        },
      },
    ]);

    const session = await new ClaudeLogParser().parseSession(filePath);

    expect(session.awaitingUserInput).toBe(false);
    expect(session.turnCompleted).toBe(true);
    expect(session.isOngoing).toBe(false);
  });

  it('Codex parser marks request_user_input tool calls as awaiting input', async () => {
    const filePath = writeJsonl([
      {
        type: 'session_meta',
        timestamp: '2026-02-26T12:00:00.000Z',
        payload: { id: 'codex-session', timestamp: '2026-02-26T12:00:00.000Z' },
      },
      {
        type: 'event_msg',
        timestamp: '2026-02-26T12:00:01.000Z',
        payload: { type: 'task_started', turn_id: 't1' },
      },
      {
        type: 'response_item',
        timestamp: '2026-02-26T12:00:02.000Z',
        payload: {
          type: 'function_call',
          name: 'request_user_input',
          arguments: JSON.stringify({ question: 'Which file should I edit?' }),
          call_id: 'call_1',
        },
      },
    ]);

    const session = await new CodexLogParser().parseSession(filePath);

    expect(session.awaitingUserInput).toBe(true);
    expect(session.turnCompleted).toBe(false);
    expect(session.pendingUserQuestion).toContain('Which file');
  });

  it('Codex parser clears pending questions when a request_user_input call is answered or ignored', async () => {
    // Arrange
    const filePath = writeJsonl([
      {
        type: 'session_meta',
        timestamp: '2026-02-26T12:00:00.000Z',
        payload: { id: 'codex-session', timestamp: '2026-02-26T12:00:00.000Z' },
      },
      {
        type: 'event_msg',
        timestamp: '2026-02-26T12:00:01.000Z',
        payload: { type: 'task_started', turn_id: 't1' },
      },
      {
        type: 'response_item',
        timestamp: '2026-02-26T12:00:02.000Z',
        payload: {
          type: 'function_call',
          name: 'request_user_input',
          arguments: JSON.stringify({ question: 'Use the existing plan?' }),
          call_id: 'call_question',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-02-26T12:00:03.000Z',
        payload: {
          type: 'function_call_output',
          call_id: 'call_question',
          output: 'ignored',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-02-26T12:00:04.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Continuing after ignored question.' }],
        },
      },
    ]);

    // Act
    const session = await new CodexLogParser().parseSession(filePath);

    // Assert
    expect(session.awaitingUserInput).toBe(false);
    expect(session.pendingUserQuestion).toBeUndefined();
    expect(session.messages.at(-1)?.content).toBe('Continuing after ignored question.');
  });

  it('Codex parser clears pending questions when an interrupted turn starts a new user message', async () => {
    // Arrange
    const filePath = writeJsonl([
      {
        type: 'session_meta',
        timestamp: '2026-02-26T12:00:00.000Z',
        payload: { id: 'codex-session', timestamp: '2026-02-26T12:00:00.000Z' },
      },
      {
        type: 'event_msg',
        timestamp: '2026-02-26T12:00:01.000Z',
        payload: { type: 'task_started', turn_id: 't1' },
      },
      {
        type: 'response_item',
        timestamp: '2026-02-26T12:00:02.000Z',
        payload: {
          type: 'function_call',
          name: 'request_user_input',
          arguments: JSON.stringify({ question: 'Which plan should I use?' }),
          call_id: 'call_question',
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-02-26T12:00:03.000Z',
        payload: { type: 'turn_aborted', turn_id: 't1' },
      },
      {
        type: 'event_msg',
        timestamp: '2026-02-26T12:00:04.000Z',
        payload: { type: 'task_started', turn_id: 't2' },
      },
      {
        type: 'response_item',
        timestamp: '2026-02-26T12:00:05.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Continue without answering.' }],
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-02-26T12:00:05.000Z',
        payload: { type: 'user_message', turn_id: 't2' },
      },
      {
        type: 'response_item',
        timestamp: '2026-02-26T12:00:06.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Continuing after interrupt.' }],
        },
      },
    ]);

    // Act
    const session = await new CodexLogParser().parseSession(filePath);

    // Assert
    expect(session.awaitingUserInput).toBe(false);
    expect(session.pendingUserQuestion).toBeUndefined();
    expect(session.messages.at(-1)?.content).toBe('Continuing after interrupt.');
  });

  it('Codex parser keeps only recorded user messages when synthetic context is present', async () => {
    const filePath = writeJsonl([
      {
        type: 'session_meta',
        timestamp: '2026-02-26T12:00:00.000Z',
        payload: { id: 'codex-session', timestamp: '2026-02-26T12:00:00.000Z' },
      },
      {
        type: 'response_item',
        timestamp: '2026-02-26T12:00:01.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'AGENTS.md instructions for /repo' }],
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-02-26T12:00:02.000Z',
        payload: { type: 'user_message', message: 'Fix pane text rendering' },
      },
      {
        type: 'response_item',
        timestamp: '2026-02-26T12:00:02.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Fix pane text rendering\n\n<image>\n</image>' }],
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-02-26T12:00:03.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Done.' }],
        },
      },
    ]);

    const session = await new CodexLogParser().parseSession(filePath);

    expect(session.messages.map((message) => message.content)).toEqual([
      'Fix pane text rendering\n\n<image>\n</image>',
      'Done.',
    ]);
    expect(session.metrics.messageCount).toBe(2);
  });

  it('Codex parser marks task_complete as review-ready turn completion', async () => {
    const filePath = writeJsonl([
      {
        type: 'session_meta',
        timestamp: '2026-02-26T12:00:00.000Z',
        payload: { id: 'codex-session', timestamp: '2026-02-26T12:00:00.000Z' },
      },
      {
        type: 'event_msg',
        timestamp: '2026-02-26T12:00:01.000Z',
        payload: { type: 'task_started', turn_id: 't1' },
      },
      {
        type: 'response_item',
        timestamp: '2026-02-26T12:00:02.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Implemented.' }],
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-02-26T12:00:03.000Z',
        payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'Implemented.' },
      },
    ]);

    const session = await new CodexLogParser().parseSession(filePath);

    expect(session.awaitingUserInput).toBe(false);
    expect(session.turnCompleted).toBe(true);
    expect(session.isOngoing).toBe(false);
  });
});
