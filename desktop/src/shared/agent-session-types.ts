export type AgentType = 'claude' | 'codex' | 'opencode' | 'pi';

export const SESSION_PARSING_AGENTS = ['claude', 'codex', 'opencode', 'pi'] as const satisfies readonly AgentType[];

export function agentHasSessionParsing(agent: string | undefined): boolean {
  return SESSION_PARSING_AGENTS.some((candidate) => candidate === agent);
}

export interface NormalizedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  timestamp?: number;
}

export interface NormalizedToolResult {
  toolCallId: string;
  content: string;
  isError: boolean;
  durationMs?: number;
}

export type MessageType = 'user' | 'assistant' | 'system' | 'tool_result';

export type CostSource = 'otlp' | 'estimate' | 'mixed' | 'none';

export interface NormalizedMessage {
  id: string;
  type: MessageType;
  timestamp?: number;
  content: string;
  thinkingContent?: string;
  tokens?: MessageTokens;
  attribution?: TokenAttribution;
  toolCalls: NormalizedToolCall[];
  toolResults: NormalizedToolResult[];
  model?: string;
}

export interface MessageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUSD?: number;
  costSource?: Exclude<CostSource, 'mixed' | 'none'>;
}

export interface CompactionEvent {
  turnIndex: number;
  tokensBefore: number;
  tokensAfter: number;
  timestamp?: number;
}

export interface TokenAttribution {
  systemPrompt: number;
  conversationHistory: number;
  toolResults: number;
  cacheRead: number;
}

export interface SessionMetrics {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  messageCount: number;
  toolCallCount: number;
  costUSD: number;
  costSource: CostSource;
}

export interface SubagentSession {
  parentToolCallId: string;
  description: string;
  messages: NormalizedMessage[];
  metrics: SessionMetrics;
}

export interface NormalizedSession {
  agent: AgentType;
  sessionId: string;
  title?: string;
  messages: NormalizedMessage[];
  metrics: SessionMetrics;
  compactionEvents: CompactionEvent[];
  subagents: SubagentSession[];
  isOngoing: boolean;
  turnCompleted?: boolean;
  awaitingUserInput?: boolean;
  pendingUserQuestion?: string;
  startTime?: number;
  lastUpdateTime?: number;
  aiTitle?: string;
  providerId?: string;
  modelId?: string;
}

export function createEmptyMetrics(): SessionMetrics {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    messageCount: 0,
    toolCallCount: 0,
    costUSD: 0,
    costSource: 'none',
  };
}

/**
 * Closes out accumulated metrics. `totalTokens` is only derived from the parts when
 * the log itself never reported a total — Codex records an authoritative session
 * total that must not be recomputed, and Claude records none.
 */
export function totalizeMetrics(source: SessionMetrics, messageCount: number): SessionMetrics {
  const metrics = { ...source };
  if (metrics.totalTokens === 0) {
    metrics.totalTokens =
      metrics.inputTokens + metrics.outputTokens + metrics.cacheReadTokens + metrics.cacheCreationTokens;
  }
  metrics.messageCount = messageCount;
  return metrics;
}

export function createEmptySession(agent: AgentType, sessionId: string): NormalizedSession {
  return {
    agent,
    sessionId,
    messages: [],
    metrics: createEmptyMetrics(),
    compactionEvents: [],
    subagents: [],
    isOngoing: false,
    turnCompleted: false,
    awaitingUserInput: false,
  };
}
