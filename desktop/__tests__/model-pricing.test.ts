import { describe, expect, it } from 'vitest';
import { estimateCostUSD } from '../src/shared/model-pricing';

describe('estimateCostUSD', () => {
  it('charges opus rates for 1M in + 1M out', () => {
    // Opus: $15/M input + $75/M output = $90
    const cost = estimateCostUSD(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      'claude-opus-4-8',
    );
    expect(cost).toBeCloseTo(90, 6);
  });

  it('charges haiku rates for haiku model id', () => {
    // Haiku: $1/M input + $5/M output → 1k+1k tokens → $0.001 + $0.005 = $0.006
    const cost = estimateCostUSD(
      { inputTokens: 1_000, outputTokens: 1_000 },
      'claude-haiku-4-5',
    );
    expect(cost).toBeCloseTo(0.006, 6);
  });

  it('includes cache read and cache write tokens', () => {
    // Sonnet: cacheRead $0.30/M, cacheWrite $3.75/M
    const cost = estimateCostUSD(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 1_000_000,
      },
      'claude-sonnet-4-6',
    );
    expect(cost).toBeCloseTo(0.3 + 3.75, 6);
  });

  it('falls back to sonnet pricing for unknown model', () => {
    const known = estimateCostUSD({ inputTokens: 1000, outputTokens: 1000 }, 'claude-sonnet-4-6');
    const unknown = estimateCostUSD({ inputTokens: 1000, outputTokens: 1000 }, 'made-up-model');
    expect(unknown).toBeCloseTo(known, 9);
  });

  it('falls back to opus pricing for opus-prefixed unknown versions', () => {
    const opus = estimateCostUSD({ inputTokens: 1000, outputTokens: 1000 }, 'claude-opus-4-8');
    const future = estimateCostUSD({ inputTokens: 1000, outputTokens: 1000 }, 'claude-opus-9-9');
    expect(future).toBeCloseTo(opus, 9);
  });

  it('returns 0 for empty usage', () => {
    expect(estimateCostUSD({ inputTokens: 0, outputTokens: 0 }, 'claude-opus-4-8')).toBe(0);
  });
});
