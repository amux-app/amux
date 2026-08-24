import { writeFileSync } from 'node:fs';
import { claudeSessionAccumulator } from '../../src/main/services/parsing/ClaudeSessionAccumulator';
import { codexSessionAccumulator } from '../../src/main/services/parsing/CodexSessionAccumulator';
import {
  createIncrementalJsonlParser,
  type IncrementalParseState,
  type JsonlSessionAccumulator,
} from '../../src/main/services/parsing/incrementalSessionParse';
import type { SessionParseFn, SessionParseSnapshot } from '../../src/main/services/parsing/SessionParseCache';
import type { NormalizedSession } from '../../src/shared/agent-session-types';

const BASE_TIME = Date.UTC(2026, 6, 26, 10, 0, 0);
const CLAUDE_MODEL_A = 'claude-opus-4-6';
const CLAUDE_MODEL_B = 'claude-opus-4-7';
const CODEX_USER_TEXT = 'Ship the incremental parser café 🚀';

function at(step: number): string {
  return new Date(BASE_TIME + step * 1000).toISOString();
}

function json(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

/**
 * Exercises every cross-line accumulator: message/sidechain indexes on entries
 * without a uuid, metrics, api-message dedup, Task sidechain grouping, turn
 * completion signals, a pending question, the ai-title and the last model id.
 */
export const CLAUDE_FIXTURE_LINES: string[] = [
  json({ type: 'summary', summary: 'Earlier session', leafUuid: 'leaf-1' }),
  json({ type: 'user', timestamp: at(0), message: { role: 'user', content: 'Refactor the parser café ✳ 🚀' } }),
  json({ type: 'user', isMeta: true, timestamp: at(1), message: { role: 'user', content: 'Caveat: synthetic' } }),
  json({ type: 'user', timestamp: at(2), message: { role: 'user', content: '<command-name>/compact</command-name>' } }),
  json({
    type: 'assistant',
    timestamp: at(3),
    message: {
      id: 'msg_a',
      role: 'assistant',
      model: CLAUDE_MODEL_A,
      content: [{ type: 'thinking', thinking: 'Plan the work' }, { type: 'text', text: 'Starting' }],
      usage: { input_tokens: 40_000, output_tokens: 30, cache_read_input_tokens: 4_000, cache_creation_input_tokens: 900 },
      stop_reason: null,
    },
  }),
  json({
    type: 'assistant',
    timestamp: at(4),
    message: {
      id: 'msg_a',
      role: 'assistant',
      model: CLAUDE_MODEL_A,
      content: [{ type: 'tool_use', id: 'toolu_task', name: 'Task', input: { description: 'inspect the parsers', prompt: 'go' } }],
      usage: { input_tokens: 40_000, output_tokens: 30, cache_read_input_tokens: 4_000, cache_creation_input_tokens: 900 },
      stop_reason: 'tool_use',
    },
  }),
  json({ type: 'user', isSidechain: true, timestamp: at(5), message: { role: 'user', content: 'inspect the parsers' } }),
  json({
    type: 'assistant',
    isSidechain: true,
    timestamp: at(6),
    message: {
      id: 'msg_side',
      role: 'assistant',
      model: CLAUDE_MODEL_A,
      content: [{ type: 'text', text: 'sub agent done' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  }),
  json({
    type: 'user',
    timestamp: at(7),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_task', content: 'sub agent done', is_error: false }] },
  }),
  '',
  '{ not json at all',
  json({ type: 'ai-title', timestamp: at(8), aiTitle: '✳ Incremental  Parser Work' }),
  json({ type: 'system', subtype: 'turn_duration', timestamp: at(9), message: { role: 'system', content: 'turn took 12s' } }),
  json({ type: 'queue-operation', operation: 'remove', timestamp: at(10) }),
  json({ type: 'result', timestamp: at(11), usage: { input_tokens: 5, output_tokens: 2 }, message: { content: 'ok' } }),
  json({
    type: 'assistant',
    timestamp: at(12),
    message: {
      id: 'msg_b',
      role: 'assistant',
      model: CLAUDE_MODEL_B,
      content: [{ type: 'tool_use', id: 'toolu_ask', name: 'AskUserQuestion', input: { questions: [{ question: 'Which approach?' }] } }],
      usage: { input_tokens: 9_000, output_tokens: 12 },
      stop_reason: 'tool_use',
    },
  }),
];

const CODEX_FIXTURE_LINES: string[] = [
  json({ type: 'session_meta', timestamp: at(0), payload: { id: 'codex-session-42', model: 'gpt-5-codex', cwd: '/repo', timestamp: at(0) } }),
  json({ type: 'event_msg', timestamp: at(1), payload: { type: 'task_started' } }),
  json({ type: 'event_msg', timestamp: at(2), payload: { type: 'user_message', message: CODEX_USER_TEXT } }),
  json({ type: 'response_item', timestamp: at(3), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: CODEX_USER_TEXT }] } }),
  json({ type: 'response_item', timestamp: at(4), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md injected context' }] } }),
  json({ type: 'response_item', timestamp: at(5), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Working on it' }] } }),
  json({ type: 'response_item', timestamp: at(6), payload: { type: 'function_call', name: 'shell', call_id: 'call_1', arguments: '{"command":"ls"}' } }),
  json({ type: 'response_item', timestamp: at(7), payload: { type: 'function_call_output', call_id: 'call_1', output: 'src\ndist' } }),
  json({
    type: 'event_msg',
    timestamp: at(8),
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 5_000, input_tokens: 4_200, output_tokens: 800, cached_input_tokens: 3_000 } } },
  }),
  json({ type: 'event_msg', timestamp: at(9), payload: { type: 'agent_message', usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } } }),
  '',
  '{ broken',
  json({ type: 'event_msg', timestamp: at(10), payload: { type: 'task_complete' } }),
  json({ type: 'response_item', timestamp: at(11), payload: { type: 'message', role: 'developer', content: 'system note' } }),
  json({ type: 'response_item', timestamp: at(12), payload: { type: 'custom_tool_call', name: 'request_user_input', call_id: 'call_ask', input: { question: 'Which model?' } } }),
];

/** Turn settled by a completion signal, then records that produce no message. */
export const CLAUDE_SETTLED_FIXTURE_LINES: string[] = [
  json({ type: 'user', timestamp: at(0), message: { role: 'user', content: 'Finish the migration' } }),
  json({
    type: 'assistant',
    timestamp: at(1),
    message: {
      id: 'msg_done',
      role: 'assistant',
      model: CLAUDE_MODEL_B,
      content: [{ type: 'text', text: 'All done' }],
      usage: { input_tokens: 20, output_tokens: 8 },
      stop_reason: 'end_turn',
    },
  }),
  json({ type: 'queue-operation', operation: 'remove', timestamp: at(2) }),
  json({ type: 'summary', summary: 'wrap up', leafUuid: 'leaf-2' }),
  json({ type: 'user', isMeta: true, timestamp: at(3), message: { role: 'user', content: 'Caveat: synthetic' } }),
];

export const CODEX_SETTLED_FIXTURE_LINES: string[] = [
  json({ type: 'session_meta', timestamp: at(0), payload: { id: 'codex-settled', model: 'gpt-5-codex', cwd: '/repo', timestamp: at(0) } }),
  json({ type: 'event_msg', timestamp: at(1), payload: { type: 'task_started' } }),
  json({ type: 'event_msg', timestamp: at(2), payload: { type: 'user_message', message: 'Finish the migration' } }),
  json({ type: 'response_item', timestamp: at(3), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Finish the migration' }] } }),
  json({ type: 'response_item', timestamp: at(4), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'All done' }] } }),
  json({ type: 'event_msg', timestamp: at(5), payload: { type: 'task_complete' } }),
  json({ type: 'event_msg', timestamp: at(6), payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 900, input_tokens: 700, output_tokens: 200, cached_input_tokens: 100 } } } }),
  '{ broken tail',
];

