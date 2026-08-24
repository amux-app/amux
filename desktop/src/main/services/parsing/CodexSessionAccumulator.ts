import { basename } from 'path';
import type {
  NormalizedMessage,
  NormalizedSession,
  NormalizedToolCall,
  NormalizedToolResult,
  SessionMetrics,
} from '../../../shared/agent-session-types.js';
import { createEmptyMetrics, createEmptySession, totalizeMetrics } from '../../../shared/agent-session-types.js';
import type { JsonlSessionAccumulator } from './incrementalSessionParse.js';
import { asRecord, getNumber, getString, parseIsoTimestamp, parseJsonRecord, type JsonRecord } from './jsonl-values.js';
import { JSONL_EXTENSION } from './session-files.js';

const EVENT_TASK_STARTED = 'task_started';
const EVENT_TASK_COMPLETE = 'task_complete';
const EVENT_TOKEN_COUNT = 'token_count';
const EVENT_TURN_ABORTED = 'turn_aborted';
const EVENT_USER_MESSAGE = 'user_message';
const ITEM_MESSAGE = 'message';
const ROLE_USER = 'user';

export interface RawCodexEntry {
  type?: string;
  timestamp?: string;
  payload?: JsonRecord;
  [key: string]: unknown;
}

export interface CodexParseState {
  sessionId: string;
  modelId?: string;
  startTime?: number;
  lastUpdateTime?: number;
  messages: NormalizedMessage[];
  messageIndex: number;
  metrics: SessionMetrics;
  sawTurnStateEvent: boolean;
  turnCompleted: boolean;
  lastConversationMessageTimestamp?: number;
  lastTaskCompleteTimestamp?: number;
  pendingUserInputCalls: Map<string, string | undefined>;
  realUserMessageTexts: Set<string>;
}

export const codexSessionAccumulator: JsonlSessionAccumulator<CodexParseState> = {
  create: createCodexParseState,
  apply: applyCodexLine,
  finalize: finalizeCodexSession,
};

export function getSessionStartedAt(entry: RawCodexEntry, payload: JsonRecord | null | undefined): string | undefined {
  return getString(payload?.timestamp)
    ?? getString(entry.started_at)
    ?? getString(entry.timestamp);
}

function createCodexParseState(filePath: string): CodexParseState {
  return {
    sessionId: basename(filePath, JSONL_EXTENSION),
    messages: [],
    messageIndex: 0,
    metrics: createEmptyMetrics(),
    sawTurnStateEvent: false,
    turnCompleted: false,
    pendingUserInputCalls: new Map(),
    realUserMessageTexts: new Set(),
  };
}

function applyCodexLine(state: CodexParseState, line: string): void {
  const entry: RawCodexEntry | null = parseJsonRecord(line);
  if (!entry) return;

  const timestamp = parseIsoTimestamp(getString(entry.timestamp));
  if (timestamp) state.lastUpdateTime = Math.max(state.lastUpdateTime ?? 0, timestamp);

  switch (entry.type) {
    case 'session_meta':
      applySessionMeta(state, entry);
      return;
    case 'event_msg':
      applyEventMessage(state, entry, timestamp);
      return;
    case 'response_item':
      applyResponseItem(state, entry);
      return;
    default:
      return;
  }
}

function applySessionMeta(state: CodexParseState, entry: RawCodexEntry): void {
  const payload = asRecord(entry.payload);
  const sessionMetaId = getString(payload?.id) ?? getString(entry.session_id);
  if (sessionMetaId) state.sessionId = sessionMetaId;

  const startedAtMs = parseIsoTimestamp(getSessionStartedAt(entry, payload));
  if (startedAtMs) state.startTime = startedAtMs;

  const modelId = getString(payload?.model) ?? getString(entry.model);
  if (modelId) state.modelId = modelId;
}

function applyEventMessage(state: CodexParseState, entry: RawCodexEntry, timestamp: number | undefined): void {
  const payload = asRecord(entry.payload);
  const eventType = getString(payload?.type) ?? getString(entry.event_type);

  applyEventTokens(state.metrics, entry, payload, eventType);
  applyTurnStateEvent(state, eventType, payload, timestamp);
}

function applyEventTokens(
  metrics: SessionMetrics,
  entry: RawCodexEntry,
  payload: JsonRecord | undefined,
  eventType: string | undefined,
): void {
  if (eventType === EVENT_TOKEN_COUNT) {
    const totalUsage = asRecord(asRecord(payload?.info)?.total_token_usage);
    metrics.totalTokens = Math.max(metrics.totalTokens, getNumber(totalUsage?.total_tokens) ?? 0);
    metrics.inputTokens = Math.max(metrics.inputTokens, getNumber(totalUsage?.input_tokens) ?? 0);
    metrics.outputTokens = Math.max(metrics.outputTokens, getNumber(totalUsage?.output_tokens) ?? 0);
    metrics.cacheReadTokens = Math.max(metrics.cacheReadTokens, getNumber(totalUsage?.cached_input_tokens) ?? 0);
    return;
  }

  const usage = asRecord(entry.usage) ?? asRecord(payload?.usage);
  if (!usage) return;
  metrics.inputTokens += getNumber(usage.input_tokens) ?? 0;
  metrics.outputTokens += getNumber(usage.output_tokens) ?? 0;
  metrics.totalTokens += getNumber(usage.total_tokens) ?? 0;
}

