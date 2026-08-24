import { readdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';

const JOURNAL_DIR = join(homedir(), '.aumx', 'activity-journals');

/** A journal is deliberately per-incarnation, never per mutable pane id. */
export function getPaneActivityJournalPath(paneIncarnationId: string): string {
  const safeId = paneIncarnationId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return join(JOURNAL_DIR, `${safeId}.ndjson`);
}

/** Reaps a dead incarnation's journal and its rotated siblings. */
export function removePaneActivityJournal(path: string): void {
  const name = basename(path);
  try {
    for (const entry of readdirSync(JOURNAL_DIR)) {
      if (entry === name || entry.startsWith(`${name}.`)) unlinkSync(join(JOURNAL_DIR, entry));
    }
  } catch {
    // The journal directory may not exist yet, or the files are already gone.
  }
}
