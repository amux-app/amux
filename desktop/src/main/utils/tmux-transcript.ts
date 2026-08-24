import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../services/Logger.js';

const TRANSCRIPT_DIR_NAME = 'terminal';
const TRANSCRIPT_SETUP_TIMEOUT_MS = 3000;
// Terminal replay only reads the transcript tail (50 MB), so a larger file
// carries no recoverable scrollback. The same policy bounds both restart-time
// reuse and live transcript rollover.
export const TRANSCRIPT_REUSE_MAX_BYTES = 64 * 1024 * 1024;

export type TmuxTranscriptRunner = (args: string[]) => Promise<void>;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function defaultTmuxRunner(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: TRANSCRIPT_SETUP_TIMEOUT_MS }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/**
 * Single source of truth for where transcripts are written, so readers can
 * authorize a transcript path against the exact directory the writer uses.
 */
export function getTranscriptDir(): string | undefined {
  const logDir = log.getLogDir();
  return logDir ? join(logDir, TRANSCRIPT_DIR_NAME) : undefined;
}

export async function startTmuxTranscript(
  tmuxPaneId: string,
  transcriptPath: string,
  runner: TmuxTranscriptRunner = defaultTmuxRunner,
): Promise<void> {
  await runner([
    'pipe-pane',
    '-t',
    tmuxPaneId,
    `cat >> ${shellQuote(transcriptPath)}`,
  ]);
}

export async function switchTmuxTranscript(
  tmuxPaneId: string,
  replacementPath: string,
  transcriptPath: string,
  runner: TmuxTranscriptRunner = defaultTmuxRunner,
): Promise<void> {
  await runner([
    'pipe-pane',
    '-t',
    tmuxPaneId,
    `mv -f ${shellQuote(replacementPath)} ${shellQuote(transcriptPath)}; exec cat >> ${shellQuote(transcriptPath)}`,
  ]);
}

export async function setupTmuxTranscript(options: {
  logDir: string | null;
  tmuxPaneId: string;
  existingTranscriptPath?: string;
  filenamePrefix?: string;
  runner?: TmuxTranscriptRunner;
}): Promise<string | undefined> {
  const { existingTranscriptPath, filenamePrefix = 'resumed', logDir, runner, tmuxPaneId } = options;
  if (!logDir) return existingTranscriptPath;

  const transcriptDir = join(logDir, TRANSCRIPT_DIR_NAME);
  const transcriptPath = isReusableTranscript(existingTranscriptPath, tmuxPaneId)
    ? existingTranscriptPath
    : createTranscriptPath(transcriptDir, tmuxPaneId, filenamePrefix);

  await startTmuxTranscript(tmuxPaneId, transcriptPath, runner);
  return transcriptPath;
}

function isReusableTranscript(
  transcriptPath: string | undefined,
  tmuxPaneId: string,
): transcriptPath is string {
  if (!transcriptPath || !existsSync(transcriptPath)) return false;

  const size = statSync(transcriptPath).size;
  if (size <= TRANSCRIPT_REUSE_MAX_BYTES) return true;

  log.info('terminal', 'Transcript exceeded the reuse cap; starting a new one', {
    size,
    tmuxPaneId,
    transcriptPath,
  });
  return false;
}

function createTranscriptPath(transcriptDir: string, tmuxPaneId: string, filenamePrefix: string): string {
  mkdirSync(transcriptDir, { recursive: true });
  const safePaneId = tmuxPaneId.replace(/[^a-zA-Z0-9]+/g, '');
  const safePrefix = filenamePrefix.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
  const transcriptPath = join(transcriptDir, `tmux-${safePaneId}-${safePrefix}-${Date.now()}.ansi`);
  writeFileSync(transcriptPath, '');
  return transcriptPath;
}
