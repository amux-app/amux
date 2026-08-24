import type { MessageTokens } from './agent-session-types';

interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// USD per million tokens. Anthropic public list prices.
const OPUS: ModelPricing = { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 };
const SONNET: ModelPricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const HAIKU: ModelPricing = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };

const MODEL_PRICING_USD_PER_MTOK: Readonly<Record<string, ModelPricing>> = {
  'claude-fable-5': OPUS,
  'claude-opus-4-8': OPUS,
  'claude-opus-4-7': OPUS,
  'claude-opus-4-6': OPUS,
  'claude-sonnet-4-6': SONNET,
  'claude-sonnet-4-5': SONNET,
  'claude-haiku-4-5': HAIKU,
  'claude-haiku-4-5-20251001': HAIKU,
};

function pricingFor(model: string | undefined): ModelPricing {
  if (!model) return SONNET;
  const exact = MODEL_PRICING_USD_PER_MTOK[model];
  if (exact) return exact;
  if (model.includes('opus') || model.includes('fable')) return OPUS;
  if (model.includes('haiku')) return HAIKU;
  return SONNET;
}

export function estimateCostUSD(tokens: MessageTokens, model: string | undefined): number {
  const p = pricingFor(model);
  const M = 1_000_000;
  return (
    (tokens.inputTokens * p.input) / M
    + (tokens.outputTokens * p.output) / M
    + ((tokens.cacheReadTokens ?? 0) * p.cacheRead) / M
    + ((tokens.cacheCreationTokens ?? 0) * p.cacheWrite) / M
  );
}
