// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { getRunningAgentPanes } from '../../src/utils/paneAgentProcess.js';

// No mocks anywhere in this file: it spawns a real OS process and drives the
// real `ps`-backed process table, proving the underlying liveness primitive
// is genuinely correct rather than only correct against a mocked table (as
// every other liveness/process-tree test in this repo is). This is the
// minimum-bar real-process coverage; a full tmux-pane-kill e2e that exercises
// AgentLivenessProbe end-to-end through a live tmux pane is a separate,
// larger follow-up.
const AGENT_MARKER = 'aumx-real-process-codex-marker';

let child: ChildProcess | undefined;

afterEach(() => {
  if (child?.pid && !child.killed) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // Already reaped.
    }
  }
  child = undefined;
});

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('getRunningAgentPanes — real OS process detection (no mocks)', () => {
  it('finds a real spawned process via the live process table, then confirms it gone after kill', async () => {
    child = spawn('node', ['-e', 'setTimeout(() => {}, 60000)', AGENT_MARKER], { stdio: 'ignore' });
    const pid = child.pid;
    expect(pid).toBeGreaterThan(0);

    // currentCommand deliberately does not match any agent, forcing the real
    // ps-based process-tree fallback rather than the cheap command shortcut.
    const probe = { agent: 'codex' as const, currentCommand: 'node', paneId: 'real-pane', pid: pid! };

    const foundRunning = await waitUntil(async () => {
      const result = await getRunningAgentPanes([probe]);
      return result.running.has('real-pane');
    }, 5_000);
    expect(foundRunning).toBe(true);

    const killedPid = pid!;
    process.kill(killedPid, 'SIGKILL');
    child = undefined;

    const foundStopped = await waitUntil(async () => {
      const result = await getRunningAgentPanes([probe]);
      return !result.running.has('real-pane');
    }, 5_000);
    expect(foundStopped).toBe(true);
  }, 15_000);
});
