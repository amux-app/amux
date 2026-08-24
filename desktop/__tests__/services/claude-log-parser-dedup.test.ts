import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeLogParser } from '../../src/main/services/parsing/ClaudeLogParser';

const TURN_A_USAGE = {
  input_tokens: 6,
  output_tokens: 507,
  cache_creation_input_tokens: 30_600,
  cache_read_input_tokens: 69_029,
};

const TURN_B_USAGE = {
  input_tokens: 1,
  output_tokens: 1_000,
  cache_creation_input_tokens: 100,
  cache_read_input_tokens: 50_000,
};

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJsonl(filePath: string, lines: Array<Record<string, unknown>>): void {
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function assistantEntry(
  uuid: string,
  parentUuid: string | null,
  messageId: string,
  block: Record<string, unknown>,
  usage: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    timestamp: new Date().toISOString(),
    message: {
      id: messageId,
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [block],
      usage,
      stop_reason: 'tool_use',
    },
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('ClaudeLogParser token deduplication by message.id', () => {
  it('counts usage once per message.id even when written across multiple JSONL entries', async () => {
    // Real-world JSONL: one API call produces multiple content blocks,
    // each written as its own JSONL entry with the same terminal usage.
    const dir = createTempDir('aumx-claude-dedup-');
    const file = join(dir, 'session.jsonl');

    writeJsonl(file, [
      assistantEntry('u-1', null, 'msg_A',
        { type: 'thinking', thinking: 'reasoning...' }, TURN_A_USAGE),
      assistantEntry('u-2', 'u-1', 'msg_A',
        { type: 'text', text: 'Here is what I found.' }, TURN_A_USAGE),
      assistantEntry('u-3', 'u-2', 'msg_A',
        { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/x' } }, TURN_A_USAGE),
      assistantEntry('u-4', 'u-3', 'msg_B',
        { type: 'text', text: 'Second turn.' }, TURN_B_USAGE),
    ]);

    const session = await new ClaudeLogParser().parseSession(file);

    expect(session.metrics.inputTokens).toBe(7);
    expect(session.metrics.outputTokens).toBe(1_507);
    expect(session.metrics.cacheCreationTokens).toBe(30_700);
    expect(session.metrics.cacheReadTokens).toBe(119_029);
    expect(session.metrics.totalTokens).toBe(7 + 1_507 + 30_700 + 119_029);
  });

  it('keeps all content blocks visible while attributing usage only to the first entry of each turn', async () => {
    const dir = createTempDir('aumx-claude-dedup-blocks-');
    const file = join(dir, 'session.jsonl');

    writeJsonl(file, [
      assistantEntry('u-1', null, 'msg_A',
        { type: 'thinking', thinking: 'thought' }, TURN_A_USAGE),
      assistantEntry('u-2', 'u-1', 'msg_A',
        { type: 'text', text: 'reply' }, TURN_A_USAGE),
    ]);

    const session = await new ClaudeLogParser().parseSession(file);

    const assistantMsgs = session.messages.filter((m) => m.type === 'assistant');
    expect(assistantMsgs).toHaveLength(2);
    const withTokens = assistantMsgs.filter((m) => m.tokens);
    expect(withTokens).toHaveLength(1);
    expect(withTokens[0].tokens?.inputTokens).toBe(TURN_A_USAGE.input_tokens);
  });

  it('falls back to per-entry accumulation when message.id is missing (legacy)', async () => {
    const dir = createTempDir('aumx-claude-dedup-legacy-');
    const file = join(dir, 'session.jsonl');

    writeJsonl(file, [
      {
        type: 'assistant',
        uuid: 'u-1',
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'legacy' }],
          usage: TURN_A_USAGE,
        },
      },
      {
        type: 'assistant',
        uuid: 'u-2',
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'legacy 2' }],
          usage: TURN_B_USAGE,
        },
      },
    ]);

    const session = await new ClaudeLogParser().parseSession(file);

    expect(session.metrics.inputTokens).toBe(TURN_A_USAGE.input_tokens + TURN_B_USAGE.input_tokens);
    expect(session.metrics.outputTokens).toBe(TURN_A_USAGE.output_tokens + TURN_B_USAGE.output_tokens);
  });
});
