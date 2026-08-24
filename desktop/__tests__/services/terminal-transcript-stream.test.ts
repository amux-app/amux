import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PaneStream } from '../../src/main/services/terminal-stream-state';
import { TerminalTranscriptStream } from '../../src/main/services/terminal-transcript-stream';

vi.mock('../../src/main/services/Logger.js', () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStream(transcriptPath: string): PaneStream {
  return {
    alternateCheckCount: 0,
    alternateCheckedAt: 0,
    alternateOn: false,
    attachedAt: Date.now(),
    capturing: false,
    cols: 80,
    consecutiveFailures: 0,
    controlLiveBuffer: '',
    controlUnsubscribe: null,
    fixedCols: 0,
    historySize: 0,
    initialized: false,
    lastContent: '',
    lastCursor: null,
    mode: 'transcript',
    paneId: 'pane-1',
    resizeRepaintTimer: null,
    rows: 24,
    screenReaderDetected: false,
    sessionName: 'aumx-test',
    skipScrollbackReplay: false,
    streamId: 1,
    stdinLocked: false,
    timer: null,
    tmuxPaneId: '%1',
    transcriptDecoder: null,
    transcriptDev: null,
    transcriptFd: null,
    transcriptFlushTimer: null,
    transcriptIno: null,
    transcriptOffset: 0,
    transcriptPath,
    transcriptPending: '',
    transcriptPendingSource: null,
    transcriptPollTimer: null,
    transcriptReplayInFlight: false,
    transcriptSuppressedUntil: 0,
    transcriptWatcher: null,
    windowId: '@1',
    writeCaptureTimer: null,
  };
}

function sentData(sendToRenderer: ReturnType<typeof vi.fn>): string {
  return sendToRenderer.mock.calls.map((call) => call[1] as string).join('');
}

async function waitForFlush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('TerminalTranscriptStream', () => {
  it('follows from the current transcript end without replaying stale transcript bytes', async () => {
    // Arrange
    const transcriptPath = join(createTempDir('aumx-transcript-'), 'pane.ansi');
    writeFileSync(transcriptPath, 'stale-width-frame');
    const stream = makeStream(transcriptPath);
    const sendToRenderer = vi.fn();
    const transcriptStream = new TerminalTranscriptStream({
      isCurrentStream: () => true,
      sendToRenderer,
    });

    try {
      // Act
      await transcriptStream.attach(stream, transcriptPath);
      await waitForFlush();

      // Assert
      expect(sentData(sendToRenderer)).not.toContain('stale-width-frame');

      // Act
      appendFileSync(transcriptPath, 'fresh-frame');
      transcriptStream.readNewData(stream);
      await waitForFlush();

      // Assert
      expect(sentData(sendToRenderer)).toContain('fresh-frame');
    } finally {
      transcriptStream.dispose(stream);
    }
  });

  it('drains the old inode and follows its replacement without replaying stale history', async () => {
    const directory = createTempDir('aumx-transcript-');
    const transcriptPath = join(directory, 'pane.ansi');
    const replacementPath = join(directory, 'replacement.ansi');
    writeFileSync(transcriptPath, 'stale-history');
    const stream = makeStream(transcriptPath);
    const sendToRenderer = vi.fn();
    const transcriptStream = new TerminalTranscriptStream({
      isCurrentStream: () => true,
      sendToRenderer,
    });

    try {
      await transcriptStream.attach(stream, transcriptPath);
      appendFileSync(transcriptPath, 'tail-before-rotation');
      writeFileSync(replacementPath, 'fresh-after-rotation');
      renameSync(replacementPath, transcriptPath);

      transcriptStream.readNewData(stream);
      await waitForFlush();

      const sent = sentData(sendToRenderer);
      expect(sent).toContain('tail-before-rotation');
      expect(sent).toContain('fresh-after-rotation');
      expect(sent).not.toContain('stale-history');
    } finally {
      transcriptStream.dispose(stream);
    }
  });

  it('replays existing transcript bytes before following from the end', async () => {
    // Arrange
    const transcriptPath = join(createTempDir('aumx-transcript-'), 'pane.ansi');
    writeFileSync(transcriptPath, 'historic-frame');
    const stream = makeStream(transcriptPath);
    const sendToRenderer = vi.fn();
    const transcriptStream = new TerminalTranscriptStream({
      isCurrentStream: () => true,
      sendToRenderer,
    });
    let replayFlag = false;
    let offsetWhenReplayFlagCleared = -1;
    Object.defineProperty(stream, 'transcriptReplayInFlight', {
      configurable: true,
      get: () => replayFlag,
      set: (next: boolean) => {
        if (replayFlag && !next) offsetWhenReplayFlagCleared = stream.transcriptOffset;
        replayFlag = next;
      },
    });

    try {
      // Act
      const replay = await transcriptStream.replayExistingData(stream, transcriptPath);
      expect(stream.transcriptOffset).toBe('historic-frame'.length);
      appendFileSync(transcriptPath, 'between-replay-and-follow');
      await transcriptStream.attach(stream, transcriptPath, replay.offset);
      appendFileSync(transcriptPath, 'fresh-frame');
      transcriptStream.readNewData(stream);
      await waitForFlush();

      // Assert
      expect(replay.replayed).toBe(true);
      expect(replay.offset).toBe('historic-frame'.length);
      expect(offsetWhenReplayFlagCleared).toBe('historic-frame'.length);
      expect(sendToRenderer).toHaveBeenCalledWith('pane-1', 'historic-frame', 'replay', 1);
      expect(sentData(sendToRenderer)).toContain('between-replay-and-follow');
      expect(sentData(sendToRenderer)).toContain('fresh-frame');
      expect(stream.transcriptOffset).toBe('historic-framebetween-replay-and-followfresh-frame'.length);
    } finally {
      transcriptStream.dispose(stream);
    }
  });

  it('reports empty transcript replay without sending renderer bytes', async () => {
    // Arrange
    const transcriptPath = join(createTempDir('aumx-transcript-'), 'pane.ansi');
    writeFileSync(transcriptPath, '');
    const stream = makeStream(transcriptPath);
    const sendToRenderer = vi.fn();
    const transcriptStream = new TerminalTranscriptStream({
      isCurrentStream: () => true,
      sendToRenderer,
    });

    try {
      // Act
      const replay = await transcriptStream.replayExistingData(stream, transcriptPath);

      // Assert
      expect(replay).toEqual({ offset: 0, replayed: false });
      expect(sendToRenderer).not.toHaveBeenCalled();
    } finally {
      transcriptStream.dispose(stream);
    }
  });

  it('bounds transcript replay to the configured byte tail', async () => {
    // Arrange
    const transcriptPath = join(createTempDir('aumx-transcript-'), 'pane.ansi');
    writeFileSync(transcriptPath, 'old-frame-fresh-frame');
    const stream = makeStream(transcriptPath);
    const sendToRenderer = vi.fn();
    const transcriptStream = new TerminalTranscriptStream({
      isCurrentStream: () => true,
      sendToRenderer,
    }, { replayMaxBytes: 'fresh-frame'.length });

    try {
      // Act
      const replay = await transcriptStream.replayExistingData(stream, transcriptPath);

      // Assert
      expect(replay).toEqual({ offset: 'old-frame-fresh-frame'.length, replayed: true });
      expect(sentData(sendToRenderer)).toBe('fresh-frame');
    } finally {
      transcriptStream.dispose(stream);
    }
  });

  it('deduplicates agent startup redraws inside a capped replay tail', async () => {
    // Arrange
    const transcriptPath = join(createTempDir('aumx-transcript-'), 'pane.ansi');
    const oldHistory = 'old-history-before-retained-tail\n';
    const firstStartup = '\x1b[H╭───Claude Code v2.1.177 first-size╮\nWelcome back\n';
    const stableStartup = '\x1b[H╭───Claude Code v2.1.177 stable-size╮\nTips for getting started\n';
    const retainedTail = `${firstStartup}${stableStartup}first user prompt\nassistant answer`;
    writeFileSync(transcriptPath, `${oldHistory}${retainedTail}`);
    const stream = makeStream(transcriptPath);
    stream.skipScrollbackReplay = true;
    const sendToRenderer = vi.fn();
    const transcriptStream = new TerminalTranscriptStream({
      isCurrentStream: () => true,
      sendToRenderer,
    }, { replayMaxBytes: Buffer.byteLength(retainedTail, 'utf8') });

    try {
      // Act
      const replay = await transcriptStream.replayExistingData(stream, transcriptPath);

      // Assert
      const data = sentData(sendToRenderer);
      expect(replay.replayed).toBe(true);
      expect(data).not.toContain('old-history-before-retained-tail');
      expect(data).not.toContain('first-size');
      expect(data).toContain('stable-size');
      expect(data).toContain('first user prompt');
      expect(data).toContain('assistant answer');
    } finally {
      transcriptStream.dispose(stream);
    }
  });

  it.each([
    {
      name: 'no startup banners',
      transcript: 'prelude without startup banners\nfirst user prompt\nassistant answer',
    },
    {
      name: 'one startup banner',
      transcript: 'prelude before one startup banner\n\x1b[H╭───Claude Code v2.1.177 single-size╮\nWelcome back\nfirst user prompt\nassistant answer',
    },
    {
      name: 'startup-like prose without a banner prefix',
      transcript: 'user text mentioning Claude Code v2.1.177 and Welcome back\nfirst user prompt\nassistant answer',
    },
    {
      name: 'startup-like prose with banner prefixes but no redraw boundary',
      transcript: [
        'user pasted ╭───Claude Code v2.1.177 example╮ with Welcome back text',
        'more prose before another ╭───Claude Code v2.1.177 example╮ with Tips for getting started',
        'first user prompt',
        'assistant answer',
      ].join('\n'),
    },
  ])('does not trim agent transcript replay with $name', async ({ transcript }) => {
    // Arrange
    const transcriptPath = join(createTempDir('aumx-transcript-'), 'pane.ansi');
    writeFileSync(transcriptPath, transcript);
    const stream = makeStream(transcriptPath);
    stream.skipScrollbackReplay = true;
    const sendToRenderer = vi.fn();
    const transcriptStream = new TerminalTranscriptStream({
      isCurrentStream: () => true,
      sendToRenderer,
    });

    try {
      // Act
      const replay = await transcriptStream.replayExistingData(stream, transcriptPath);

      // Assert
      expect(replay).toEqual({ offset: Buffer.byteLength(transcript, 'utf8'), replayed: true });
      expect(sentData(sendToRenderer)).toBe(transcript);
    } finally {
      transcriptStream.dispose(stream);
    }
  });

  it('collapses repeated Claude startup redraws during agent transcript replay', async () => {
    // Arrange
    const transcriptPath = join(createTempDir('aumx-transcript-'), 'pane.ansi');
    const firstStartup = '\x1b[H╭───Claude Code v2.1.177 first-size╮\nWelcome back\n';
    const stableStartup = '\x1b[H╭───Claude Code v2.1.177 stable-size╮\nTips for getting started\n';
    writeFileSync(transcriptPath, `${firstStartup}${stableStartup}first user prompt\nassistant answer`);
    const stream = makeStream(transcriptPath);
    stream.skipScrollbackReplay = true;
    const sendToRenderer = vi.fn();
    const transcriptStream = new TerminalTranscriptStream({
      isCurrentStream: () => true,
      sendToRenderer,
    });

    try {
      // Act
      const replay = await transcriptStream.replayExistingData(stream, transcriptPath);

      // Assert
      const data = sentData(sendToRenderer);
      expect(replay.replayed).toBe(true);
      expect(data).not.toContain('first-size');
      expect(data).toContain('stable-size');
      expect(data).toContain('first user prompt');
      expect(data).toContain('assistant answer');
    } finally {
      transcriptStream.dispose(stream);
    }
  });

  it('collapses repeated Claude prompt redraws during startup replay', async () => {
    // Arrange
    const transcriptPath = join(createTempDir('aumx-transcript-'), 'pane.ansi');
    const firstStartup = '\x1b[H╭───Claude Code v2.1.177 first-size╮\nWelcome back\n';
    const stableStartup = '\x1b[H╭───Claude Code v2.1.177 stable-size╮\nTips for getting started\n';
    const firstPrompt = '\r\x1b[48;5;237m\x1b[38;5;239m❯ \x1b[38;5;231mPlease list tools with parameters\x1b[39m\r\n';
    const secondPrompt = '\r\x1b[48;5;237m\x1b[38;5;239m❯ \x1b[38;5;231mPlease list tools with parameters\x1b[39m\r\n';
    writeFileSync(transcriptPath, `${firstStartup}${stableStartup}${firstPrompt}Thinking…${secondPrompt}assistant answer`);
    const stream = makeStream(transcriptPath);
    stream.skipScrollbackReplay = true;
    const sendToRenderer = vi.fn();
    const transcriptStream = new TerminalTranscriptStream({
      isCurrentStream: () => true,
      sendToRenderer,
    });

    try {
      // Act
      const replay = await transcriptStream.replayExistingData(stream, transcriptPath);

      // Assert
      const data = sentData(sendToRenderer);
      expect(replay.replayed).toBe(true);
      expect(data).not.toContain('first-size');
      expect(data.match(/Please list tools with parameters/g)).toHaveLength(1);
      expect(data).toContain('assistant answer');
    } finally {
      transcriptStream.dispose(stream);
    }
  });

  it('collapses repeated Claude prompt redraws when only one startup banner exists', async () => {
    // Arrange
    const transcriptPath = join(createTempDir('aumx-transcript-'), 'pane.ansi');
    const startup = '\x1b[H╭───Claude Code v2.1.177 stable-size╮\nTips for getting started\n';
    const firstPrompt = '\r\x1b[48;5;237m\x1b[38;5;239m❯ \x1b[38;5;231mPlease list tools with parameters\x1b[39m\r\n';
    const secondPrompt = '\r\x1b[48;5;237m\x1b[38;5;239m❯ \x1b[38;5;231mPlease list tools with parameters\x1b[39m\r\n';
    writeFileSync(transcriptPath, `${startup}${firstPrompt}Thinking…${secondPrompt}assistant answer`);
    const stream = makeStream(transcriptPath);
    stream.skipScrollbackReplay = true;
    const sendToRenderer = vi.fn();
    const transcriptStream = new TerminalTranscriptStream({
      isCurrentStream: () => true,
      sendToRenderer,
    });

    try {
      // Act
      const replay = await transcriptStream.replayExistingData(stream, transcriptPath);

      // Assert
      const data = sentData(sendToRenderer);
      expect(replay.replayed).toBe(true);
      expect(data.match(/Please list tools with parameters/g)).toHaveLength(1);
      expect(data).toContain('assistant answer');
    } finally {
      transcriptStream.dispose(stream);
    }
  });

  it('ignores stale transcript offsets from previous attaches', async () => {
    // Arrange
    const transcriptPath = join(createTempDir('aumx-transcript-'), 'pane.ansi');
    writeFileSync(transcriptPath, 'stale-frame');
    const stream = makeStream(transcriptPath);
    stream.transcriptOffset = 1;
    const sendToRenderer = vi.fn();
    const transcriptStream = new TerminalTranscriptStream({
      isCurrentStream: () => true,
      sendToRenderer,
    });

    try {
      // Act
      await transcriptStream.attach(stream, transcriptPath);
      await waitForFlush();

      // Assert
      expect(sentData(sendToRenderer)).not.toContain('stale-frame');

      // Act
      appendFileSync(transcriptPath, 'fresh-frame');
      transcriptStream.readNewData(stream);
      await waitForFlush();

      // Assert
      expect(sentData(sendToRenderer)).toContain('fresh-frame');
    } finally {
      transcriptStream.dispose(stream);
    }
  });

  it('drops queued resize bytes and follows new transcript bytes from the current end', async () => {
    // Arrange
    const transcriptPath = join(createTempDir('aumx-transcript-'), 'pane.ansi');
    writeFileSync(transcriptPath, 'initial-frame');
    const stream = makeStream(transcriptPath);
    const sendToRenderer = vi.fn();
    const transcriptStream = new TerminalTranscriptStream({
      isCurrentStream: () => true,
      sendToRenderer,
    });

    try {
      await transcriptStream.attach(stream, transcriptPath);
      transcriptStream.queue(stream, 'queued-resize-redraw', 'live');

      // Act
      appendFileSync(transcriptPath, 'late-resize-redraw');
      transcriptStream.discardBufferedDataAndSeekToEnd(stream);
      await waitForFlush();
      appendFileSync(transcriptPath, 'fresh-frame');
      transcriptStream.readNewData(stream);
      await waitForFlush();

      // Assert
      const data = sentData(sendToRenderer);
      expect(data).not.toContain('queued-resize-redraw');
      expect(data).not.toContain('late-resize-redraw');
      expect(data).toContain('fresh-frame');
    } finally {
      transcriptStream.dispose(stream);
    }
  });

  it('pauses transcript watchers and discards hidden output before following again', async () => {
    const transcriptPath = join(createTempDir('aumx-transcript-'), 'pane.ansi');
    writeFileSync(transcriptPath, 'initial-frame');
    const stream = makeStream(transcriptPath);
    const sendToRenderer = vi.fn();
    const transcriptStream = new TerminalTranscriptStream({
      isCurrentStream: () => true,
      sendToRenderer,
    });

    try {
      await transcriptStream.attach(stream, transcriptPath);
      transcriptStream.queue(stream, 'queued-before-hide', 'live');

      transcriptStream.pauseFollowing(stream);
      appendFileSync(transcriptPath, 'hidden-frame');
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(stream.transcriptWatcher).toBeNull();
      expect(stream.transcriptPollTimer).toBeNull();
      expect(stream.transcriptFlushTimer).toBeNull();
      expect(stream.transcriptPending).toBe('');
      expect(sentData(sendToRenderer)).not.toContain('queued-before-hide');
      expect(sentData(sendToRenderer)).not.toContain('hidden-frame');

      transcriptStream.resumeFollowing(stream);
      appendFileSync(transcriptPath, 'visible-frame');
      transcriptStream.readNewData(stream);
      await waitForFlush();

      expect(stream.transcriptWatcher).not.toBeNull();
      expect(stream.transcriptPollTimer).not.toBeNull();
      expect(sentData(sendToRenderer)).not.toContain('hidden-frame');
      expect(sentData(sendToRenderer)).toContain('visible-frame');
    } finally {
      transcriptStream.dispose(stream);
    }
  });

  it('resumes from the replacement end after a transcript rotates while hidden', async () => {
    const directory = createTempDir('aumx-transcript-');
    const transcriptPath = join(directory, 'pane.ansi');
    const replacementPath = join(directory, 'replacement.ansi');
    writeFileSync(transcriptPath, 'initial-frame');
    const stream = makeStream(transcriptPath);
    const sendToRenderer = vi.fn();
    const transcriptStream = new TerminalTranscriptStream({
      isCurrentStream: () => true,
      sendToRenderer,
    });

    try {
      await transcriptStream.attach(stream, transcriptPath);
      transcriptStream.pauseFollowing(stream);
      appendFileSync(transcriptPath, 'hidden-old-inode');
      writeFileSync(replacementPath, 'hidden-replacement');
      renameSync(replacementPath, transcriptPath);

      transcriptStream.resumeFollowing(stream);
      appendFileSync(transcriptPath, 'visible-frame');
      transcriptStream.readNewData(stream);
      await waitForFlush();

      const sent = sentData(sendToRenderer);
      expect(sent).not.toContain('hidden-old-inode');
      expect(sent).not.toContain('hidden-replacement');
      expect(sent).toContain('visible-frame');
    } finally {
      transcriptStream.dispose(stream);
    }
  });

  it('uses transcript changes as snapshot signals for agent panes instead of streaming raw TUI redraw bytes', async () => {
    // Arrange
    const transcriptPath = join(createTempDir('aumx-transcript-'), 'pane.ansi');
    writeFileSync(transcriptPath, 'initial-frame');
    const stream = makeStream(transcriptPath);
    stream.skipScrollbackReplay = true;
    const sendToRenderer = vi.fn();
    const onTranscriptActivity = vi.fn();
    const transcriptStream = new TerminalTranscriptStream({
      isCurrentStream: () => true,
      onTranscriptActivity,
      sendToRenderer,
    });

    try {
      await transcriptStream.attach(stream, transcriptPath);

      // Act
      appendFileSync(transcriptPath, '\x1b[H╭─── Claude Code v2.1.195 duplicate redraw\n❯ prompt');
      transcriptStream.readNewData(stream);
      await waitForFlush();

      // Assert
      expect(sendToRenderer).not.toHaveBeenCalledWith(
        'pane-1',
        expect.stringContaining('Claude Code'),
        'live',
        1,
      );
      expect(onTranscriptActivity).toHaveBeenCalledWith(stream);
      expect(stream.transcriptOffset).toBeGreaterThan('initial-frame'.length);
    } finally {
      transcriptStream.dispose(stream);
    }
  });

  it('skips live transcript reads while resize output is suppressed', async () => {
    // Arrange
    const transcriptPath = join(createTempDir('aumx-transcript-'), 'pane.ansi');
    writeFileSync(transcriptPath, 'initial-frame');
    const stream = makeStream(transcriptPath);
    const sendToRenderer = vi.fn();
    const transcriptStream = new TerminalTranscriptStream({
      isCurrentStream: () => true,
      sendToRenderer,
    });

    try {
      await transcriptStream.attach(stream, transcriptPath);
      appendFileSync(transcriptPath, 'resize-redraw');
      stream.transcriptSuppressedUntil = Date.now() + 1000;

      // Act
      transcriptStream.readNewData(stream);
      await waitForFlush();
      stream.transcriptSuppressedUntil = 0;
      appendFileSync(transcriptPath, 'fresh-frame');
      transcriptStream.readNewData(stream);
      await waitForFlush();

      // Assert
      const data = sentData(sendToRenderer);
      expect(data).not.toContain('resize-redraw');
      expect(data).toContain('fresh-frame');
    } finally {
      transcriptStream.dispose(stream);
    }
  });

  it('skips live transcript reads while a read is already in flight', async () => {
    // Arrange
    const transcriptPath = join(createTempDir('aumx-transcript-'), 'pane.ansi');
    writeFileSync(transcriptPath, 'initial-frame');
    const stream = makeStream(transcriptPath);
    const sendToRenderer = vi.fn();
    const transcriptStream = new TerminalTranscriptStream({
      isCurrentStream: () => true,
      sendToRenderer,
    });

    try {
      await transcriptStream.attach(stream, transcriptPath);
      appendFileSync(transcriptPath, 'during-capture');
      stream.capturing = true;

      // Act
      transcriptStream.readNewData(stream);
      await waitForFlush();
      stream.capturing = false;
      transcriptStream.readNewData(stream);
      await waitForFlush();

      // Assert
      const data = sentData(sendToRenderer);
      expect(data).toContain('during-capture');
      expect(countOccurrences(data, 'during-capture')).toBe(1);
    } finally {
      transcriptStream.dispose(stream);
    }
  });

  it('skips live transcript reads while replay is in flight', async () => {
    // Arrange
    const transcriptPath = join(createTempDir('aumx-transcript-'), 'pane.ansi');
    writeFileSync(transcriptPath, 'initial-frame');
    const stream = makeStream(transcriptPath);
    const sendToRenderer = vi.fn();
    const transcriptStream = new TerminalTranscriptStream({
      isCurrentStream: () => true,
      sendToRenderer,
    });

    try {
      await transcriptStream.attach(stream, transcriptPath);
      appendFileSync(transcriptPath, 'during-replay');
      stream.transcriptReplayInFlight = true;

      // Act
      transcriptStream.readNewData(stream);
      await waitForFlush();
      stream.transcriptReplayInFlight = false;
      transcriptStream.resumeFollowingFromOffset(stream, 'initial-frame'.length);
      transcriptStream.readNewData(stream);
      await waitForFlush();

      // Assert
      const data = sentData(sendToRenderer);
      expect(data).toContain('during-replay');
      expect(countOccurrences(data, 'during-replay')).toBe(1);
    } finally {
      transcriptStream.dispose(stream);
    }
  });
});

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (offset < text.length) {
    const index = text.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}
