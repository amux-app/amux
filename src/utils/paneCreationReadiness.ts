import type { AgentName } from '../agents/agent-contract.js';
import { isAgentReadyForInput } from '../services/paneStatusHeuristics.js';
import { TmuxService } from '../services/TmuxService.js';
import { isShellCommand } from './agentCommandDetection.js';
import { isAgentRunningInTmuxPane } from './paneAgentProcess.js';

const INPUT_READY_POLL_INTERVAL_MS = 100;
const INPUT_READY_TIMEOUT_MS = 8000;

export { isAgentReadyForInput };

async function assertPaneStillExists(tmuxService: TmuxService, paneId: string): Promise<void> {
  if (await tmuxService.paneExists(paneId)) return;
  throw new Error(`Pane ${paneId} disappeared during agent startup`);
}

export async function waitForAgentInputReady(
  tmuxService: TmuxService,
  paneId: string,
  agent: AgentName,
  timeoutMs: number = INPUT_READY_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = await tmuxService.getPaneContent(paneId);
      if (isAgentReadyForInput(content, agent)) return true;
    } catch {
      // Capture can fail transiently while tmux installs the process. A pane
      // that was explicitly closed must instead cancel the entire creation.
      await assertPaneStillExists(tmuxService, paneId);
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(INPUT_READY_POLL_INTERVAL_MS, remainingMs),
      ));
    }
  }
  await assertPaneStillExists(tmuxService, paneId);
  return false;
}

export async function waitForPaneReady(
  tmuxService: TmuxService,
  paneId: string,
  timeoutMs: number = 600,
): Promise<void> {
  const start = Date.now();
  while ((Date.now() - start) < timeoutMs) {
    if (await tmuxService.paneExists(paneId)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

async function waitForPaneCommand(
  tmuxService: TmuxService,
  paneId: string,
  predicate: (command: string) => boolean,
  timeoutMs: number = 8000,
): Promise<boolean> {
  const start = Date.now();
  while ((Date.now() - start) < timeoutMs) {
    try {
      const current = await tmuxService.getPaneCurrentCommand(paneId);
      if (current && predicate(current)) {
        return true;
      }
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return false;
}

export async function waitForShellReady(
  tmuxService: TmuxService,
  paneId: string,
  timeoutMs: number = 12000,
): Promise<boolean> {
  return waitForPaneCommand(tmuxService, paneId, isShellCommand, timeoutMs);
}

export async function waitForAgentReady(
  tmuxService: TmuxService,
  paneId: string,
  agent: AgentName,
  timeoutMs: number = 12000,
): Promise<boolean> {
  const start = Date.now();
  while ((Date.now() - start) < timeoutMs) {
    if (await isAgentRunningInTmuxPane(tmuxService, paneId, agent)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return false;
}
