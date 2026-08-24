import { basename } from 'path';
import type {
  NormalizedMessage,
  NormalizedSession,
} from '../../../shared/agent-session-types.js';
import { createEmptyMetrics, createEmptySession, totalizeMetrics } from '../../../shared/agent-session-types.js';
import type { JsonlSessionAccumulator } from './incrementalSessionParse.js';
import { asRecord, parseIsoTimestamp, parseJsonRecord } from './jsonl-values.js';
import { JSONL_EXTENSION } from './session-files.js';
import { piExtractTextContent } from './pi-session-parse.js';

const PI_TYPE_MESSAGE = 'message';
const PI_ROLE_ASSISTANT = 'assistant';
const PI_ROLE_USER = 'user';
const PI_TERMINAL_STOP_REASONS = new Set(['stop', 'length', 'aborted']);
const PI_THINKING_TYPE = 'thinking';
const MESSAGE_TYPE_ASSISTANT = 'assistant';
const MESSAGE_TYPE_USER = 'user';

export interface PiParseState {
  sessionId: string;
  cwd?: string;
  title?: string;
  startTime?: number;
  lastUpdateTime?: number;
  messages: NormalizedMessage[];
  messageIndex: number;
  turnCompleted?: boolean;
}

export const piSessionAccumulator: JsonlSessionAccumulator<PiParseState> = {
  create: createPiParseState,
  apply: applyPiLine,
  finalize: finalizePiSession,
};

function createPiParseState(filePath: string): PiParseState {
  return {
    sessionId: basename(filePath, JSONL_EXTENSION),
    messages: [],
    messageIndex: 0,
  };
}

function applyPiLine(state: PiParseState, line: string): void {
  const entry = parseJsonRecord(line);
  if (!entry) return;

  if (entry.type === 'session') {
    if (typeof entry.cwd === 'string') state.cwd = entry.cwd;
    return;
  }

  if (entry.type !== PI_TYPE_MESSAGE) return;

  const message = asRecord(entry.message);
  if (!message) return;

  const role = message.role;
  if (role !== PI_ROLE_USER && role !== PI_ROLE_ASSISTANT) return;

  // Pi writes a user message as soon as a turn starts. Assistant tool-use and
  // retry/error entries follow while it is still running. Pi's final assistant
  // entry uses stop, length, or aborted when no more work will follow.
  state.turnCompleted = role === PI_ROLE_ASSISTANT
    && typeof message.stopReason === 'string'
    && PI_TERMINAL_STOP_REASONS.has(message.stopReason);

  const rawTimestamp = extractPiTimestamp(entry, message);
  const text = piExtractTextContent(message.content) ?? '';
  const thinkingContent = extractThinkingContent(message.content);

  const normalized: NormalizedMessage = {
    id: `pi-${state.messageIndex}`,
    type: role === PI_ROLE_USER ? MESSAGE_TYPE_USER : MESSAGE_TYPE_ASSISTANT,
    timestamp: rawTimestamp,
    content: text,
    thinkingContent,
    toolCalls: [],
    toolResults: [],
  };

  if (role === PI_ROLE_USER && !state.title) {
    state.title = text || undefined;
  }

  state.messages.push(normalized);
  state.messageIndex++;
  applyMessageTimestamp(state, rawTimestamp);
}

function extractPiTimestamp(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
): number | undefined {
  if (typeof entry.timestamp === 'string') return parseIsoTimestamp(entry.timestamp);
  return typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
    ? message.timestamp
    : undefined;
}

function extractThinkingContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    const block = asRecord(item);
    if (block?.type === PI_THINKING_TYPE && typeof block.thinking === 'string' && block.thinking.trim()) {
      parts.push(block.thinking.trim());
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function applyMessageTimestamp(state: PiParseState, timestamp: number | undefined): void {
  if (!timestamp) return;
  if (!state.startTime || timestamp < state.startTime) state.startTime = timestamp;
  if (!state.lastUpdateTime || timestamp > state.lastUpdateTime) state.lastUpdateTime = timestamp;
}

function finalizePiSession(state: PiParseState): NormalizedSession {
  const session = createEmptySession('pi', state.sessionId);
  session.title = state.title;
  session.startTime = state.startTime;
  session.lastUpdateTime = state.lastUpdateTime;
  session.messages = [...state.messages];
  session.metrics = totalizeMetrics(createEmptyMetrics(), session.messages.length);

  session.isOngoing = state.turnCompleted === false;
  session.turnCompleted = state.turnCompleted === true;

  return session;
}
