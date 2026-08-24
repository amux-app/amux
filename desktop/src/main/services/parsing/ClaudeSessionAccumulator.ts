import { basename } from 'path';
import type { ClaudeJsonlEntry } from './claude-jsonl-types.js';
import type {
  NormalizedMessage,
  NormalizedSession,
  SessionMetrics,
} from '../../../shared/agent-session-types.js';
import { createEmptyMetrics, createEmptySession, totalizeMetrics } from '../../../shared/agent-session-types.js';
import {
  convertEntry,
  deduplicateApiMessage,
  extractAskUserQuestion,
  extractAssistantStopReason,
  type RawClaudeEntry,
} from './claude-entry-conversion.js';
import {
  analyzeNewMessages,
  createClaudeFinalizeState,
  snapshotSubagents,
  type ClaudeFinalizeState,
  type ClaudeSidechainGroup,
} from './claude-session-finalize.js';
import { cleanClaudeTitle } from './claude-titles.js';
import type { JsonlSessionAccumulator } from './incrementalSessionParse.js';
import { parseIsoTimestamp, parseJsonRecord } from './jsonl-values.js';
import { JSONL_EXTENSION } from './session-files.js';

const TASK_TOOL_NAME = 'Task';
const DESCRIPTION_LIMIT = 200;

const ENTRY_ASSISTANT = 'assistant';
const ENTRY_AI_TITLE = 'ai-title';
const ENTRY_QUEUE_OPERATION = 'queue-operation';
const ENTRY_RESULT = 'result';
const ENTRY_SUMMARY = 'summary';
const ENTRY_SYSTEM = 'system';
const ENTRY_USER = 'user';

interface PendingUserQuestion {
  timestamp?: number;
  question?: string;
}

export interface ClaudeParseState {
  sessionId: string;
  title?: string;
  aiTitle?: string;
  startTime?: number;
  lastUpdateTime?: number;
  messages: NormalizedMessage[];
  messageIndex: number;
  sidechainIndex: number;
  metrics: SessionMetrics;
  sidechainMap: Map<string, ClaudeSidechainGroup>;
  lastTaskToolCallId: string | null;
  seenApiMessageIds: Set<string>;
  lastConversationMessageTimestamp?: number;
  lastTurnCompletionTimestamp?: number;
  pendingUserQuestion: PendingUserQuestion | null;
  lastAssistantModelId?: string;
  finalizeState: ClaudeFinalizeState;
}

export const claudeSessionAccumulator: JsonlSessionAccumulator<ClaudeParseState> = {
  create: createClaudeParseState,
  apply: applyClaudeLine,
  finalize: finalizeClaudeSession,
};

function createClaudeParseState(filePath: string): ClaudeParseState {
  return {
    sessionId: basename(filePath, JSONL_EXTENSION),
    messages: [],
    messageIndex: 0,
    sidechainIndex: 0,
    metrics: createEmptyMetrics(),
    sidechainMap: new Map(),
    lastTaskToolCallId: null,
    seenApiMessageIds: new Set(),
    pendingUserQuestion: null,
    finalizeState: createClaudeFinalizeState(),
  };
}

function applyClaudeLine(state: ClaudeParseState, line: string): void {
  const entry = parseJsonRecord(line);
  if (entry) applyClaudeEntry(state, entry as unknown as ClaudeJsonlEntry);
}

function applyClaudeEntry(state: ClaudeParseState, entry: ClaudeJsonlEntry): void {
  const raw = entry as unknown as RawClaudeEntry;
  const entryType = raw.type ?? '';
  const rawTimestamp = parseIsoTimestamp(raw.timestamp);

  if (entryType === ENTRY_QUEUE_OPERATION) {
    if (raw.operation === 'remove') markTurnCompleted(state, rawTimestamp);
    return;
  }
  if (entryType === ENTRY_AI_TITLE) {
    applyAiTitle(state, raw);
    return;
  }

  applyTurnCompletionSignals(state, raw, entryType, rawTimestamp);
  applyAssistantModel(state, entry, entryType);

  if (entryType === ENTRY_SUMMARY) return;
  if (entry.isSidechain) {
    applySidechainEntry(state, entry);
    return;
  }

  applyPendingQuestion(state, raw, entryType, rawTimestamp);
  if (entryType === ENTRY_RESULT && rawTimestamp) {
    state.lastTurnCompletionTimestamp = Math.max(state.lastTurnCompletionTimestamp ?? 0, rawTimestamp);
  }
  applyConversationEntry(state, entry);
}

function applyAiTitle(state: ClaudeParseState, raw: RawClaudeEntry): void {
  const rawTitle = typeof raw.aiTitle === 'string' ? raw.aiTitle.trim() : '';
  if (!rawTitle) return;
  state.title = rawTitle;
  state.aiTitle = cleanClaudeTitle(rawTitle) ?? state.aiTitle;
}

// Claude v2.1+ can signal normal completion directly on assistant messages.
// Example: message.stop_reason === "end_turn" on the final assistant response.
function applyTurnCompletionSignals(
  state: ClaudeParseState,
  raw: RawClaudeEntry,
  entryType: string,
  rawTimestamp: number | undefined,
): void {
  const turnDuration = entryType === ENTRY_SYSTEM && raw.subtype === 'turn_duration';
  const endTurn = entryType === ENTRY_ASSISTANT && extractAssistantStopReason(raw) === 'end_turn';
  if (!turnDuration && !endTurn) return;
  markTurnCompleted(state, rawTimestamp);
}

