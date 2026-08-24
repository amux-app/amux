import type { MessageTokens, NormalizedMessage, NormalizedSession } from './agent-session-types';

export interface AssistantUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextTokens: number;
  totalUsageTokens: number;
}

export interface SessionDisplayMetrics {
  promptCount: number;
  assistantTurnCount: number;
  conversationTurnCount: number;
  eventCount: number;
  latestAssistantUsage: AssistantUsageSnapshot | null;
}

function isUserPromptMessage(message: NormalizedMessage): boolean {
  return message.type === 'user' && message.content.trim().length > 0;
}

function isAssistantTurnMessage(message: NormalizedMessage): boolean {
  return message.type === 'assistant'
    && (
      message.content.trim().length > 0
      || (message.thinkingContent?.trim().length ?? 0) > 0
      || message.toolCalls.length > 0
      || message.toolResults.length > 0
      || !!message.tokens
    );
}

export function getUsageSnapshot(tokens?: MessageTokens): AssistantUsageSnapshot | null {
  if (!tokens) return null;

  const cacheReadTokens = tokens.cacheReadTokens ?? 0;
  const cacheCreationTokens = tokens.cacheCreationTokens ?? 0;
  const contextTokens = tokens.inputTokens + cacheReadTokens + cacheCreationTokens;
  const totalUsageTokens = contextTokens + tokens.outputTokens;

  return {
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    contextTokens,
    totalUsageTokens,
  };
}

function getLatestAssistantUsage(messages: NormalizedMessage[]): AssistantUsageSnapshot | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type !== 'assistant') continue;
    const usage = getUsageSnapshot(message.tokens);
    if (usage) return usage;
  }
  return null;
}

function computeConversationTurnCount(messages: NormalizedMessage[]): number {
  let count = 0;
  let awaitingAssistant = false;
  let assistantTurns = 0;

  for (const message of messages) {
    if (isUserPromptMessage(message)) {
      count += 1;
      awaitingAssistant = true;
      continue;
    }

    if (!isAssistantTurnMessage(message)) continue;

    assistantTurns += 1;
    if (awaitingAssistant) {
      count += 1;
      awaitingAssistant = false;
    }
  }

  return count > 0 ? count : assistantTurns;
}

export function computeSessionDisplayMetrics(session: NormalizedSession): SessionDisplayMetrics {
  const promptCount = session.messages.filter(isUserPromptMessage).length;
  const assistantTurnCount = session.messages.filter(isAssistantTurnMessage).length;

  return {
    promptCount,
    assistantTurnCount,
    conversationTurnCount: computeConversationTurnCount(session.messages),
    eventCount: session.messages.length,
    latestAssistantUsage: getLatestAssistantUsage(session.messages),
  };
}
