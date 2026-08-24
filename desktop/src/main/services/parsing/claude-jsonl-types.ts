// Raw Claude Code JSONL entry types — mirrors the on-disk format

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ClaudeToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ClaudeToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

export interface ClaudeTextBlock {
  type: 'text';
  text: string;
}

export interface ClaudeThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeThinkingBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock;

export interface ClaudeJsonlEntry {
  type:
    | 'user'
    | 'assistant'
    | 'system'
    | 'result'
    | 'summary'
    | 'queue-operation'
    | 'progress'
    | 'file-history-snapshot';
  role?: string;
  message?: {
    id?: string;
    role?: string;
    content?: string | ClaudeContentBlock[];
    usage?: ClaudeUsage;
    model?: string;
    stop_reason?: string | null;
    stop_sequence?: string | null;
  };
  content?: string | ClaudeContentBlock[];
  timestamp?: string;
  uuid?: string;
  sessionId?: string;
  duration_ms?: number;
  costUSD?: number;
  usage?: ClaudeUsage;
  isSidechain?: boolean;
  isMeta?: boolean;
  stop_reason?: string | null;
  stop_sequence?: string | null;
}
