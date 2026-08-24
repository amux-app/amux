import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalPtyOsc52Follower } from '../../src/main/services/terminal-pty-osc52-follower';

const statCalls = vi.hoisted(() => ({ fstatSync: 0, statSync: 0 }));

const watchStub = vi.hoisted(() => {
  class StubWatcher {
    readonly errorListeners: Array<(error: Error) => void> = [];
    closed = false;

    on(event: string, listener: (error: Error) => void): this {
      if (event === 'error') this.errorListeners.push(listener);
      return this;
    }

    close(): void {
      this.closed = true;
    }
  }

  return {
    StubWatcher,
    installed: [] as Array<{ notify: (eventType: string) => void; watcher: StubWatcher }>,
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    default: original,
    fstatSync: (...args: Parameters<typeof original.fstatSync>) => {
      statCalls.fstatSync += 1;
      return original.fstatSync(...args);
    },
    statSync: (...args: Parameters<typeof original.statSync>) => {
      statCalls.statSync += 1;
      return original.statSync(...args);
    },
    watch: (_path: string, _options: unknown, listener: (eventType: string) => void) => {
      const watcher = new watchStub.StubWatcher();
      watchStub.installed.push({ notify: listener, watcher });
      return watcher;
    },
  };
});

const FALLBACK_POLL_MS = 250;
const IDLE_TICKS = 4;
const WATCHER_EVENTS = 5;
const OSC52_SEQUENCE = '\x1b]52;c;QU1VWC1PU0MtNTI=\x07';
const tempDirs: string[] = [];

function makeTranscript(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aumx-pty-osc52-syscalls-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'pane.ansi'), '');
  return join(dir, 'pane.ansi');
}

function resetStatCalls(): void {
  statCalls.fstatSync = 0;
  statCalls.statSync = 0;
}

function latestWatcher(): { notify: (eventType: string) => void; watcher: InstanceType<typeof watchStub.StubWatcher> } {
  const installed = watchStub.installed.at(-1);
  if (!installed) throw new Error('follower did not install a transcript watcher');
  return installed;
}

beforeEach(() => {
  vi.useFakeTimers();
  watchStub.installed.length = 0;
  resetStatCalls();
});

afterEach(() => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { force: true, recursive: true });
  }
});

describe('TerminalPtyOsc52Follower fallback watchdog', () => {
  it('reads the transcript on the fallback tick when the watcher never fires', () => {
    // Arrange: the stub watcher stands in for a platform watcher that missed the event.
    const transcriptPath = makeTranscript();
    const onSequence = vi.fn();
    const handle = new TerminalPtyOsc52Follower({ pollIntervalMs: FALLBACK_POLL_MS })
      .attach(transcriptPath, onSequence);
    appendFileSync(transcriptPath, OSC52_SEQUENCE);

    // Act
    expect(onSequence).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FALLBACK_POLL_MS);

    // Assert
    expect(onSequence).toHaveBeenCalledWith(OSC52_SEQUENCE);
    handle.dispose();
  });

  it('spends one fstat and one replacement stat per idle fallback tick', () => {
    // Arrange
    const transcriptPath = makeTranscript();
    const handle = new TerminalPtyOsc52Follower({ pollIntervalMs: FALLBACK_POLL_MS })
      .attach(transcriptPath, () => undefined);
    resetStatCalls();

    // Act: nothing is appended, so only the watchdog can run.
    vi.advanceTimersByTime(FALLBACK_POLL_MS * IDLE_TICKS);
    handle.dispose();

    // Assert: the pre-change reader stat'ed three times per tick at a quarter of this interval.
    expect(statCalls.fstatSync).toBe(IDLE_TICKS);
    expect(statCalls.statSync).toBe(IDLE_TICKS);
  });

  it('spends no replacement stat on watcher-driven reads', () => {
    // Arrange
    const transcriptPath = makeTranscript();
    const onSequence = vi.fn();
    const handle = new TerminalPtyOsc52Follower({ pollIntervalMs: FALLBACK_POLL_MS })
      .attach(transcriptPath, onSequence);
    resetStatCalls();

    // Act
    for (let index = 0; index < WATCHER_EVENTS; index += 1) {
      appendFileSync(transcriptPath, OSC52_SEQUENCE);
      latestWatcher().notify('change');
    }
    handle.dispose();

    // Assert: productive reads only stat the descriptor they already hold.
    expect(onSequence).toHaveBeenCalledTimes(WATCHER_EVENTS);
    expect(statCalls.fstatSync).toBe(WATCHER_EVENTS);
    expect(statCalls.statSync).toBe(0);
  });

  it('re-checks for a replaced transcript on a watcher rename event', () => {
    // Arrange
    const transcriptPath = makeTranscript();
    const handle = new TerminalPtyOsc52Follower({ pollIntervalMs: FALLBACK_POLL_MS })
      .attach(transcriptPath, () => undefined);
    resetStatCalls();

    // Act
    latestWatcher().notify('rename');
    handle.dispose();

    // Assert
    expect(statCalls.statSync).toBe(1);
  });
});
