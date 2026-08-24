import type {
  ProviderId,
  ProviderStatusMap,
  ProviderStatusResponse,
} from '../../shared/ipc-types.js';
import { hasCompleteProviderStatusMap, OPERATIONAL_PROVIDER_IDS, PROVIDER_IDS } from '../../shared/provider-status.js';
import {
  DISPLAY_POINTS,
  aggregateQuality,
  mergeLevel,
  parseArenaSnapshot,
  parseHistoryMap,
  parseOperational,
  parseScores,
  providerMeanHistory,
  type ArenaSnapshot,
} from './provider-status-parse.js';
import { log } from './Logger.js';

const CACHE_TTL_MS = 60 * 60 * 1000;
const FAILURE_RETRY_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const ARENA_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const CACHED_URL = 'https://aistupidlevel.info/dashboard/cached';
const ARENA_URL = 'https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=text';
const OPERATIONAL_URLS: Record<(typeof OPERATIONAL_PROVIDER_IDS)[number], string> = {
  anthropic: 'https://status.claude.com/api/v2/status.json',
  openai: 'https://status.openai.com/api/v2/status.json',
};

export class ProviderStatusService {
  private static instance: ProviderStatusService;
  private cache: ProviderStatusResponse | null = null;
  private cacheComplete = false;
  private inFlight: Promise<ProviderStatusResponse> | null = null;
  private arenaCache: ArenaSnapshot | null = null;
  private arenaCacheAt = 0;
  private arenaInFlight: Promise<ArenaSnapshot | null> | null = null;
  private disabled = false;

  static getInstance(): ProviderStatusService {
    if (!ProviderStatusService.instance) {
      ProviderStatusService.instance = new ProviderStatusService();
    }
    return ProviderStatusService.instance;
  }

  setDisabled(disabled: boolean): void {
    this.disabled = disabled;
  }

  async getStatus(): Promise<ProviderStatusResponse> {
    if (this.disabled || process.env.AUMX_DISABLE_EXTERNAL_STATUS) {
      return { statuses: {}, fetchedAt: Date.now() };
    }
    const ttl = this.cacheComplete ? CACHE_TTL_MS : FAILURE_RETRY_MS;
    if (this.cache && Date.now() - this.cache.fetchedAt < ttl) {
      return this.cache;
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.fetchAll().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetchAll(): Promise<ProviderStatusResponse> {
    const fetchedAt = Date.now();
    const [cachedJson, operationalByProvider, arena] = await Promise.all([
      fetchJson(CACHED_URL),
      this.fetchOperational(),
      this.getArenaSnapshot(),
    ]);

    const rows = parseScores(cachedJson);
    const historyById = parseHistoryMap(cachedJson);
    const statuses: ProviderStatusMap = {};

    PROVIDER_IDS.forEach((provider) => {
      const quality = aggregateQuality(
        rows.filter((row) => row.provider === provider),
        historyById,
        arena ?? undefined,
      );
      const operational = parseOperational(operationalByProvider[provider] ?? null);
      statuses[provider] = {
        provider,
        level: mergeLevel(quality.level, operational.level),
        quality,
        operational,
        sparkline: providerMeanHistory(quality.models.map((model) => model.history), DISPLAY_POINTS),
        updatedAt: fetchedAt,
      };
    });

    this.cacheComplete = hasCompleteProviderStatusMap(statuses);
    this.cache = { statuses, fetchedAt };
    log.info('provider-status', 'refreshed', {
      complete: this.cacheComplete,
      arena: arena ? arena.entries.length : 0,
      levels: PROVIDER_IDS.map((provider) => `${provider}:${statuses[provider]?.level}`).join(','),
    });
    return this.cache;
  }

  private async getArenaSnapshot(): Promise<ArenaSnapshot | null> {
    if (this.arenaCache && Date.now() - this.arenaCacheAt < ARENA_CACHE_TTL_MS) {
      return this.arenaCache;
    }
    if (this.arenaInFlight) return this.arenaInFlight;
    this.arenaInFlight = this.fetchArenaSnapshot().finally(() => {
      this.arenaInFlight = null;
    });
    return this.arenaInFlight;
  }

  private async fetchArenaSnapshot(): Promise<ArenaSnapshot | null> {
    const json = await fetchJson(ARENA_URL);
    if (!json) return this.arenaCache;
    const snapshot = parseArenaSnapshot(json, Date.now());
    if (snapshot.entries.length === 0) return this.arenaCache;
    this.arenaCache = snapshot;
    this.arenaCacheAt = Date.now();
    return snapshot;
  }

  private async fetchOperational(): Promise<Partial<Record<ProviderId, unknown>>> {
    const entries = await Promise.all(
      OPERATIONAL_PROVIDER_IDS.map(async (provider) =>
        [provider, await fetchJson(OPERATIONAL_URLS[provider])] as const,
      ),
    );
    return Object.fromEntries(entries);
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) {
      log.warn('provider-status', 'non-ok response', { url, status: response.status });
      return null;
    }
    return await response.json();
  } catch (error) {
    log.warn('provider-status', 'fetch failed', { url, error: String(error) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