function applyTurnStateEvent(
  state: CodexParseState,
  eventType: string | undefined,
  payload: JsonRecord | undefined,
  timestamp: number | undefined,
): void {
  switch (eventType) {
    case EVENT_TASK_STARTED:
      state.sawTurnStateEvent = true;
      state.turnCompleted = false;
      return;
    case EVENT_TASK_COMPLETE:
      state.sawTurnStateEvent = true;
      state.turnCompleted = true;
      if (timestamp) state.lastTaskCompleteTimestamp = Math.max(state.lastTaskCompleteTimestamp ?? 0, timestamp);
      state.pendingUserInputCalls.clear();
      return;
    case EVENT_TURN_ABORTED:
      state.sawTurnStateEvent = true;
      state.turnCompleted = false;
      state.pendingUserInputCalls.clear();
      return;
    case EVENT_USER_MESSAGE: {
      const userText = getString(payload?.message)?.trim();
      if (userText) state.realUserMessageTexts.add(userText);
      state.pendingUserInputCalls.clear();
      return;
    }
    default:
      return;
  }
}

function applyResponseItem(state: CodexParseState, entry: RawCodexEntry): void {
  const payload = asRecord(entry.payload);
  const message = convertResponseItem(entry, state.messageIndex);
  if (!message) return;

  state.messages.push(message);
  state.messageIndex++;
  state.metrics.toolCallCount += message.toolCalls.length;

  if (message.timestamp) {
    state.lastConversationMessageTimestamp = Math.max(state.lastConversationMessageTimestamp ?? 0, message.timestamp);
  }
  if (message.type === 'assistant') applyAssistantResponse(state, message, payload);
  if (message.type === 'tool_result') resolvePendingToolResults(state, message);

  if (!state.startTime && message.timestamp) state.startTime = message.timestamp;
  if (message.timestamp) state.lastUpdateTime = Math.max(state.lastUpdateTime ?? 0, message.timestamp);

  clearPendingOnUserMessage(state, payload);
}

function applyAssistantResponse(
  state: CodexParseState,
  message: NormalizedMessage,
  payload: JsonRecord | undefined,
): void {
  const modelId = getString(payload?.modelID) ?? getString(payload?.model);
  if (modelId) state.modelId = modelId;

  for (const toolCall of message.toolCalls) {
    if (!isUserInputToolName(toolCall.name)) continue;
    state.sawTurnStateEvent = true;
    state.turnCompleted = false;
    state.pendingUserInputCalls.set(toolCall.id, extractPendingQuestionFromToolInput(toolCall.input));
  }
}

function resolvePendingToolResults(state: CodexParseState, message: NormalizedMessage): void {
  for (const toolResult of message.toolResults) {
    state.pendingUserInputCalls.delete(toolResult.toolCallId);
  }
}

function clearPendingOnUserMessage(state: CodexParseState, payload: JsonRecord | undefined): void {
  if (!payload) return;
  const payloadType = getString(payload.type) ?? getString(payload.item_type);
  if (payloadType !== ITEM_MESSAGE) return;
  if (extractMessageRole(payload) === ROLE_USER) state.pendingUserInputCalls.clear();
}

function finalizeCodexSession(state: CodexParseState): NormalizedSession {
  const session = createEmptySession('codex', state.sessionId);
  session.startTime = state.startTime;
  session.lastUpdateTime = state.lastUpdateTime;
  session.modelId = state.modelId;
  session.messages = keepRecordedUserMessages(state.messages, state.realUserMessageTexts);
  session.metrics = totalizeMetrics(state.metrics, session.messages.length);

  session.awaitingUserInput = state.pendingUserInputCalls.size > 0;
  session.pendingUserQuestion = state.pendingUserInputCalls.values().next().value;
  session.turnCompleted = state.sawTurnStateEvent && isTurnSettled(state);

  const lastMessage = session.messages[session.messages.length - 1];
  session.isOngoing = session.awaitingUserInput
    ? false
    : state.sawTurnStateEvent
      ? !session.turnCompleted
      : lastMessage?.type === 'assistant';

  return session;
}

function isTurnSettled(state: CodexParseState): boolean {
  return state.turnCompleted && (
    !state.lastConversationMessageTimestamp
    || !state.lastTaskCompleteTimestamp
    || state.lastTaskCompleteTimestamp >= state.lastConversationMessageTimestamp
  );
}

function keepRecordedUserMessages(
  messages: NormalizedMessage[],
  realUserMessageTexts: Set<string>,
): NormalizedMessage[] {
  if (realUserMessageTexts.size === 0) return messages.slice();

  const recordedTexts = [...realUserMessageTexts];
  return messages.filter((message) => isRecordedUserMessage(message, realUserMessageTexts, recordedTexts));
}

