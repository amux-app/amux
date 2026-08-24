import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'path';

const TRANSCRIPT_FILE_PATTERN = /\.ansi$/;
const TRANSCRIPT_RETENTION_DAYS = 7;
export const TRANSCRIPT_RETENTION_MS = TRANSCRIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export async function reapOrphanTranscripts(
  terminalDir: string,
  livePaneTranscriptPaths: ReadonlySet<string>,
  now: number,
  retentionMs: number,
): Promise<number> {
  let deleted = 0;
  const cutoff = now - retentionMs;

  try {
    for (const fileName of await readdir(terminalDir)) {
      if (!TRANSCRIPT_FILE_PATTERN.test(fileName)) continue;

      const filePath = join(terminalDir, fileName);
      if (livePaneTranscriptPaths.has(filePath)) continue;

      try {
        if ((await stat(filePath)).mtimeMs >= cutoff) continue;
        await unlink(filePath);
        deleted += 1;
      } catch {
        // Transcript cleanup is best-effort.
      }
    }
  } catch {
    // Missing directory or listing failure is non-critical.
  }

  return deleted;
}
