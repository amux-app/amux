import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execFileAsync } from './execAsync.js';

const TRANSCRIPT_SETUP_TIMEOUT_MS = 5000;

export interface SetupPaneTranscriptOptions {
  filenamePrefix: string;
  paneId: string;
  transcriptDir: string;
}

/**
 * Start a raw tmux byte transcript before an interactive process launches.
 * The returned path is owned by the pane lifecycle and must be removed if
 * pane creation rolls back.
 */
export async function setupPaneTranscript(
  options: SetupPaneTranscriptOptions,
): Promise<string> {
  const { filenamePrefix, paneId, transcriptDir } = options;
  mkdirSync(transcriptDir, { recursive: true });

  const safePaneId = paneId.replace(/[^a-zA-Z0-9]+/g, '');
  const safePrefix = filenamePrefix.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
  const transcriptPath = join(
    transcriptDir,
    `tmux${safePaneId ? `-${safePaneId}` : ''}-${safePrefix}-${Date.now()}.ansi`,
  );
  writeFileSync(transcriptPath, '');

  try {
    await execFileAsync(
      'tmux',
      ['pipe-pane', '-t', paneId, `cat >> ${shellQuote(transcriptPath)}`],
      { timeout: TRANSCRIPT_SETUP_TIMEOUT_MS },
    );
  } catch (error) {
    removePaneTranscript(transcriptPath);
    throw error;
  }

  return transcriptPath;
}

export function removePaneTranscript(transcriptPath: string | undefined): void {
  if (transcriptPath && existsSync(transcriptPath)) {
    unlinkSync(transcriptPath);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