function isRecordedUserMessage(
  message: NormalizedMessage,
  realUserMessageTexts: Set<string>,
  recordedTexts: string[],
): boolean {
  if (message.type !== ROLE_USER) return true;
  const content = message.content.trim();
  if (realUserMessageTexts.has(content)) return true;
  return recordedTexts.some((text) => startsWithRecordedUserText(content, text));
}

function startsWithRecordedUserText(content: string, recordedText: string): boolean {
  return content.startsWith(`${recordedText}\n`) || content.startsWith(`${recordedText}\r\n`);
}

function convertResponseItem(entry: RawCodexEntry, index: number): NormalizedMessage | null {
  const payload = asRecord(entry.payload);
  if (!payload) return null;

  const itemType = getString(payload.type) ?? getString(payload.item_type);
  const timestamp = parseIsoTimestamp(getString(entry.timestamp) ?? getString(payload.timestamp));
  const id = `codex-${index}`;

  switch (itemType) {
    case ITEM_MESSAGE:
      return convertMessageItem(payload, id, timestamp);
    case 'function_call':
    case 'custom_tool_call':
    case 'web_search_call': {
      const toolCall = extractToolCall(payload, timestamp, itemType);
      if (!toolCall) return null;
      return { id, type: 'assistant', timestamp, content: '', toolCalls: [toolCall], toolResults: [] };
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const toolResult = extractToolResult(payload);
      if (!toolResult) return null;
      return { id, type: 'tool_result', timestamp, content: '', toolCalls: [], toolResults: [toolResult] };
    }
    default:
      return null;
  }
}

function convertMessageItem(
  payload: JsonRecord,
  id: string,
  timestamp: number | undefined,
): NormalizedMessage | null {
  const role = extractMessageRole(payload);
  if (!role) return null;
  return {
    id,
    type: role === ROLE_USER ? 'user' : role === 'assistant' ? 'assistant' : 'system',
    timestamp,
    content: extractMessageContent(payload),
    toolCalls: [],
    toolResults: [],
  };
}

function extractMessageRole(payload: JsonRecord): 'user' | 'assistant' | 'system' | null {
  const directRole = normalizeRole(getString(payload.role));
  if (directRole) return directRole;
  return normalizeRole(getString(asRecord(payload.message)?.role));
}

function normalizeRole(role: string | undefined): 'user' | 'assistant' | 'system' | null {
  if (role === ROLE_USER || role === 'assistant' || role === 'system') return role;
  if (role === 'developer') return 'system';
  return null;
}

function extractMessageContent(payload: JsonRecord): string {
  const directContent = payload.content ?? asRecord(payload.message)?.content;
  if (typeof directContent === 'string') return directContent;
  if (!Array.isArray(directContent)) return '';
  return directContent
    .map((part) => extractContentPartText(part))
    .filter(Boolean)
    .join('\n');
}

function extractContentPartText(part: unknown): string {
  const record = asRecord(part);
  if (!record) return '';
  return getString(record.text) ?? getString(record.content) ?? '';
}

function extractToolCall(
  payload: JsonRecord,
  timestamp: number | undefined,
  itemType: string,
): NormalizedToolCall | null {
  if (itemType === 'web_search_call') {
    return {
      id: getString(payload.call_id) ?? getString(payload.id) ?? 'web-search',
      name: 'web_search',
      input: asRecord(payload.input) ?? {},
      timestamp,
    };
  }

  const source = asRecord(payload.function_call) ?? payload;
  const name = getString(source.name);
  if (!name) return null;

  return {
    id: getString(source.call_id) ?? getString(source.id) ?? `${name}-${Date.now()}`,
    name,
    input: extractToolInput(source.arguments ?? source.input),
    timestamp,
  };
}

function extractToolInput(rawArgs: unknown): Record<string, unknown> {
  if (typeof rawArgs === 'string') {
    try {
      const parsed: unknown = JSON.parse(rawArgs);
      return asRecord(parsed) ?? { value: parsed };
    } catch {
      return { raw: rawArgs };
    }
  }
  if (rawArgs && typeof rawArgs === 'object') return asRecord(rawArgs) ?? {};
  return {};
}

function extractToolResult(payload: JsonRecord): NormalizedToolResult | null {
  const source = asRecord(payload.function_call_output) ?? payload;
  const callId = getString(source.call_id);
  if (!callId) return null;

  const output = source.output;
  return {
    toolCallId: callId,
    content: typeof output === 'string' ? output : output == null ? '' : JSON.stringify(output),
    isError: Boolean(source.is_error),
  };
}

function isUserInputToolName(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === 'request_user_input' || normalized === 'askuserquestion';
}

function extractPendingQuestionFromToolInput(input: Record<string, unknown>): string | undefined {
  const direct = getString(input.question)?.trim();
  if (direct) return direct;
  if (!Array.isArray(input.questions)) return undefined;

  const firstQuestion = input.questions.find(
    (question): question is JsonRecord => !!asRecord(question) && typeof asRecord(question)?.question === 'string',
  );
  return getString(firstQuestion?.question)?.trim();
}
