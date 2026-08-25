import { execFileAsync } from 'muxbase/core';
import { log } from './Logger.js';

const FOOTPRINT_BIN = '/usr/bin/footprint';
const FOOTPRINT_BASE_ARGS = ['--noCategories', '-f', 'bytes'];
const FOOTPRINT_TIMEOUT_MS = 3000;
const SAMPLE_TTL_MS = 10000;
const PHYS_FOOTPRINT_PATTERN = /^\s*phys_footprint:\s*([\d.]+)\s*(B|KB|MB|GB)\s*$/;
const UNIT_TO_KB: Record<string, number> = {
  B: 1 / 1024,
  GB: 1024 * 1024,
  KB: 1,
  MB: 1024,
};

interface ProcessMemoryEntry {
  pid: number;
  memory: { privateBytes?: number; workingSetSize: number };
}

export interface ProcessMemoryInput {
  mainPid: number;
  mainPrivateKB: number;
  processes: readonly ProcessMemoryEntry[];
}

/** Sums the per-process `phys_footprint` lines of `footprint --noCategories`. */
export function parseFootprintTotalKB(output: string): number | null {
  let totalKB = 0;
  let parsed = false;
  for (const line of output.split('\n')) {
    const match = PHYS_FOOTPRINT_PATTERN.exec(line);
    if (!match) continue;
    parsed = true;
    totalKB += Number(match[1]) * UNIT_TO_KB[match[2]];
  }
  return parsed ? Math.round(totalKB) : null;
}

/**
 * Working set size is RSS, which bills the shared Electron framework pages to
 * every process, so private memory is preferred wherever the platform has it.
 */
export function fallbackTotalKB(input: ProcessMemoryInput): number {
  let totalKB = input.mainPrivateKB;
  for (const entry of input.processes) {
    if (entry.pid === input.mainPid) continue;
    totalKB += entry.memory.privateBytes ?? entry.memory.workingSetSize;
  }
  return Math.round(totalKB);
}

function footprintArgs(input: ProcessMemoryInput): string[] {
  const pids = new Set<number>([input.mainPid]);
  for (const entry of input.processes) pids.add(entry.pid);
  return [...FOOTPRINT_BASE_ARGS, ...[...pids].flatMap((pid) => ['-p', String(pid)])];
}

export class AppMemorySampler {
  private totalKB: number | null = null;
  private nextRefreshAt = 0;
  private refreshing = false;
  private failureLogged = false;

  /**
   * Never blocks the caller: returns the cached footprint total (or the app
   * metrics fallback until the first sample lands) and refreshes in background.
   */
  sampleKB(input: ProcessMemoryInput): number {
    this.scheduleRefresh(input);
    return this.totalKB ?? fallbackTotalKB(input);
  }

  private scheduleRefresh(input: ProcessMemoryInput): void {
    if (process.platform !== 'darwin' || this.refreshing) return;
    if (Date.now() < this.nextRefreshAt) return;
    this.refreshing = true;
    void this.refresh(footprintArgs(input)).finally(() => {
      this.refreshing = false;
    });
  }

  private async refresh(args: string[]): Promise<void> {
    const output = await execFileAsync(FOOTPRINT_BIN, args, {
      silent: true,
      timeout: FOOTPRINT_TIMEOUT_MS,
    });
    this.totalKB = parseFootprintTotalKB(output);
    this.nextRefreshAt = Date.now() + SAMPLE_TTL_MS;
    if (this.totalKB === null) this.logUnavailableOnce();
  }

  private logUnavailableOnce(): void {
    if (this.failureLogged) return;
    this.failureLogged = true;
    log.debug('perf-monitor', 'footprint unavailable, falling back to app metrics memory');
  }
}
