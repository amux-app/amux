import type {
  AgentHealthAgent,
  AgentHealthMap,
  AgentHealthResponse,
} from '../../shared/ipc-types.js';
import { log } from './Logger.js';
import { parseMarginLabPage, trackerUrlFor } from './margin-lab-parse.js';

const CACHE_TTL_MS = 60 * 60 * 1000;
const FAILURE_RETRY_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

const AGENTS: AgentHealthAgent[] = ['claude', 'codex'];

export class AgentHealthService {
  private static instance: AgentHealthService;
  private cache: AgentHealthResponse | null = null;
  private cacheComplete = false;
  private inFlight: Promise<AgentHealthResponse> | null = null;
  private disabled = false;

  static getInstance(): AgentHealthService {
    if (!AgentHealthService.instance) {
      AgentHealthService.instance = new AgentHealthService();
    }
    return AgentHealthService.instance;
  }

  setDisabled(disabled: boolean): void {
    this.disabled = disabled;
  }

  async getHealth(): Promise<AgentHealthResponse> {
    if (this.disabled || process.env.MUXBASE_DISABLE_EXTERNAL_STATUS) {
      return { snapshots: {}, fetchedAt: Date.now() };
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

  private async fetchAll(): Promise<AgentHealthResponse> {
    const fetchedAt = Date.now();
    const snapshots: AgentHealthMap = { ...this.cache?.snapshots };

    const results = await Promise.all(
      AGENTS.map(async (agent) => ({
        agent,
        html: await fetchText(trackerUrlFor(agent)),
      })),
    );

    for (const { agent, html } of results) {
      if (!html) continue;
      const snapshot = parseMarginLabPage(html, agent, fetchedAt);
      if (snapshot) {
        snapshots[agent] = snapshot;
      } else {
        delete snapshots[agent];
        log.warn('agent-health', 'parse failed', { agent, url: trackerUrlFor(agent) });
      }
    }

    this.cacheComplete = AGENTS.every((agent) => snapshots[agent] !== undefined);
    this.cache = { snapshots, fetchedAt };
    log.info('agent-health', 'refreshed', {
      complete: this.cacheComplete,
      agents: AGENTS.map((agent) => `${agent}:${snapshots[agent] ? 'ok' : 'miss'}`).join(','),
    });
    return this.cache;
  }
}

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': BROWSER_USER_AGENT,
        accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!response.ok) {
      log.warn('agent-health', 'non-ok response', { url, status: response.status });
      return null;
    }
    return await response.text();
  } catch (error) {
    log.warn('agent-health', 'fetch failed', { url, error: String(error) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
