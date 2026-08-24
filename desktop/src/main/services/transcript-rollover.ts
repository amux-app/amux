import { randomUUID } from 'node:crypto';
import { existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  defaultTmuxRunner,
  switchTmuxTranscript,
  TRANSCRIPT_REUSE_MAX_BYTES,
  type TmuxTranscriptRunner,
} from '../utils/tmux-transcript.js';
import { log } from './Logger.js';

export interface TranscriptRolloverPane {
  id: string;
  paneId: string;
  terminalTranscriptPath?: string;
}

export interface TranscriptRolloverOptions {
  isPaneAlive: (tmuxPaneId: string) => Promise<boolean>;
  maxBytes?: number;
  runner?: TmuxTranscriptRunner;
}

export function transcriptNeedsRollover(
  transcriptPath: string,
  maxBytes: number = TRANSCRIPT_REUSE_MAX_BYTES,
): boolean {
  try {
    return statSync(transcriptPath).size > maxBytes;
  } catch {
    return false;
  }
}

export async function rolloverPaneTranscript(
  tmuxPaneId: string,
  transcriptPath: string,
  runner: TmuxTranscriptRunner = defaultTmuxRunner,
): Promise<void> {
  const replacementPath = `${transcriptPath}.rollover-${process.pid}-${randomUUID()}.ansi`;
  writeFileSync(replacementPath, '', { flag: 'wx' });

  try {
    await switchTmuxTranscript(tmuxPaneId, replacementPath, transcriptPath, runner);
  } catch (error) {
    await stopPipingBestEffort(tmuxPaneId, runner);
    removeReplacementBestEffort(replacementPath);
    throw error;
  }
}

export async function sweepTranscriptRollovers(
  panes: readonly TranscriptRolloverPane[],
  options: TranscriptRolloverOptions,
): Promise<number> {
  const {
    isPaneAlive,
    maxBytes = TRANSCRIPT_REUSE_MAX_BYTES,
    runner = defaultTmuxRunner,
  } = options;
  let rolled = 0;

  for (const pane of panes) {
    const transcriptPath = pane.terminalTranscriptPath;
    if (!transcriptPath || !transcriptNeedsRollover(transcriptPath, maxBytes)) continue;

    try {
      if (!(await isPaneAlive(pane.paneId))) continue;
      await rolloverPaneTranscript(pane.paneId, transcriptPath, runner);
      rolled += 1;
      log.info('terminal', 'Rolled over oversized live transcript', {
        paneId: pane.id,
        tmuxPaneId: pane.paneId,
        transcriptPath,
      });
    } catch (error) {
      log.warn('terminal', 'Live transcript rollover failed', {
        error,
        paneId: pane.id,
        tmuxPaneId: pane.paneId,
        transcriptPath,
      });
    }
  }

  return rolled;
}

async function stopPipingBestEffort(
  tmuxPaneId: string,
  runner: TmuxTranscriptRunner,
): Promise<void> {
  try {
    await runner(['pipe-pane', '-t', tmuxPaneId]);
  } catch (error) {
    log.warn('terminal', 'Failed to stop transcript piping after rollover failure', {
      error,
      tmuxPaneId,
    });
  }
}

function removeReplacementBestEffort(replacementPath: string): void {
  if (!existsSync(replacementPath)) return;
  try {
    unlinkSync(replacementPath);
  } catch (error) {
    log.warn('terminal', 'Failed to remove abandoned transcript replacement', {
      error,
      replacementPath,
    });
  }
}
