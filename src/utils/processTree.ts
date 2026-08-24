import { execFile } from 'child_process';

export interface ProcessTreeEntry {
  args: string;
  command: string;
  pid: number;
  ppid: number;
}

export function parseProcessTable(output: string): ProcessTreeEntry[] {
  return output
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*?))?\s*$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      args: match[4] ?? '',
      command: match[3],
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
    }))
    .filter((entry) => Number.isFinite(entry.pid) && Number.isFinite(entry.ppid) && entry.command.trim().length > 0);
}

export interface ProcessTreeIndex {
  byPid: Map<number, ProcessTreeEntry>;
  byParent: Map<number, ProcessTreeEntry[]>;
}

export function buildProcessTreeIndex(entries: readonly ProcessTreeEntry[]): ProcessTreeIndex {
  const byPid = new Map<number, ProcessTreeEntry>();
  const byParent = new Map<number, ProcessTreeEntry[]>();
  for (const entry of entries) {
    byPid.set(entry.pid, entry);
    const siblings = byParent.get(entry.ppid) ?? [];
    siblings.push(entry);
    byParent.set(entry.ppid, siblings);
  }
  return { byPid, byParent };
}

export function indexContainsCommand(
  index: ProcessTreeIndex,
  rootPid: number,
  predicate: (entry: ProcessTreeEntry) => boolean,
): boolean {
  const pending = [rootPid];
  const seen = new Set<number>();

  while (pending.length > 0) {
    const pid = pending.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);

    const entry = index.byPid.get(pid);
    if (entry && predicate(entry)) return true;

    for (const child of index.byParent.get(pid) ?? []) {
      pending.push(child.pid);
    }
  }

  return false;
}

export function processTreeContainsCommand(
  entries: readonly ProcessTreeEntry[],
  rootPid: number,
  predicate: (entry: ProcessTreeEntry) => boolean,
): boolean {
  return indexContainsCommand(buildProcessTreeIndex(entries), rootPid, predicate);
}

export async function listProcessTable(): Promise<ProcessTreeEntry[]> {
  const output = await execFileText('ps', ['-axo', 'pid=,ppid=,comm=,args=']);
  return parseProcessTable(output);
}

// A full `ps -axo` on a busy machine (thousands of processes with args) can
// exceed Node's 1MB default and error, which would make every agent look
// "not running". Give it generous headroom.
const PROCESS_TABLE_MAX_BUFFER = 64 * 1024 * 1024;

function execFileText(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { encoding: 'utf8', maxBuffer: PROCESS_TABLE_MAX_BUFFER }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}
