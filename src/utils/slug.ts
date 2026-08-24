import { callClaudeCode as callClaudeCli } from './aiCli.js';

interface OpenRouterChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

const AI_CLAUDE_TIMEOUT_MS = 5000;
const OPENROUTER_MODELS = ['google/gemini-2.5-flash', 'x-ai/grok-4-fast:free', 'openai/gpt-4o-mini'];
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

async function callClaudeOneShot(prompt: string): Promise<string | null> {
  const raw = await callClaudeCli(prompt, AI_CLAUDE_TIMEOUT_MS);
  if (!raw) return null;
  return raw.split('\n').slice(0, 5).join(' ').trim() || null;
}

/**
 * Walks the model list, handing each raw completion to `parse`. A model that
 * answers with something `parse` rejects is skipped, so one unusable reply does
 * not cost the whole ladder.
 */
async function callOpenRouterModels<T>(
  prompt: string,
  maxTokens: number,
  parse: (content: string) => T | null,
): Promise<T | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  for (const model of OPENROUTER_MODELS) {
    try {
      const response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature: 0.3,
        }),
      });
      if (!response.ok) continue;

      const data = await response.json() as OpenRouterChatCompletionResponse;
      const content = data.choices?.[0]?.message?.content?.trim();
      const parsed = content ? parse(content) : null;
      if (parsed) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'and', 'but', 'or', 'nor', 'not', 'so', 'yet',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'me', 'my',
  'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'their',
  'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'some', 'any',
  'please', 'just', 'also', 'very', 'really', 'make', 'using', 'use',
]);

// Memorable adjective + noun pairs used when the prompt has no usable keywords
// (empty, all stop-words, or punctuation only). Each call picks a fresh pair
// so worktrees get distinct, glanceable names like `swift-otter`, `lucid-fern`.
const SLUG_ADJECTIVES = [
  'swift', 'brave', 'lucid', 'quiet', 'sunny', 'bold', 'crisp', 'eager',
  'fuzzy', 'gentle', 'jolly', 'keen', 'lively', 'merry', 'nimble', 'plucky',
  'quick', 'silver', 'tidy', 'vivid', 'witty', 'zesty', 'amber', 'cosmic',
  'dusky', 'electric', 'frosty', 'golden', 'hazy', 'iron', 'jade', 'lunar',
  'misty', 'noble', 'ocean', 'pearl', 'rapid', 'solar', 'twilight', 'velvet',
];

const SLUG_NOUNS = [
  'otter', 'fern', 'comet', 'falcon', 'maple', 'river', 'pebble', 'willow',
  'ember', 'finch', 'glade', 'harbor', 'isle', 'koi', 'lark', 'meadow',
  'nova', 'orchid', 'pine', 'quartz', 'raven', 'spruce', 'thicket', 'vale',
  'wren', 'aspen', 'badger', 'cedar', 'dune', 'elm', 'fjord', 'grove',
  'heron', 'iris', 'juniper', 'kestrel', 'lotus', 'moss', 'nest', 'opal',
];

/**
 * Generate a memorable adjective+noun slug for unnamed worktrees.
 * Distinct, readable, and unlikely to collide in practice.
 */
export function generateDefaultSlug(): string {
  const adj = SLUG_ADJECTIVES[Math.floor(Math.random() * SLUG_ADJECTIVES.length)];
  const noun = SLUG_NOUNS[Math.floor(Math.random() * SLUG_NOUNS.length)];
  return `${adj}-${noun}`;
}

/**
 * Coerce any user-supplied string into a filesystem- and git-branch-safe slug:
 * lowercased, alphanumerics/hyphens only, no leading/trailing/duplicate hyphens,
 * capped at 30 chars. Returns '' if nothing usable remains — callers should
 * fall back to {@link generateLocalSlug} or {@link generateDefaultSlug}.
 *
 * This must be applied to any externally-sourced slug base (paneName from the
 * dialog, review prefix concatenations) before it reaches `git worktree add`.
 */
export function sanitizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, ''); // re-trim in case slice landed mid-run
}

/**
 * Fast local slug generation from prompt keywords — no network calls.
 * Extracts 2-3 meaningful words and joins them with hyphens.
 */
export function generateLocalSlug(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

  if (words.length === 0) return generateDefaultSlug();

  const slug = words.slice(0, 3).join('-');
  return slug.slice(0, 30);
}

/**
 * AI-powered slug generation via OpenRouter or Claude CLI.
 * Returns null if all methods fail (caller should keep the local slug).
 */
export const generateAiSlug = async (prompt: string): Promise<string | null> => {
  if (!prompt) return null;

  const instruction = `Generate a 1-2 word kebab-case slug for this prompt. Only respond with the slug, nothing else: "${prompt}"`;
  const fromOpenRouter = await callOpenRouterModels(instruction, 10, sanitizeAiSlug);
  if (fromOpenRouter) return fromOpenRouter;

  const claudeResponse = await callClaudeOneShot(instruction);
  return claudeResponse ? sanitizeAiSlug(claudeResponse) : null;
};

function sanitizeAiSlug(content: string): string | null {
  return content.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || null;
}

/**
 * Original slug generation — tries AI first, falls back to local.
 * Kept for backward compatibility with TUI callers.
 */
export const generateSlug = async (prompt: string): Promise<string> => {
  if (!prompt.trim()) return generateDefaultSlug();
  const aiSlug = await generateAiSlug(prompt);
  return aiSlug || generateLocalSlug(prompt);
};
