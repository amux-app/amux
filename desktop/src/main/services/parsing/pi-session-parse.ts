import { asRecord } from './jsonl-values.js';

export function piExtractTextContent(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    const block = asRecord(item);
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      return block.text.trim();
    }
  }
  return null;
}
