import type { TmuxService } from '../services/TmuxService.js';
import type { AgentName } from '../agents/agent-contract.js';
import { isAgentCommand, isShellCommand } from './agentCommandDetection.js';
import { buildProcessTreeIndex, indexContainsCommand, listProcessTable, processTreeContainsCommand, type ProcessTreeEntry, type ProcessTreeIndex } from './processTree.js';

export interface PaneAgentProbe {
  paneId: string;
  pid: number;
  currentCommand: string;
  agent: AgentName;
}

export interface RunningAgentPaneResult {
  /** Panes where a direct command or process-tree query found the configured agent. */
  running: Set<string>;
  /** Panes where deeper process inspection failed, so stopped cannot be asserted. */
  indeterminate: Set<string>;
}

/**
 * Resolve which panes have their agent running, from pre-fetched batch data,
 * loading the process table at most once (only when a pane needs the deeper
 * process-tree check). Mirrors isAgentRunningInTmuxPane's logic per pane but
 * shares the single expensive `ps` call across all of them.
 */
export async function getRunningAgentPanes(probes: readonly PaneAgentProbe[]): Promise<RunningAgentPaneResult> {
  const running = new Set<string>();
  const indeterminate = new Set<string>();
  const needsProcessTree: PaneAgentProbe[] = [];

  for (const probe of probes) {
    if (probe.currentCommand && isAgentCommand(probe.agent, probe.currentCommand)) {
      running.add(probe.paneId);
    } else if (Number.isFinite(probe.pid) && probe.pid > 0) {
      needsProcessTree.push(probe);
    }
  }

  if (needsProcessTree.length === 0) return { running, indeterminate };

  let index: ProcessTreeIndex;
  try {
    index = buildProcessTreeIndex(await listProcessTable());
  } catch {
    for (const probe of needsProcessTree) indeterminate.add(probe.paneId);
    return { running, indeterminate };
  }

  for (const probe of needsProcessTree) {
    const found = indexContainsCommand(
      index,
      probe.pid,
      (entry) => isAgentProcessEntry(probe.agent, entry),
    );
    if (found) running.add(probe.paneId);
  }

  return { running, indeterminate };
}

export async function isAgentRunningInTmuxPane(
  tmuxService: TmuxService,
  paneId: string,
  agent: AgentName,
): Promise<boolean> {
  const currentCommand = await readPaneCurrentCommand(tmuxService, paneId);
  if (currentCommand && isAgentCommand(agent, currentCommand)) return true;

  const panePid = await readPanePid(tmuxService, paneId);
  if (!panePid) return false;

  try {
    const processes = await listProcessTable();
    return processTreeContainsCommand(
      processes,
      panePid,
      (entry) => isAgentProcessEntry(agent, entry),
    );
  } catch {
    return false;
  }
}

function isAgentProcessEntry(
  agent: AgentName,
  entry: ProcessTreeEntry,
): boolean {
  if (isAgentCommand(agent, entry.command)) return true;
  if (isShellCommand(entry.command)) return false;
  return isAgentCommand(agent, entry.args);
}

async function readPaneCurrentCommand(tmuxService: TmuxService, paneId: string): Promise<string | null> {
  try {
    const command = await tmuxService.getPaneCurrentCommand(paneId);
    return command.trim() || null;
  } catch {
    return null;
  }
}

async function readPanePid(tmuxService: TmuxService, paneId: string): Promise<number | null> {
  try {
    return await tmuxService.getPanePid(paneId);
  } catch {
    return null;
  }
}