/** Completion signal followed by a later message: the turn is not settled. */
export const CODEX_UNSETTLED_FIXTURE_LINES: string[] = [
  json({ type: 'session_meta', timestamp: at(0), payload: { id: 'codex-unsettled', model: 'gpt-5-codex', cwd: '/repo', timestamp: at(0) } }),
  json({ type: 'event_msg', timestamp: at(1), payload: { type: 'task_started' } }),
  json({ type: 'event_msg', timestamp: at(2), payload: { type: 'user_message', message: 'Keep going' } }),
  json({ type: 'response_item', timestamp: at(3), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Keep going' }] } }),
  json({ type: 'event_msg', timestamp: at(4), payload: { type: 'task_complete' } }),
  json({ type: 'response_item', timestamp: at(5), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Still streaming' }] } }),
  json({ type: 'event_msg', timestamp: at(6), payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 900, input_tokens: 700, output_tokens: 200, cached_input_tokens: 100 } } } }),
  '{ broken tail',
];

function toJsonlBuffer(lines: string[]): Buffer {
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

/** Reads the file as it currently is, carrying state from its own previous reads. */
interface SessionFeeder {
  parse(): Promise<NormalizedSession>;
}

export interface IncrementalScenario {
  readonly name: string;
  readonly content: Buffer;
  createFeeder(filePath: string): SessionFeeder;
  /** Writes each prefix in turn and parses it, threading the retained state. */
  feed(filePath: string, offsets: number[]): Promise<NormalizedSession>;
  /** Single parse with no retained state: the reference output for whatever is on disk. */
  parseOnce(filePath: string): Promise<NormalizedSession>;
  /** Writes the whole fixture, then parses it with no retained state. */
  parseFull(filePath: string): Promise<NormalizedSession>;
}

function createFeeder<TState>(
  filePath: string,
  parse: SessionParseFn<IncrementalParseState<TState>>,
): SessionFeeder {
  let previous: SessionParseSnapshot<IncrementalParseState<TState>> | null = null;
  return {
    async parse(): Promise<NormalizedSession> {
      const result = await parse({ filePath, previous });
      previous = { session: result.session, state: result.state };
      return result.session;
    },
  };
}

function createScenario<TState>(
  name: string,
  lines: string[],
  accumulator: JsonlSessionAccumulator<TState>,
): IncrementalScenario {
  const content = toJsonlBuffer(lines);
  const build = (filePath: string): SessionFeeder =>
    createFeeder(filePath, createIncrementalJsonlParser(accumulator));

  const scenario: IncrementalScenario = {
    name,
    content,
    createFeeder: build,
    parseOnce: (filePath) => build(filePath).parse(),
    async feed(filePath, offsets) {
      const feeder = build(filePath);
      let session: NormalizedSession | null = null;
      for (const offset of offsets) {
        writeFileSync(filePath, content.subarray(0, offset));
        session = await feeder.parse();
      }
      if (!session) throw new Error('feed requires at least one offset');
      return session;
    },
    parseFull(filePath) {
      writeFileSync(filePath, content);
      return scenario.parseOnce(filePath);
    },
  };
  return scenario;
}

export function claudeScenario(lines: string[] = CLAUDE_FIXTURE_LINES, name = 'claude'): IncrementalScenario {
  return createScenario(name, lines, claudeSessionAccumulator);
}

export function codexScenario(lines: string[] = CODEX_FIXTURE_LINES, name = 'codex'): IncrementalScenario {
  return createScenario(name, lines, codexSessionAccumulator);
}

const NEWLINE_BYTE = 0x0a;
const CLOSING_BRACE_BYTE = 0x7d;
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION_BYTE = 0x80;

/** Offsets where a split can change what the reader commits. */
function isDecisionOffset(content: Buffer, offset: number): boolean {
  const current = content[offset];
  const previous = content[offset - 1];
  return current === NEWLINE_BYTE
    || previous === NEWLINE_BYTE
    || previous === CLOSING_BRACE_BYTE
    || (current & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_BYTE;
}

/**
 * Every record boundary, every prefix that ends on a closing brace (where a
 * newline-less record can already parse) and every multi-byte codepoint
 * interior, plus a `stride` sample of the remaining mid-object offsets.
 */
export function boundaryClassOffsets(content: Buffer, stride: number): number[] {
  const offsets: number[] = [];
  for (let offset = 1; offset < content.length; offset++) {
    if (offset % stride === 0 || isDecisionOffset(content, offset)) offsets.push(offset);
  }
  return normalizeOffsets(offsets, content.length);
}

export function newlineOffsets(content: Buffer): number[] {
  const offsets: number[] = [];
  for (let index = 0; index < content.length; index++) {
    if (content[index] !== 0x0a) continue;
    offsets.push(index, index + 1);
    if (index > 0) offsets.push(index - 1);
  }
  return normalizeOffsets(offsets, content.length);
}

export function midRecordOffsets(content: Buffer): number[] {
  const offsets: number[] = [];
  let lineStart = 0;
  for (let index = 0; index < content.length; index++) {
    if (content[index] !== 0x0a) continue;
    const middle = lineStart + Math.floor((index - lineStart) / 2);
    offsets.push(lineStart + 1, middle, index - 1);
    lineStart = index + 1;
  }
  return normalizeOffsets(offsets, content.length);
}

/** Deterministic PRNG so a failing split schedule is always reproducible. */
export function randomOffsets(content: Buffer, seed: number, count: number): number[] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };

  const offsets: number[] = [];
  for (let i = 0; i < count; i++) offsets.push(Math.floor(next() * content.length));
  return normalizeOffsets(offsets, content.length);
}

function normalizeOffsets(offsets: number[], length: number): number[] {
  const unique = new Set(offsets.filter((offset) => offset > 0 && offset < length));
  return [...unique, length].sort((a, b) => a - b);
}
