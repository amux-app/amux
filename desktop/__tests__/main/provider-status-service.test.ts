import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderStatusService } from '../../src/main/services/ProviderStatusService';
import {
  DISPLAY_POINTS,
  aggregateQuality,
  indicatorToLevel,
  mergeLevel,
  parseArenaSnapshot,
  parseHistoryMap,
  parseOperational,
  parseScores,
  providerMeanHistory,
  smooth,
} from '../../src/main/services/provider-status-parse';

const FAILURE_RETRY_MS = 5 * 60 * 1000;

function resetService(): void {
  (ProviderStatusService as unknown as { instance: ProviderStatusService | undefined }).instance = undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

describe('provider status aggregation', () => {
  beforeEach(() => {
    resetService();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetService();
  });

  it('parses and normalizes score rows, dropping invalid entries', () => {
    // Arrange
    const json = {
      data: [
        { id: 'openai-1', name: 'gpt-5.4', provider: 'OpenAI', score: 66.4, status: 'good', trend: 'up', isStale: false },
        { name: 'missing-fields', provider: 'openai' },
        { name: 'bad-status', provider: 'openai', currentScore: 10, status: 'invalid', trend: 'up' },
      ],
    };

    // Act
    const rows = parseScores(json);

    // Assert
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'gpt-5.4', provider: 'openai', score: 66, status: 'good', trend: 'up' });
  });

  it('aggregates quality with mean score and worst status, preferring non-stale models', () => {
    // Arrange
    const rows = parseScores({
      data: [
        { id: 'a', name: 'a', provider: 'anthropic', currentScore: 80, status: 'good', trend: 'up', isStale: false, lastUpdated: '2026-05-26T10:00:00.000Z' },
        { id: 'b', name: 'b', provider: 'anthropic', currentScore: 60, status: 'warning', trend: 'down', isStale: false, lastUpdated: '2026-05-26T12:00:00.000Z' },
        { id: 'stale', name: 'stale', provider: 'anthropic', currentScore: 10, status: 'critical', trend: 'down', isStale: true, lastUpdated: '2026-05-26T13:00:00.000Z' },
      ],
    });

    // Act
    const quality = aggregateQuality(rows, { a: [76, 80], b: [58, 60], stale: [10] });

    // Assert
    expect(quality.score).toBe(70);
    expect(quality.level).toBe('degraded');
    expect(quality.models.map((m) => m.name)).toEqual(['a', 'b']);
    expect(quality.models[0].history).toEqual(smooth([76, 80], 4));
    expect(quality.models[0].id).toBe('a');
    expect(quality.models[0].measuredAt).toBe(Date.parse('2026-05-26T10:00:00.000Z'));
    expect(quality.models[1].id).toBe('b');
    expect(quality.models[1].measuredAt).toBe(Date.parse('2026-05-26T12:00:00.000Z'));
    expect(quality.measuredAt).toBe(Date.parse('2026-05-26T12:00:00.000Z'));
  });

  it('returns unknown quality when there are no models', () => {
    // Arrange & Act
    const quality = aggregateQuality([], {});

    // Assert
    expect(quality).toEqual({ score: null, level: 'unknown', trend: null, models: [], measuredAt: null });
  });

  it('maps statuspage indicators and parses operational payloads', () => {
    // Arrange & Act & Assert
    expect(indicatorToLevel('none')).toBe('ok');
    expect(indicatorToLevel('minor')).toBe('degraded');
    expect(indicatorToLevel('major')).toBe('down');
    expect(indicatorToLevel('critical')).toBe('down');
    expect(indicatorToLevel('unexpected')).toBe('unknown');
    expect(parseOperational({ status: { indicator: 'none', description: 'All Systems Operational' } })).toEqual({
      level: 'ok',
      description: 'All Systems Operational',
    });
    expect(parseOperational(null)).toEqual({ level: 'unknown', description: null });
  });

  it('merges levels to the worst known signal and ignores unknowns', () => {
    // Arrange & Act & Assert
    expect(mergeLevel('ok', 'degraded')).toBe('degraded');
    expect(mergeLevel('down', 'ok')).toBe('down');
    expect(mergeLevel('unknown', 'ok')).toBe('ok');
    expect(mergeLevel('unknown', 'unknown')).toBe('unknown');
  });

  it('parses model history maps oldest-to-newest with hourly data preferred', () => {
    // Arrange
    const json = {
      data: {
        historyMap: {
          'model-1': [
            { timestamp: '2026-05-27T07:00:00.000Z', score: 84, suite: 'hourly' },
            { timestamp: '2026-05-27T01:00:00.000Z', score: 86, suite: 'hourly' },
            { timestamp: '2026-05-26T19:00:00.000Z', score: 82, suite: 'daily' },
          ],
        },
      },
    };

    // Act
    const history = parseHistoryMap(json);

    // Assert
    expect(history['model-1']).toEqual([86, 84]);
  });

  it('averages provider histories using aligned tail points', () => {
    // Arrange & Act & Assert
    expect(providerMeanHistory([[1, 3, 5], [3, 5, 7]], DISPLAY_POINTS)).toEqual([2, 4, 6]);
    expect(providerMeanHistory([[], []], DISPLAY_POINTS)).toEqual([]);
  });

  it('retries incomplete benchmark data after the shorter failure window', async () => {
    // Arrange
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-27T07:00:00.000Z'));

    let scoresCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/dashboard/cached')) {
        scoresCalls += 1;
        if (scoresCalls === 1) return jsonResponse({ error: 'temporarily unavailable' }, 503);
        return jsonResponse({
          data: {
            historyMap: {},
            modelScores: [
              { id: 'gpt-5.4', name: 'gpt-5.4', provider: 'openai', currentScore: 80, status: 'good', trend: 'up', isStale: false },
              { id: 'claude-opus-4-6', name: 'claude-opus-4-6', provider: 'anthropic', currentScore: 74, status: 'good', trend: 'stable', isStale: false },
            ],
          },
        });
      }
      if (url.includes('arena-ai-leaderboards')) {
        return jsonResponse({ meta: { model_count: 50 }, models: [] });
      }
      return jsonResponse({ status: { indicator: 'none', description: 'All Systems Operational' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    // Act
    const service = ProviderStatusService.getInstance();
    const first = await service.getStatus();
    vi.setSystemTime(new Date(Date.parse('2026-05-27T07:00:00.000Z') + FAILURE_RETRY_MS + 1));
    const second = await service.getStatus();

    // Assert
    expect(first.statuses.openai?.quality.score).toBeNull();
    expect(second.statuses.openai?.quality.score).toBe(80);
    // 2x scores + 2x anthropic + 2x openai + 2x arena
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('surfaces providers without a status page and treats them as complete', async () => {
    // Arrange
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-27T07:00:00.000Z'));

    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/dashboard/cached')) {
        return jsonResponse({
          data: {
            historyMap: {},
            modelScores: [
              { id: 'gpt-5.4', name: 'gpt-5.4', provider: 'openai', currentScore: 80, status: 'good', trend: 'up', isStale: false },
              { id: 'claude-opus-4-6', name: 'claude-opus-4-6', provider: 'anthropic', currentScore: 74, status: 'good', trend: 'stable', isStale: false },
              { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', provider: 'deepseek', currentScore: 62, status: 'warning', trend: 'stable', isStale: false },
            ],
          },
        });
      }
      if (url.includes('arena-ai-leaderboards')) {
        return jsonResponse({ meta: { model_count: 50 }, models: [] });
      }
      return jsonResponse({ status: { indicator: 'none', description: 'All Systems Operational' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    // Act
    const service = ProviderStatusService.getInstance();
    const first = await service.getStatus();
    vi.setSystemTime(new Date(Date.parse('2026-05-27T07:00:00.000Z') + FAILURE_RETRY_MS + 1));
    const second = await service.getStatus();

    // Assert
    expect(first.statuses.deepseek?.quality.score).toBe(62);
    expect(first.statuses.deepseek?.operational.level).toBe('unknown');
    expect(first.statuses.deepseek?.level).toBe('degraded');
    expect(second).toBe(first);
    // 1x scores + 1x anthropic + 1x openai + 1x arena (one round only — cache hit on second call)
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('parses an Arena snapshot, maps vendor → provider, and indexes by provider', () => {
    // Arrange
    const json = {
      meta: { leaderboard: 'text', model_count: 50, fetched_at: '2026-06-20T06:00:00Z' },
      models: [
        { rank: 1, model: 'claude-fable-5', vendor: 'Anthropic', score: 1508, ci: 9, votes: 4297 },
        { rank: 2, model: 'gpt-5.4', vendor: 'OpenAI', score: 1502, ci: 4, votes: 32629 },
        { rank: 3, model: 'kimi-k2-thinking', vendor: 'Moonshot AI', score: 1432, ci: 7, votes: 8121 },
        { rank: 4, model: 'glm-4.7', vendor: 'Z.ai', score: 1410, ci: 8, votes: 5102 },
        { rank: 99, model: 'broken', vendor: 'X' /* missing score */ },
      ],
    };

    // Act
    const snapshot = parseArenaSnapshot(json, 1_000_000);

    // Assert
    expect(snapshot.entries).toHaveLength(4);
    expect(snapshot.totalRanked).toBe(50);
    expect(snapshot.fetchedAt).toBe(1_000_000);
    expect(snapshot.byProvider.get('anthropic')?.[0]?.modelName).toBe('claude-fable-5');
    expect(snapshot.byProvider.get('kimi')?.[0]?.modelName).toBe('kimi-k2-thinking');
    expect(snapshot.byProvider.get('glm')?.[0]?.modelName).toBe('glm-4.7');
  });

  it('attaches Arena entry to matching aistupidlevel rows (exact and prefix match)', () => {
    // Arrange — aistupidlevel reports the dated id; Arena lists the short id
    const arena = parseArenaSnapshot(
      {
        meta: { model_count: 50 },
        models: [
          { rank: 4, model: 'claude-opus-4-6', vendor: 'Anthropic', score: 1499, ci: 4, votes: 49596 },
          { rank: 7, model: 'gpt-5.4', vendor: 'OpenAI', score: 1487, ci: 5, votes: 33793 },
        ],
      },
      0,
    );
    const rows = parseScores({
      data: [
        { id: '1', name: 'claude-opus-4-6', provider: 'anthropic', currentScore: 63, status: 'warning', trend: 'down', isStale: false, lastUpdated: '2026-06-19T12:00:00.000Z' },
        { id: '2', name: 'gpt-5.4-preview-20260101', provider: 'openai', currentScore: 70, status: 'good', trend: 'stable', isStale: false, lastUpdated: '2026-06-19T12:00:00.000Z' },
      ],
    });

    // Act
    const anthropic = aggregateQuality(rows.filter((r) => r.provider === 'anthropic'), {}, arena);
    const openai = aggregateQuality(rows.filter((r) => r.provider === 'openai'), {}, arena);

    // Assert
    expect(anthropic.models[0].arena).toEqual({ rank: 4, elo: 1499, ci: 4, votes: 49596 });
    expect(anthropic.arenaTotal).toBe(50);
    expect(openai.models[0].arena).toEqual({ rank: 7, elo: 1487, ci: 5, votes: 33793 });
  });

  it('short-circuits without fetching when disabled via setDisabled', async () => {
    // Arrange
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = ProviderStatusService.getInstance();
    service.setDisabled(true);

    // Act
    const result = await service.getStatus();

    // Assert
    expect(result.statuses).toEqual({});
    expect(result.fetchedAt).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('short-circuits without fetching when AUMX_DISABLE_EXTERNAL_STATUS is set', async () => {
    // Arrange
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('AUMX_DISABLE_EXTERNAL_STATUS', '1');
    const service = ProviderStatusService.getInstance();

    // Act
    const result = await service.getStatus();

    // Assert
    expect(result.statuses).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves Arena field undefined when there is no match or modelId is too short', () => {
    // Arrange
    const arena = parseArenaSnapshot(
      {
        meta: { model_count: 50 },
        models: [
          { rank: 1, model: 'claude-opus-4-6', vendor: 'Anthropic', score: 1499, ci: 4, votes: 49596 },
        ],
      },
      0,
    );
    const rows = parseScores({
      data: [
        // No provider match — different provider
        { id: 'x', name: 'gpt-5.4', provider: 'openai', currentScore: 70, status: 'good', trend: 'stable', isStale: false },
        // Too-short ambiguous prefix should NOT match
        { id: 'y', name: 'claude', provider: 'anthropic', currentScore: 70, status: 'good', trend: 'stable', isStale: false },
      ],
    });

    // Act
    const openai = aggregateQuality(rows.filter((r) => r.provider === 'openai'), {}, arena);
    const anthropic = aggregateQuality(rows.filter((r) => r.provider === 'anthropic'), {}, arena);

    // Assert
    expect(openai.models[0].arena).toBeUndefined();
    expect(anthropic.models[0].arena).toBeUndefined();
  });
});
