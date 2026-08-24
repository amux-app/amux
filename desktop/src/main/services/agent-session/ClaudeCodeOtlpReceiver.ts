import { createServer, type Server } from 'http';
import { log } from '../Logger.js';

interface SessionCostState {
  costUSD: number;
  lastUpdate: number;
  model?: string;
}

interface OtlpKeyValue {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string | number;
    doubleValue?: number;
    boolValue?: boolean;
  };
}

interface OtlpDataPoint {
  attributes?: OtlpKeyValue[];
  asDouble?: number;
  asInt?: string | number;
  timeUnixNano?: string;
}

interface OtlpMetric {
  name: string;
  sum?: { dataPoints?: OtlpDataPoint[] };
  gauge?: { dataPoints?: OtlpDataPoint[] };
  histogram?: { dataPoints?: OtlpDataPoint[] };
}

interface OtlpScopeMetrics { metrics?: OtlpMetric[] }
interface OtlpResourceMetrics { scopeMetrics?: OtlpScopeMetrics[] }
interface OtlpMetricsPayload { resourceMetrics?: OtlpResourceMetrics[] }

const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB cap per request — telemetry batches are small.
const SERVER_CLOSE_TIMEOUT_MS = 2_000;

export class ClaudeCodeOtlpReceiver {
  private server: Server | null = null;
  private port: number | null = null;
  private bySession = new Map<string, SessionCostState>();

  async start(): Promise<number> {
    if (this.server) return this.port!;
    return new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => this.handleRequest(req, res));
      server.on('error', (err) => {
        log.error('otlp-receiver', 'Server error', { error: String(err) });
        reject(err);
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        this.server = server;
        this.port = port;
        log.info('otlp-receiver', 'Listening', { port });
        resolve(port);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.port = null;
    this.bySession.clear();

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        server.closeAllConnections?.();
        log.warn('otlp-receiver', 'Server close timed out; forced active connections closed');
        resolve();
      }, SERVER_CLOSE_TIMEOUT_MS);
      timeout.unref();

      server.close((error) => {
        clearTimeout(timeout);
        if (error) {
          log.warn('otlp-receiver', 'Server close returned an error', { error: String(error) });
        }
        resolve();
      });
      server.closeIdleConnections?.();
    });
  }

  getPort(): number | null {
    return this.port;
  }

  getSessionCost(sessionId: string): { costUSD: number; model?: string } | null {
    const state = this.bySession.get(sessionId);
    if (!state) return null;
    return { costUSD: state.costUSD, model: state.model };
  }

  /** Test-only seam: inject a payload as if it came over HTTP. */
  ingestForTesting(payload: OtlpMetricsPayload): void {
    this.ingest(payload);
  }

  private handleRequest(req: import('http').IncomingMessage, res: import('http').ServerResponse): void {
    // Defensive: only accept localhost connections.
    const remote = req.socket.remoteAddress ?? '';
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      res.writeHead(403); res.end(); return;
    }

    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

    // /v1/logs and /v1/traces — accept and discard.
    if (req.url !== '/v1/metrics') {
      this.drainAndReply(req, res, 200, '{}');
      return;
    }

    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413); res.end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const payload = JSON.parse(text) as OtlpMetricsPayload;
        this.ingest(payload);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      } catch (err) {
        log.warn('otlp-receiver', 'Failed to parse payload', { error: String(err) });
        res.writeHead(400); res.end();
      }
    });
    req.on('error', () => { /* socket already closed */ });
  }

  private drainAndReply(
    req: import('http').IncomingMessage,
    res: import('http').ServerResponse,
    status: number,
    body: string,
  ): void {
    req.on('data', () => undefined);
    req.on('end', () => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    });
  }

  private ingest(payload: OtlpMetricsPayload): void {
    const resourceMetrics = payload.resourceMetrics ?? [];
    let matched = 0;
    for (const rm of resourceMetrics) {
      for (const sm of rm.scopeMetrics ?? []) {
        for (const metric of sm.metrics ?? []) {
          if (metric.name !== 'claude_code.cost.usage') continue;
          const dataPoints = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? [];
          for (const dp of dataPoints) {
            const attrs = attrsToMap(dp.attributes);
            const sessionId = attrs.get('session.id');
            if (!sessionId) continue;
            const cost = typeof dp.asDouble === 'number'
              ? dp.asDouble
              : dp.asInt !== undefined ? Number(dp.asInt) : NaN;
            if (!Number.isFinite(cost)) continue;
            const model = attrs.get('model');
            const tNanos = dp.timeUnixNano ? Number(dp.timeUnixNano) : Date.now() * 1_000_000;
            const lastUpdate = Math.floor(tNanos / 1_000_000);

            const prev = this.bySession.get(sessionId);
            this.bySession.set(sessionId, {
              costUSD: (prev?.costUSD ?? 0) + cost,
              lastUpdate,
              model: model ?? prev?.model,
            });
            matched += 1;
          }
        }
      }
    }
    if (matched > 0) {
      log.debug('otlp-receiver', 'Ingested cost datapoints', {
        matched,
        sessionsKnown: this.bySession.size,
      });
    }
  }
}

function attrsToMap(attrs?: OtlpKeyValue[]): Map<string, string> {
  const m = new Map<string, string>();
  if (!attrs) return m;
  for (const a of attrs) {
    const v = a.value;
    if (typeof v.stringValue === 'string') m.set(a.key, v.stringValue);
    else if (v.intValue !== undefined) m.set(a.key, String(v.intValue));
    else if (typeof v.doubleValue === 'number') m.set(a.key, String(v.doubleValue));
    else if (typeof v.boolValue === 'boolean') m.set(a.key, String(v.boolValue));
  }
  return m;
}
