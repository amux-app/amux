import type {
  ProviderArenaEntry,
  ProviderHealthLevel,
  ProviderModelScore,
  ProviderOperational,
  ProviderQuality,
} from '../../shared/ipc-types.js';

type QualityStatus = ProviderModelScore['status'];
type Trend = ProviderModelScore['trend'];
type KnownLevel = Exclude<ProviderHealthLevel, 'unknown'>;

const QUALITY_SEVERITY: Record<QualityStatus, number> = { good: 0, warning: 1, critical: 2 };
const LEVEL_SEVERITY: Record<KnownLevel, number> = { ok: 0, degraded: 1, down: 2 };

const SMOOTH_WINDOW = 4;
export const DISPLAY_POINTS = 24;
const RAW_WINDOW = DISPLAY_POINTS + SMOOTH_WINDOW;

export interface ScoreRow {
  id: string;
  name: string;
  provider: string;
  score: number;
  status: QualityStatus;
  trend: Trend;
  isStale: boolean;
  measuredAt: number;
}

interface HistoryPoint {
  t: number;
  score: number;
  suite: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeTrend(value: unknown): Trend {
  if (value === 'up' || value === 'down' || value === 'stable') return value;
  return 'stable';
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

function parseScore(value: Record<string, unknown>): number | null {
  if (typeof value.currentScore === 'number') return value.currentScore;
  if (typeof value.score === 'number') return value.score;
  return null;
}

function normalizeScoreRow(value: unknown): ScoreRow | null {
  if (!isObject(value)) return null;
  const { id, name, provider, status } = value;
  const score = parseScore(value);
  if (typeof name !== 'string' || typeof provider !== 'string') return null;
  if (score === null) return null;
  if (status !== 'good' && status !== 'warning' && status !== 'critical') return null;
  return {
    id: typeof id === 'string' ? id : String(id ?? ''),
    name,
    provider: provider.toLowerCase(),
    score: Math.round(score),
    status,
    trend: normalizeTrend(value.trend),
    isStale: value.isStale === true,
    measuredAt: parseTimestamp(value.lastUpdated),
  };
}

function extractRows(json: unknown): unknown[] {
  if (!isObject(json)) return [];
  if (Array.isArray(json.data)) return json.data;
  if (isObject(json.data) && Array.isArray(json.data.modelScores)) return json.data.modelScores;
  return [];
}

export function parseScores(json: unknown): ScoreRow[] {
  return extractRows(json).map(normalizeScoreRow).filter((row): row is ScoreRow => row !== null);
}

export function smooth(values: number[], window: number): number[] {
  return values.map((_, index) => {
    const slice = values.slice(Math.max(0, index - window + 1), index + 1);
    return Math.round(slice.reduce((sum, value) => sum + value, 0) / slice.length);
  });
}

function toHistoryPoint(value: unknown): HistoryPoint | null {
  if (!isObject(value) || typeof value.score !== 'number') return null;
  return {
    t: parseTimestamp(value.timestamp),
    score: Math.round(value.score),
    suite: typeof value.suite === 'string' ? value.suite : '',
  };
}

function extractSeries(entries: unknown): number[] {
  if (!Array.isArray(entries)) return [];
  const points = entries.map(toHistoryPoint).filter((point): point is HistoryPoint => point !== null);
  const hourly = points.filter((point) => point.suite === 'hourly');
  const chosen = hourly.length >= 2 ? hourly : points;
  return [...chosen].sort((a, b) => a.t - b.t).slice(-RAW_WINDOW).map((point) => point.score);
}

export function parseHistoryMap(json: unknown): Record<string, number[]> {
  const data = isObject(json) ? json.data : null;
  const map = isObject(data) && isObject(data.historyMap) ? data.historyMap : {};
  const result: Record<string, number[]> = {};
  for (const [id, entries] of Object.entries(map)) {
    const series = extractSeries(entries);
    if (series.length > 0) result[id] = series;
  }
  return result;
}

export function providerMeanHistory(histories: number[][], maxPoints: number): number[] {
  const nonEmpty = histories.filter((history) => history.length > 0);
  if (nonEmpty.length === 0) return [];
  const len = Math.min(maxPoints, ...nonEmpty.map((history) => history.length));
  const tails = nonEmpty.map((history) => history.slice(-len));
  const result: number[] = [];
  for (let index = 0; index < len; index += 1) {
    const sum = tails.reduce((acc, tail) => acc + tail[index], 0);
    result.push(Math.round(sum / tails.length));
  }
  return result;
}

function trendDelta(trend: Trend): number {
  if (trend === 'up') return 1;
  if (trend === 'down') return -1;
  return 0;
}

function aggregateTrend(rows: ScoreRow[]): Trend {
  const net = rows.reduce((sum, row) => sum + trendDelta(row.trend), 0);
  if (net > 0) return 'up';
  if (net < 0) return 'down';
  return 'stable';
}

function qualityToLevel(status: QualityStatus): ProviderHealthLevel {
  if (status === 'good') return 'ok';
  if (status === 'warning') return 'degraded';
  return 'down';
}

function modelHistory(historyById: Record<string, number[]>, id: string): number[] {
  return smooth(historyById[id] ?? [], SMOOTH_WINDOW).slice(-DISPLAY_POINTS);
}

export function aggregateQuality(
  rows: ScoreRow[],
  historyById: Record<string, number[]>,
  arena?: ArenaSnapshot,
): ProviderQuality {
  const active = rows.filter((row) => !row.isStale);
  const sample = active.length > 0 ? active : rows;
  if (sample.length === 0) {
    return { score: null, level: 'unknown', trend: null, models: [], measuredAt: null };
  }

  const score = Math.round(sample.reduce((sum, row) => sum + row.score, 0) / sample.length);
  const worst = sample.reduce<QualityStatus>(
    (acc, row) => (QUALITY_SEVERITY[row.status] > QUALITY_SEVERITY[acc] ? row.status : acc),
    'good',
  );
  const models: ProviderModelScore[] = [...sample]
    .sort((a, b) => b.score - a.score)
    .map((row) => ({
      id: row.id || undefined,
      name: row.name,
      score: row.score,
      status: row.status,
      trend: row.trend,
      history: modelHistory(historyById, row.id),
      measuredAt: row.measuredAt || undefined,
      arena: arena ? matchArenaEntry(arena, row) : undefined,
    }));
  const measuredAt = sample.reduce((max, row) => (row.measuredAt > max ? row.measuredAt : max), 0) || null;

  return {
    score,
    level: qualityToLevel(worst),
    trend: aggregateTrend(sample),
    models,
    measuredAt,
    arenaTotal: arena?.totalRanked,
    arenaUpdatedAt: arena?.fetchedAt,
  };
}

export function indicatorToLevel(indicator: unknown): ProviderHealthLevel {
  if (indicator === 'none') return 'ok';
  if (indicator === 'minor') return 'degraded';
  if (indicator === 'major' || indicator === 'critical') return 'down';
  return 'unknown';
}

export function parseOperational(json: unknown): ProviderOperational {
  if (!isObject(json) || !isObject(json.status)) {
    return { level: 'unknown', description: null };
  }
  const { indicator, description } = json.status;
  return {
    level: indicatorToLevel(indicator),
    description: typeof description === 'string' ? description : null,
  };
}

export function mergeLevel(a: ProviderHealthLevel, b: ProviderHealthLevel): ProviderHealthLevel {
  const known = [a, b].filter((level): level is KnownLevel => level !== 'unknown');
  if (known.length === 0) return 'unknown';
  return known.reduce((worst, level) => (LEVEL_SEVERITY[level] > LEVEL_SEVERITY[worst] ? level : worst));
}

// ----- LMArena (via wulong.dev) -----

const ARENA_MIN_PREFIX_MATCH = 7;

const ARENA_VENDOR_TO_PROVIDER: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  'google deepmind': 'google',
  deepmind: 'google',
  deepseek: 'deepseek',
  moonshot: 'kimi',
  'moonshot ai': 'kimi',
  kimi: 'kimi',
  'z.ai': 'glm',
  zhipu: 'glm',
  glm: 'glm',
};

interface ArenaEntry {
  rank: number;
  modelName: string;
  vendor: string;
  provider: string;
  score: number;
  ci: number;
  votes: number;
}

export interface ArenaSnapshot {
  entries: ArenaEntry[];
  byProvider: Map<string, ArenaEntry[]>;
  totalRanked: number;
  fetchedAt: number;
}

function arenaProviderFromVendor(vendor: string): string {
  return ARENA_VENDOR_TO_PROVIDER[vendor.toLowerCase()] ?? vendor.toLowerCase();
}

function normalizeArenaEntry(value: unknown): ArenaEntry | null {
  if (!isObject(value)) return null;
  const rank = typeof value.rank === 'number' ? value.rank : null;
  const modelName = typeof value.model === 'string' ? value.model : null;
  const vendor = typeof value.vendor === 'string' ? value.vendor : null;
  const score = typeof value.score === 'number' ? value.score : null;
  if (rank === null || !modelName || !vendor || score === null) return null;
  return {
    rank,
    modelName,
    vendor,
    provider: arenaProviderFromVendor(vendor),
    score,
    ci: typeof value.ci === 'number' ? value.ci : 0,
    votes: typeof value.votes === 'number' ? value.votes : 0,
  };
}

export function parseArenaSnapshot(json: unknown, fetchedAt: number): ArenaSnapshot {
  const entries: ArenaEntry[] = [];
  if (isObject(json) && Array.isArray(json.models)) {
    for (const raw of json.models) {
      const entry = normalizeArenaEntry(raw);
      if (entry) entries.push(entry);
    }
  }
  const byProvider = new Map<string, ArenaEntry[]>();
  for (const entry of entries) {
    const list = byProvider.get(entry.provider) ?? [];
    list.push(entry);
    byProvider.set(entry.provider, list);
  }
  const totalEntry = isObject(json) && isObject(json.meta)
    ? json.meta.model_count
    : undefined;
  const totalRanked = typeof totalEntry === 'number' ? totalEntry : entries.length;
  return { entries, byProvider, totalRanked, fetchedAt };
}

function matchArenaEntry(snapshot: ArenaSnapshot, row: ScoreRow): ProviderArenaEntry | undefined {
  const candidates = snapshot.byProvider.get(row.provider);
  if (!candidates || candidates.length === 0) return undefined;

  const targetName = row.name.toLowerCase();
  const exact = candidates.find((entry) => entry.modelName.toLowerCase() === targetName);
  const matched = exact ?? findArenaPrefixMatch(candidates, targetName);
  if (!matched) return undefined;

  return {
    rank: matched.rank,
    elo: matched.score,
    ci: matched.ci,
    votes: matched.votes,
  };
}

function findArenaPrefixMatch(candidates: ArenaEntry[], targetName: string): ArenaEntry | null {
  if (targetName.length < ARENA_MIN_PREFIX_MATCH) return null;
  let best: ArenaEntry | null = null;
  let bestSharedLength = ARENA_MIN_PREFIX_MATCH - 1;
  for (const entry of candidates) {
    const candidate = entry.modelName.toLowerCase();
    if (candidate.length < ARENA_MIN_PREFIX_MATCH) continue;
    if (targetName.startsWith(candidate) || candidate.startsWith(targetName)) {
      const sharedLength = Math.min(targetName.length, candidate.length);
      if (sharedLength > bestSharedLength) {
        bestSharedLength = sharedLength;
        best = entry;
      }
    }
  }
  return best;
}
