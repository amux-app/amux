import type {
  ClaudeContentBlock,
  ClaudeJsonlEntry,
  ClaudeTextBlock,
  ClaudeThinkingBlock,
  ClaudeToolResultBlock,
  ClaudeToolUseBlock,
  ClaudeUsage,
} from './claude-jsonl-types.js';
import type {
  MessageTokens,
  NormalizedMessage,
  NormalizedToolCall,
  NormalizedToolResult,
} from '../../../shared/agent-session-types.js';

// Claude Code injects synthetic "user" entries into the JSONL when slash
// commands run. Some are flagged with `isMeta: true` (the caveat header),
// others are not (`<command-name>`, `<local-command-stdout>`, etc.). We drop
// both kinds so the conversation, pane title, recaps, and topics only see
// real user input.
const SYNTHETIC_USER_MESSAGE_PATTERN =
  /^\s*<(local-command-caveat|local-command-stdout|command-name|command-message|command-args|task-notification)\b/i;

/** The fields the accumulator reads straight off a raw entry, before conversion. */
export interface RawClaudeEntry {
  type?: string;
  isSidechain?: boolean;
  message?: {
    content?: string | ClaudeContentBlock[];
    stop_reason?: string | null;
  };
  content?: string | ClaudeContentBlock[];
  subtype?: string;
  operation?: string;
  timestamp?: string;
  stop_reason?: string | null;
  aiTitle?: string;
}

export function convertEntry(entry: ClaudeJsonlEntry, index: number): NormalizedMessage | null {
  const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : undefined;
  const id = entry.uuid || `claude-${index}`;

  switch (entry.type) {
    case 'user':
      return convertUserEntry(entry, id, timestamp);
    case 'assistant': {
      const blocks = entry.message?.content ?? entry.content;
      const thinkingContent = extractThinkingContent(blocks);
      return {
        id,
        type: 'assistant',
        timestamp,
        content: extractTextContent(blocks),
        thinkingContent: thinkingContent || undefined,
        tokens: extractTokens(entry.message?.usage ?? entry.usage),
        toolCalls: extractToolCalls(blocks),
        toolResults: [],
        model: entry.message?.model,
      };
    }
    case 'system': {
      const content = extractTextContent(entry.message?.content ?? entry.content);
      if (!content) return null;
      return { id, type: 'system', timestamp, content, toolCalls: [], toolResults: [] };
    }
    case 'result':
      return {
        id,
        type: 'assistant',
        timestamp,
        content: extractTextContent(entry.message?.content ?? entry.content) || '',
        tokens: extractTokens(entry.usage ?? entry.message?.usage),
        toolCalls: [],
        toolResults: [],
      };
    default:
      return null;
  }
}

// Drop slash-command / caveat synthetic entries entirely so they don't pollute
// the conversation, recaps, or topic extraction. Tool results are kept regardless.
function convertUserEntry(
  entry: ClaudeJsonlEntry,
  id: string,
  timestamp: number | undefined,
): NormalizedMessage | null {
  const rawContent = entry.message?.content ?? entry.content;
  const content = extractTextContent(rawContent);
  const toolResults = extractToolResults(rawContent);

  if (toolResults.length === 0 && (entry.isMeta === true || isSyntheticUserContent(content))) return null;
  if (!content && toolResults.length === 0) return null;

  return {
    id,
    type: toolResults.length > 0 ? 'tool_result' : 'user',
    timestamp,
    content,
    toolCalls: [],
    toolResults,
  };
}

function isSyntheticUserContent(content: string | undefined): boolean {
  return typeof content === 'string' && SYNTHETIC_USER_MESSAGE_PATTERN.test(content);
}

function extractTextContent(content: string | ClaudeContentBlock[] | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is ClaudeTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function extractThinkingContent(content: string | ClaudeContentBlock[] | undefined): string {
  if (!content || typeof content === 'string') return '';
  return content
    .filter((b): b is ClaudeThinkingBlock => b.type === 'thinking')
    .map((b) => b.thinking)
    .join('\n');
}

function extractToolCalls(content: string | ClaudeContentBlock[] | undefined): NormalizedToolCall[] {
  if (!content || typeof content === 'string') return [];
  return content
    .filter((b): b is ClaudeToolUseBlock => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
}

function extractToolResults(content: string | ClaudeContentBlock[] | undefined): NormalizedToolResult[] {
  if (!content || typeof content === 'string') return [];
  return content
    .filter((b): b is ClaudeToolResultBlock => b.type === 'tool_result')
    .map((b) => ({
      toolCallId: b.tool_use_id,
      content: typeof b.content === 'string'
        ? b.content
        : b.content?.map((c) => c.text ?? '').join('\n') ?? '',
      isError: b.is_error ?? false,
    }));
}

export function extractAskUserQuestion(content: string | ClaudeContentBlock[] | undefined): string | undefined {
  if (!content || typeof content === 'string') return undefined;
  for (const block of content) {
    if (block.type !== 'tool_use' || block.name !== 'AskUserQuestion') continue;
    const questions = Array.isArray((block.input as Record<string, unknown>).questions)
      ? ((block.input as Record<string, unknown>).questions as Array<Record<string, unknown>>)
      : [];
    const firstQuestion = questions.find((question) => typeof question.question === 'string');
    if (typeof firstQuestion?.question === 'string' && firstQuestion.question.trim()) {
      return firstQuestion.question.trim();
    }
    return 'Agent is waiting for input';
  }
  return undefined;
}

export function extractAssistantStopReason(entry: RawClaudeEntry): string | undefined {
  const reason = entry.message?.stop_reason ?? entry.stop_reason;
  if (typeof reason !== 'string') return undefined;
  const trimmed = reason.trim();
  return trimmed ? trimmed : undefined;
}

function extractTokens(usage: ClaudeUsage | undefined): MessageTokens | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
  };
}

// One Anthropic API call can be written as several JSONL entries (thinking + text + tool_use),
// each carrying the same terminal `usage`. We keep the entries for display but strip tokens
// from duplicates so session totals reflect a single API call.
export function deduplicateApiMessage(
  entry: ClaudeJsonlEntry,
  message: NormalizedMessage,
  seenApiMessageIds: Set<string>,
): void {
  const apiMessageId = entry.message?.id;
  if (!apiMessageId) return;
  if (seenApiMessageIds.has(apiMessageId)) {
    message.tokens = undefined;
    return;
  }
  seenApiMessageIds.add(apiMessageId);
}
