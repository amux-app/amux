import type { NormalizedMessage, NormalizedSession } from '../../../shared/agent-session-types.js';
import type { ConversationTopic } from '../../../shared/topic-types.js';

const HEURISTIC_LABEL_WORDS = 8;
const HEURISTIC_LABEL_CHARS = 80;

export class TopicService {
  computeTopics(session: NormalizedSession): ConversationTopic[] {
    const topics: ConversationTopic[] = [];
    let current: ConversationTopic | null = null;

    session.messages.forEach((message, index) => {
      if (this.isUserPrompt(message)) {
        if (current) topics.push(current);
        current = this.startTopic(session.sessionId, message, index);
        return;
      }
      if (current) {
        current.messageEndIndex = index;
        current.messageCount += 1;
        if (message.timestamp) current.endTime = message.timestamp;
      }
    });

    if (current) topics.push(current);
    return topics;
  }

  private startTopic(sessionId: string, message: NormalizedMessage, index: number): ConversationTopic {
    return {
      id: `${sessionId}:${index}`,
      label: this.heuristicLabel(message.content),
      refined: false,
      messageStartIndex: index,
      messageEndIndex: index,
      messageCount: 1,
      startTime: message.timestamp,
      endTime: message.timestamp,
    };
  }

  private isUserPrompt(message: NormalizedMessage): boolean {
    return message.type === 'user' && message.content.trim().length > 0;
  }

  private heuristicLabel(content: string): string {
    const lines = content.trim().split('\n');
    const firstLine = lines.find((line) => line.trim().length > 0) ?? content.trim();
    const label = this.truncateWords(firstLine.trim(), HEURISTIC_LABEL_WORDS);
    return Array.from(label).slice(0, HEURISTIC_LABEL_CHARS).join('').trimEnd();
  }

  private truncateWords(value: string, maxWords: number): string {
    const words = value.split(/\s+/).filter(Boolean);
    return words.length <= maxWords ? value : words.slice(0, maxWords).join(' ');
  }
}
