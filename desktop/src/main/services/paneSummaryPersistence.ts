import { getProjectMetadataPath } from 'aumx/core';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PaneSummary } from '../../shared/pane-summary-types.js';
import { log } from './Logger.js';

/**
 * Pane IDs we generate look like `aumx-1781535332253` (slug + millis). We
 * accept that shape verbatim and reject anything containing path separators,
 * NUL, or relative-traversal markers. The renderer is the source of pane IDs
 * but they're forwarded over IPC, so a compromised/buggy caller could try to
 * hand us `../../etc/passwd`. Refuse before composing any filesystem path.
 */
const SAFE_PANE_ID_RE = /^[A-Za-z0-9_-]+$/;

function assertSafePaneId(paneId: string): void {
  if (typeof paneId !== 'string' || paneId.length === 0 || paneId.length > 128) {
    throw new Error(`Invalid pane id: ${JSON.stringify(paneId)}`);
  }
  if (!SAFE_PANE_ID_RE.test(paneId)) {
    throw new Error(`Unsafe pane id: ${paneId}`);
  }
}

export class PaneSummaryPersistence {
  private readonly dir: string;

  constructor(projectRoot: string) {
    this.dir = getProjectMetadataPath(projectRoot, 'pane-summaries');
  }

  /**
   * Compose a target file path for a pane id. Verifies the resolved path is
   * inside `this.dir` as a defense-in-depth check on top of the regex.
   */
  private fileFor(paneId: string): string {
    assertSafePaneId(paneId);
    const target = path.join(this.dir, `${paneId}.json`);
    const resolved = path.resolve(target);
    const root = path.resolve(this.dir) + path.sep;
    if (!resolved.startsWith(root)) {
      throw new Error(`Refusing to operate outside ${this.dir}: ${resolved}`);
    }
    return target;
  }

  async load(): Promise<PaneSummary[]> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const entries = await fs.readdir(this.dir);
      const out: PaneSummary[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(path.join(this.dir, entry), 'utf8');
          const parsed = JSON.parse(raw) as PaneSummary;
          if (parsed && typeof parsed.paneId === 'string') {
            out.push(parsed);
          }
        } catch (error) {
          log.warn('pane-summary-persistence', 'Skipping malformed file', { entry, error });
        }
      }
      return out;
    } catch (error) {
      log.warn('pane-summary-persistence', 'load failed', error);
      return [];
    }
  }

  async save(summary: PaneSummary): Promise<void> {
    const target = this.fileFor(summary.paneId);
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(summary, null, 2), 'utf8');
    await fs.rename(tmp, target);
  }

  async remove(paneId: string): Promise<void> {
    let target: string;
    try {
      target = this.fileFor(paneId);
    } catch (error) {
      log.warn('pane-summary-persistence', 'remove rejected unsafe pane id', { paneId, error });
      return;
    }
    try {
      await fs.unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('pane-summary-persistence', 'remove failed', { paneId, error });
      }
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.rm(this.dir, { recursive: true, force: true });
    } catch (error) {
      log.warn('pane-summary-persistence', 'clear failed', error);
    }
  }
}
