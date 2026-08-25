import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractPtyOsc52Sequences,
  TerminalPtyOsc52Follower,
} from '../../src/main/services/terminal-pty-osc52-follower';

const tempDirs: string[] = [];
const OSC52_SEQUENCE = '\x1b]52;c;QU1VWC1PU0MtNTI=\x07';
const OSC52_ST_SEQUENCE = '\x1b]52;c;U1QtVEVSTUlOQVRPUg==\x1b\\';

function makeTranscript(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muxbase-pty-osc52-'));
  tempDirs.push(dir);
  return join(dir, 'pane.ansi');
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { force: true, recursive: true });
  }
});

describe('TerminalPtyOsc52Follower', () => {
  it('tails from EOF and emits only complete OSC 52 sequences across chunk boundaries', async () => {
    const transcriptPath = makeTranscript();
    writeFileSync(transcriptPath, `stale-visible${OSC52_SEQUENCE}`);
    const onSequence = vi.fn();
    const follower = new TerminalPtyOsc52Follower({ pollIntervalMs: 20 });
    const handle = follower.attach(transcriptPath, onSequence);

    appendFileSync(transcriptPath, `fresh-visible${OSC52_SEQUENCE.slice(0, 10)}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(onSequence).not.toHaveBeenCalled();
    appendFileSync(transcriptPath, `${OSC52_SEQUENCE.slice(10)}more-visible`);
    await waitFor(() => onSequence.mock.calls.length === 1);

    expect(onSequence).toHaveBeenCalledWith(OSC52_SEQUENCE);
    handle.dispose();
  });

  it('delivers from the transcript watcher without waiting for the fallback poll', async () => {
    // Arrange: a fallback interval far longer than the assertion deadline, so
    // only the fs.watch-driven path can satisfy it.
    const transcriptPath = makeTranscript();
    writeFileSync(transcriptPath, '');
    const onSequence = vi.fn();
    const handle = new TerminalPtyOsc52Follower({ pollIntervalMs: 5_000 }).attach(
      transcriptPath,
      onSequence,
    );
    // The platform watcher only starts capturing after the loop turns.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Act
    appendFileSync(transcriptPath, OSC52_SEQUENCE);

    // Assert
    await waitFor(() => onSequence.mock.calls.length === 1);
    expect(onSequence).toHaveBeenCalledWith(OSC52_SEQUENCE);
    handle.dispose();
  });

  it('drops oversized incomplete sequences, recovers, and stops after disposal', async () => {
    const transcriptPath = makeTranscript();
    writeFileSync(transcriptPath, '');
    const onSequence = vi.fn();
    const follower = new TerminalPtyOsc52Follower({
      maxSequenceChars: 64,
      pollIntervalMs: 20,
    });
    const handle = follower.attach(transcriptPath, onSequence);

    appendFileSync(transcriptPath, `\x1b]52;c;${'A'.repeat(80)}${OSC52_SEQUENCE}`);
    await waitFor(() => onSequence.mock.calls.length === 1);
    expect(onSequence).toHaveBeenCalledWith(OSC52_SEQUENCE);

    handle.dispose();
    appendFileSync(transcriptPath, OSC52_SEQUENCE);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(onSequence).toHaveBeenCalledTimes(1);
  });

  it('preserves a split ST terminator across transcript reads', async () => {
    const transcriptPath = makeTranscript();
    writeFileSync(transcriptPath, '');
    const onSequence = vi.fn();
    const handle = new TerminalPtyOsc52Follower({ pollIntervalMs: 20 }).attach(
      transcriptPath,
      onSequence,
    );

    appendFileSync(transcriptPath, OSC52_ST_SEQUENCE.slice(0, -1));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(onSequence).not.toHaveBeenCalled();
    appendFileSync(transcriptPath, OSC52_ST_SEQUENCE.slice(-1));
    await waitFor(() => onSequence.mock.calls.length === 1);

    expect(onSequence).toHaveBeenCalledWith(OSC52_ST_SEQUENCE);
    handle.dispose();
  });

  it('reopens a transcript that is atomically replaced and follows the new inode', async () => {
    const transcriptPath = makeTranscript();
    writeFileSync(transcriptPath, 'old-inode');
    const onSequence = vi.fn();
    const handle = new TerminalPtyOsc52Follower({ pollIntervalMs: 20 }).attach(
      transcriptPath,
      onSequence,
    );

    renameSync(transcriptPath, `${transcriptPath}.old`);
    writeFileSync(transcriptPath, `new-inode${OSC52_SEQUENCE}`);
    await waitFor(() => onSequence.mock.calls.length === 1);

    expect(onSequence).toHaveBeenCalledWith(OSC52_SEQUENCE);
    handle.dispose();
  });

  it('drains the old inode and preserves an OSC 52 sequence split across replacement', async () => {
    const transcriptPath = makeTranscript();
    writeFileSync(transcriptPath, 'old-inode');
    const onSequence = vi.fn();
    const handle = new TerminalPtyOsc52Follower({ pollIntervalMs: 20 }).attach(
      transcriptPath,
      onSequence,
    );
    const splitAt = Math.floor(OSC52_SEQUENCE.length / 2);

    appendFileSync(transcriptPath, OSC52_SEQUENCE.slice(0, splitAt));
    renameSync(transcriptPath, `${transcriptPath}.old`);
    writeFileSync(transcriptPath, OSC52_SEQUENCE.slice(splitAt));

    await waitFor(() => onSequence.mock.calls.length === 1);
    expect(onSequence).toHaveBeenCalledWith(OSC52_SEQUENCE);
    handle.dispose();
  });

  it('follows a transcript that is truncated in place', async () => {
    const transcriptPath = makeTranscript();
    writeFileSync(transcriptPath, 'old-content');
    const onSequence = vi.fn();
    const handle = new TerminalPtyOsc52Follower({ pollIntervalMs: 20 }).attach(
      transcriptPath,
      onSequence,
    );

    truncateSync(transcriptPath, 0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    appendFileSync(transcriptPath, OSC52_SEQUENCE);
    await waitFor(() => onSequence.mock.calls.length === 1);

    expect(onSequence).toHaveBeenCalledWith(OSC52_SEQUENCE);
    handle.dispose();
  });

  it('recovers the final valid request from many nested prefixes in one monotonic scan', () => {
    const repeatedPrefixes = '\x1b]52;'.repeat(30_000);

    const result = extractPtyOsc52Sequences(
      '',
      `${repeatedPrefixes}${OSC52_SEQUENCE}`,
      1_024,
    );

    expect(result).toEqual({ pending: '', sequences: [OSC52_SEQUENCE] });
  });

  it('uses a finite hard cap even when a non-finite maximum is requested', () => {
    const oversized = `\x1b]52;c;${'A'.repeat(150_000)}`;

    const result = extractPtyOsc52Sequences(
      '',
      `${oversized}${OSC52_SEQUENCE}`,
      Number.POSITIVE_INFINITY,
    );

    expect(result).toEqual({ pending: '', sequences: [OSC52_SEQUENCE] });
  });
});
