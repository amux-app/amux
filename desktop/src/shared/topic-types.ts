import type { AgentType } from './agent-session-types.js';

export interface ConversationTopic {
  id: string;
  label: string;
  refined: boolean;
  messageStartIndex: number;
  messageEndIndex: number;
  messageCount: number;
  startTime?: number;
  endTime?: number;
}

export interface PaneTopics {
  paneId: string;
  sessionId: string;
  agent: AgentType;
  topics: ConversationTopic[];
  updatedAt: number;
}
