import type { NormalizedMessage } from '../../shared/agent-session-types';

const INJECTED_PREFIXES = [
  '<local-command-caveat>',
  '<command-name>',
  '<command-message>',
  '<system-reminder>',
] as const;

export interface ConversationTurn {
  index: number;
  prompt: NormalizedMessage;
  responses: NormalizedMessage[];
}

export function isRealUserPrompt(msg: NormalizedMessage): boolean {
  const text = msg.content.trim();
  if (!text) return false;
  if (text.includes('<command-name>')) return false;
  return !INJECTED_PREFIXES.some((prefix) => text.startsWith(prefix));
}

export function groupIntoTurns(messages: NormalizedMessage[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let turnIndex = 0;
  let i = 0;

  while (i < messages.length) {
    if (messages[i].type !== 'user' || !isRealUserPrompt(messages[i])) {
      i++;
      continue;
    }

    const promptParts: NormalizedMessage[] = [messages[i]];
    let j = i + 1;
    while (j < messages.length && messages[j].type === 'user') {
      promptParts.push(messages[j]);
      j++;
    }

    const responses: NormalizedMessage[] = [];
    while (j < messages.length) {
      if (messages[j].type === 'user' && isRealUserPrompt(messages[j])) break;
      if (messages[j].type === 'assistant' && messages[j].content.trim()) {
        responses.push(messages[j]);
      }
      j++;
    }

    const primaryPrompt = promptParts.find(isRealUserPrompt) ?? promptParts[0];
    turns.push({ index: turnIndex++, prompt: primaryPrompt, responses });
    i = j;
  }

  return turns;
}
