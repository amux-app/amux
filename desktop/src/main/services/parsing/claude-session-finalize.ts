import type {
  CompactionEvent,
  NormalizedMessage,
  SessionMetrics,
  SubagentSession,
} from '../../../shared/agent-session-types.js';
import { totalizeMetrics } from '../../../shared/agent-session-types.js';

const ASSISTANT = 'assistant';
const TOOL_RESULT = 'tool_result';
const COMPACTION_DROP_RATIO = 0.7;
const COMPACTION_MIN_TOKENS = 10_000;
const CHARS_PER_TOKEN = 4;
const SYSTEM_PROMPT_INPUT_RATIO = 0.3;

export interface ClaudeSidechainGroup {
  description: string;
  messages: NormalizedMessage[];
  metrics: SessionMetrics;
}

interface SubagentSnapshot {
  messageCount: number;
  description: string;
  subagent: SubagentSession;
}

/**
 * Running fold of every finalize pass that only depends on the message prefix, so a
 * parse that appended k messages to n does k units of work instead of n + k.
 */
export interface ClaudeFinalizeState {
  analyzedCount: number;
  compactionEvents: CompactionEvent[];
  previousAssistantInputTokens: number | null;
  systemPromptEstimate: number | null;
  cumulativeToolResultTokens: number;
  subagents: Map<string, SubagentSnapshot>;
}

export function createClaudeFinalizeState(): ClaudeFinalizeState {
  return {
    analyzedCount: 0,
    compactionEvents: [],
    previousAssistantInputTokens: null,
    systemPromptEstimate: null,
    cumulativeToolResultTokens: 0,
    subagents: new Map(),
  };
}

/** Advances the fold across the messages appended since the previous finalize. */
export function analyzeNewMessages(state: ClaudeFinalizeState, messages: NormalizedMessage[]): void {
  for (let index = state.analyzedCount; index < messages.length; index++) {
    const message = messages[index];
    if (message.type === TOOL_RESULT) accumulateToolResultTokens(state, message);
    if (message.type !== ASSISTANT || !message.tokens) continue;

    detectCompaction(state, message, index);
    attributeTokens(state, message);
  }
  state.analyzedCount = messages.length;
}

/** Rebuilds only the sidechain groups that changed; unchanged ones keep their object. */
export function snapshotSubagents(
  state: ClaudeFinalizeState,
  sidechainMap: Map<string, ClaudeSidechainGroup>,
): SubagentSession[] {
  const subagents: SubagentSession[] = [];
  for (const [parentToolCallId, group] of sidechainMap) {
    if (group.messages.length === 0) continue;
    subagents.push(snapshotGroup(state, parentToolCallId, group));
  }
  return subagents;
}

function snapshotGroup(
  state: ClaudeFinalizeState,
  parentToolCallId: string,
  group: ClaudeSidechainGroup,
): SubagentSession {
  const cached = state.subagents.get(parentToolCallId);
  if (cached && cached.messageCount === group.messages.length && cached.description === group.description) {
    return cached.subagent;
  }

  const subagent: SubagentSession = {
    parentToolCallId,
    description: group.description,
    messages: [...group.messages],
    metrics: totalizeMetrics(group.metrics, group.messages.length),
  };
  state.subagents.set(parentToolCallId, {
    messageCount: group.messages.length,
    description: group.description,
    subagent,
  });
  return subagent;
}

function accumulateToolResultTokens(state: ClaudeFinalizeState, message: NormalizedMessage): void {
  for (const result of message.toolResults) {
    state.cumulativeToolResultTokens += Math.ceil(result.content.length / CHARS_PER_TOKEN);
  }
}

function detectCompaction(state: ClaudeFinalizeState, message: NormalizedMessage, index: number): void {
  const inputTokens = message.tokens?.inputTokens ?? 0;
  const previous = state.previousAssistantInputTokens;

  if (
    previous !== null
    && inputTokens < previous * COMPACTION_DROP_RATIO
    && previous > COMPACTION_MIN_TOKENS
  ) {
    state.compactionEvents.push({
      turnIndex: index,
      tokensBefore: previous,
      tokensAfter: inputTokens,
      timestamp: message.timestamp,
    });
  }
  state.previousAssistantInputTokens = inputTokens;
}

/**
 * The system prompt is estimated from the first assistant turn that carries usage,
 * which is also the first turn that gets an attribution, so the estimate is always
 * settled before it is read.
 */
function attributeTokens(state: ClaudeFinalizeState, message: NormalizedMessage): void {
  const tokens = message.tokens;
  if (!tokens) return;

  state.systemPromptEstimate ??= tokens.cacheCreationTokens
    ?? Math.round(tokens.inputTokens * SYSTEM_PROMPT_INPUT_RATIO);

  const totalInput = tokens.inputTokens;
  const systemPrompt = state.systemPromptEstimate;
  const toolEstimate = Math.min(state.cumulativeToolResultTokens, totalInput - systemPrompt);

  message.attribution = {
    systemPrompt: Math.min(systemPrompt, totalInput),
    toolResults: Math.max(0, toolEstimate),
    conversationHistory: Math.max(0, totalInput - systemPrompt - toolEstimate),
    cacheRead: tokens.cacheReadTokens ?? 0,
  };
}
