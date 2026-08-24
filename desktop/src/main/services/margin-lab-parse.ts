import type { AgentHealthAgent, AgentHealthSnapshot } from '../../shared/ipc-types.js';

const DAILY_CHART_PATTERN = /const\s+dailyChartData\s*=\s*(\[[\s\S]*?\])\s*[,;]/;

interface DailyChartEntry {
  date: string;
  passRate: number;
  ciLower: number;
  ciUpper: number;
  runsCount: number;
  displayRunsCount: number;
  passed: number;
}

const TRACKER_URLS: Record<AgentHealthAgent, string> = {
  claude: 'https://marginlab.ai/trackers/claude-code/',
  codex: 'https://marginlab.ai/trackers/codex/',
};

const TRACKED_MODELS: Record<AgentHealthAgent, string> = {
  claude: 'claude-opus-4-x',
  codex: 'gpt-5.5-xhigh',
};

export function trackerUrlFor(agent: AgentHealthAgent): string {
  return TRACKER_URLS[agent];
}

export function parseMarginLabPage(
  html: string,
  agent: AgentHealthAgent,
  fetchedAt: number,
): AgentHealthSnapshot | null {
  const dailyMatch = DAILY_CHART_PATTERN.exec(html);
  if (!dailyMatch) return null;
  const entries = parseChartArray(dailyMatch[1]);
  const last = entries[entries.length - 1];
  if (!last) return null;

  return {
    agent,
    trackedModel: TRACKED_MODELS[agent],
    passRate: round(last.passRate, 1),
    ciLower: round(last.ciLower, 1),
    ciUpper: round(last.ciUpper, 1),
    passed: last.passed,
    displayRunsCount: last.displayRunsCount,
    date: last.date,
    measuredAt: fetchedAt,
    trackerUrl: TRACKER_URLS[agent],
  };
}

function parseChartArray(raw: string): DailyChartEntry[] {
  const parsed: unknown = safeJsonParse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isDailyChartEntry);
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isDailyChartEntry(value: unknown): value is DailyChartEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.date === 'string'
    && typeof entry.passRate === 'number'
    && typeof entry.ciLower === 'number'
    && typeof entry.ciUpper === 'number'
    && typeof entry.passed === 'number'
    && typeof entry.displayRunsCount === 'number';
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