function markTurnCompleted(state: ClaudeParseState, timestamp: number | undefined): void {
  if (timestamp) {
    state.lastTurnCompletionTimestamp = Math.max(state.lastTurnCompletionTimestamp ?? 0, timestamp);
    state.lastUpdateTime = Math.max(state.lastUpdateTime ?? 0, timestamp);
  }
  state.pendingUserQuestion = null;
}

function applyAssistantModel(state: ClaudeParseState, entry: ClaudeJsonlEntry, entryType: string): void {
  if (entryType !== ENTRY_ASSISTANT) return;
  const model = entry.message?.model;
  if (typeof model === 'string' && model.trim()) state.lastAssistantModelId = model.trim();
}

function applyPendingQuestion(
  state: ClaudeParseState,
  raw: RawClaudeEntry,
  entryType: string,
  rawTimestamp: number | undefined,
): void {
  const pending = state.pendingUserQuestion;
  if (entryType === ENTRY_USER && pending) {
    if (!rawTimestamp || !pending.timestamp || rawTimestamp >= pending.timestamp) {
      state.pendingUserQuestion = null;
    }
  }

  if (entryType !== ENTRY_ASSISTANT) return;
  const question = extractAskUserQuestion(raw.message?.content ?? raw.content);
  if (question) state.pendingUserQuestion = { timestamp: rawTimestamp, question };
}

function applySidechainEntry(state: ClaudeParseState, entry: ClaudeJsonlEntry): void {
  if (!state.lastTaskToolCallId) return;
  const message = convertEntry(entry, state.sidechainIndex++);
  if (!message) return;
  deduplicateApiMessage(entry, message, state.seenApiMessageIds);

  const group = ensureSidechainGroup(state, state.lastTaskToolCallId);
  group.messages.push(message);
  accumulateMessageMetrics(group.metrics, message);
  if (message.type === ENTRY_USER && message.content && !group.description) {
    group.description = message.content.slice(0, DESCRIPTION_LIMIT);
  }
}

function ensureSidechainGroup(state: ClaudeParseState, toolCallId: string): ClaudeSidechainGroup {
  const existing = state.sidechainMap.get(toolCallId);
  if (existing) return existing;
  const group: ClaudeSidechainGroup = { description: '', messages: [], metrics: createEmptyMetrics() };
  state.sidechainMap.set(toolCallId, group);
  return group;
}

function applyConversationEntry(state: ClaudeParseState, entry: ClaudeJsonlEntry): void {
  const message = convertEntry(entry, state.messageIndex);
  if (!message) return;
  deduplicateApiMessage(entry, message, state.seenApiMessageIds);
  trackTaskToolCalls(state, message);

  state.messages.push(message);
  state.messageIndex++;
  accumulateMessageMetrics(state.metrics, message);
  applyMessageTimestamp(state, message.timestamp);
}

function trackTaskToolCalls(state: ClaudeParseState, message: NormalizedMessage): void {
  for (const toolCall of message.toolCalls) {
    if (toolCall.name !== TASK_TOOL_NAME) continue;
    state.lastTaskToolCallId = toolCall.id;
    const description = (toolCall.input.description as string) || (toolCall.input.prompt as string) || '';
    ensureSidechainGroup(state, toolCall.id).description = description.slice(0, DESCRIPTION_LIMIT);
  }
}

function applyMessageTimestamp(state: ClaudeParseState, timestamp: number | undefined): void {
  if (!timestamp) return;
  state.lastConversationMessageTimestamp = Math.max(state.lastConversationMessageTimestamp ?? 0, timestamp);
  if (!state.startTime || timestamp < state.startTime) state.startTime = timestamp;
  if (!state.lastUpdateTime || timestamp > state.lastUpdateTime) state.lastUpdateTime = timestamp;
}

function accumulateMessageMetrics(metrics: SessionMetrics, message: NormalizedMessage): void {
  if (message.tokens) {
    metrics.inputTokens += message.tokens.inputTokens;
    metrics.outputTokens += message.tokens.outputTokens;
    metrics.cacheReadTokens += message.tokens.cacheReadTokens ?? 0;
    metrics.cacheCreationTokens += message.tokens.cacheCreationTokens ?? 0;
  }
  metrics.toolCallCount += message.toolCalls.length;
}

function finalizeClaudeSession(state: ClaudeParseState): NormalizedSession {
  analyzeNewMessages(state.finalizeState, state.messages);

  const session = createEmptySession('claude', state.sessionId);
  session.messages = [...state.messages];
  session.title = state.title;
  session.aiTitle = state.aiTitle;
  session.startTime = state.startTime;
  session.lastUpdateTime = state.lastUpdateTime;
  session.metrics = totalizeMetrics(state.metrics, session.messages.length);
  session.compactionEvents = [...state.finalizeState.compactionEvents];
  session.subagents = snapshotSubagents(state.finalizeState, state.sidechainMap);

  const lastMessage = session.messages[session.messages.length - 1];
  session.awaitingUserInput = !!state.pendingUserQuestion;
  session.pendingUserQuestion = state.pendingUserQuestion?.question;
  session.turnCompleted = !!state.lastTurnCompletionTimestamp
    && (
      !state.lastConversationMessageTimestamp
      || state.lastTurnCompletionTimestamp >= state.lastConversationMessageTimestamp
    );
  session.isOngoing = session.awaitingUserInput
    ? false
    : session.turnCompleted !== undefined
      ? !session.turnCompleted
      : lastMessage?.type === ENTRY_ASSISTANT;
  session.modelId = state.lastAssistantModelId;

  return session;
}
