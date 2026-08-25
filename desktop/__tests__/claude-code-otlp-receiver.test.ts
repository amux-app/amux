import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { ClaudeCodeOtlpReceiver } from '../src/main/services/agent-session/ClaudeCodeOtlpReceiver';

function payload(opts: { sessionId: string; cost: number; model?: string; tNanos?: string }) {
  return {
    resourceMetrics: [{
      scopeMetrics: [{
        metrics: [{
          name: 'claude_code.cost.usage',
          sum: {
            dataPoints: [{
              attributes: [
                { key: 'session.id', value: { stringValue: opts.sessionId } },
                ...(opts.model ? [{ key: 'model', value: { stringValue: opts.model } }] : []),
              ],
              asDouble: opts.cost,
              timeUnixNano: opts.tNanos ?? `${Date.now() * 1_000_000}`,
            }],
          },
        }],
      }],
    }],
  };
}

describe('ClaudeCodeOtlpReceiver', () => {
  let receiver: ClaudeCodeOtlpReceiver;

  beforeEach(() => {
    receiver = new ClaudeCodeOtlpReceiver();
  });

  afterEach(async () => {
    await receiver.stop();
  });

  it('returns null for unknown session', () => {
    expect(receiver.getSessionCost('does-not-exist')).toBeNull();
  });

  it('sums cost across multiple datapoints for the same session', () => {
    receiver.ingestForTesting(payload({ sessionId: 'S1', cost: 0.001 }));
    receiver.ingestForTesting(payload({ sessionId: 'S1', cost: 0.002 }));
    receiver.ingestForTesting(payload({ sessionId: 'S1', cost: 0.003 }));
    const result = receiver.getSessionCost('S1');
    expect(result).not.toBeNull();
    expect(result!.costUSD).toBeCloseTo(0.006, 9);
  });

  it('keeps sessions isolated', () => {
    receiver.ingestForTesting(payload({ sessionId: 'A', cost: 0.5 }));
    receiver.ingestForTesting(payload({ sessionId: 'B', cost: 0.7 }));
    expect(receiver.getSessionCost('A')!.costUSD).toBeCloseTo(0.5, 9);
    expect(receiver.getSessionCost('B')!.costUSD).toBeCloseTo(0.7, 9);
  });

  it('captures the model attribute when present', () => {
    receiver.ingestForTesting(payload({ sessionId: 'S1', cost: 0.01, model: 'claude-opus-4-8' }));
    expect(receiver.getSessionCost('S1')!.model).toBe('claude-opus-4-8');
  });

  it('ignores datapoints without session.id', () => {
    receiver.ingestForTesting({
      resourceMetrics: [{
        scopeMetrics: [{
          metrics: [{
            name: 'claude_code.cost.usage',
            sum: { dataPoints: [{ attributes: [], asDouble: 0.1 }] },
          }],
        }],
      }],
    });
    // Nothing observable changes — verified by absence of a phantom session.
    expect([...['no-id', 'other'].map((id) => receiver.getSessionCost(id))]).toEqual([null, null]);
  });

  it('ignores non-cost metrics (e.g. token counters)', () => {
    receiver.ingestForTesting({
      resourceMetrics: [{
        scopeMetrics: [{
          metrics: [{
            name: 'claude_code.token.usage',
            sum: {
              dataPoints: [{
                attributes: [{ key: 'session.id', value: { stringValue: 'S1' } }],
                asInt: '1000',
              }],
            },
          }],
        }],
      }],
    });
    expect(receiver.getSessionCost('S1')).toBeNull();
  });

  it('starts an HTTP server on 127.0.0.1 and accepts OTLP-JSON over the wire', async () => {
    const port = await receiver.start();
    expect(port).toBeGreaterThan(0);

    const body = JSON.stringify(payload({ sessionId: 'wire-test', cost: 0.0042 }));
    const res = await fetch(`http://127.0.0.1:${port}/v1/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
    expect(receiver.getSessionCost('wire-test')!.costUSD).toBeCloseTo(0.0042, 9);
  });

  it('returns 200 for /v1/logs and /v1/traces (accept-and-discard)', async () => {
    const port = await receiver.start();
    for (const path of ['/v1/logs', '/v1/traces']) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(200);
    }
  });

  it('rejects non-POST methods with 405', async () => {
    const port = await receiver.start();
    const res = await fetch(`http://127.0.0.1:${port}/v1/metrics`);
    expect(res.status).toBe(405);
  });

  it('stop() is idempotent — safe to call when never started or already stopped', async () => {
    // Never started: should not throw.
    await expect(receiver.stop()).resolves.toBeUndefined();
    // Stop again after the no-op: still safe.
    await expect(receiver.stop()).resolves.toBeUndefined();
  });

  it('start → stop → start cycle releases the port (no leak across project switches)', async () => {
    const firstPort = await receiver.start();
    expect(firstPort).toBeGreaterThan(0);
    await receiver.stop();
    expect(receiver.getPort()).toBeNull();

    // A fresh receiver instance simulates MuxBaseBridge.bootServices replacing it
    // on project switch. The previous server is gone, so the new one binds cleanly.
    const second = new ClaudeCodeOtlpReceiver();
    try {
      const secondPort = await second.start();
      expect(secondPort).toBeGreaterThan(0);
    } finally {
      await second.stop();
    }
  });
});
