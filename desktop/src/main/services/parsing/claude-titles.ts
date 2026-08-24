import { getString, parseJsonRecord, type JsonRecord } from './jsonl-values.js';

const AI_TITLE_ENTRY_TYPE = 'ai-title';
const AI_TITLE_LINE_TOKEN = `"${AI_TITLE_ENTRY_TYPE}"`;
const GENERIC_CLAUDE_TITLE = 'claude code';
const TITLE_DECORATION_PATTERN = /^\s*(?:✳|\*)\s*/;

/** Display form of a Claude ai-title: decoration stripped, original casing kept. */
export function cleanClaudeTitle(title: string): string | null {
  const cleaned = title
    .replace(TITLE_DECORATION_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.toLowerCase() === GENERIC_CLAUDE_TITLE) return null;
  return cleaned;
}

/** Match form of a Claude ai-title, used to compare a tmux pane title to a session. */
export function normalizeClaudeTitle(title: string): string | null {
  return cleanClaudeTitle(title)?.toLowerCase() ?? null;
}

/** The raw title an `ai-title` record carries, or null for any other record. */
export function extractAiTitle(entry: JsonRecord): string | null {
  if (entry.type !== AI_TITLE_ENTRY_TYPE) return null;
  return getString(entry.aiTitle)?.trim() || null;
}

/** Newest `ai-title` in the given JSONL lines, scanning from the end. */
export function findLatestAiTitle(lines: string[]): string | null {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!line.includes(AI_TITLE_LINE_TOKEN)) continue;

    const entry = parseJsonRecord(line);
    const title = entry ? extractAiTitle(entry) : null;
    if (title) return title;
  }
  return null;
}
