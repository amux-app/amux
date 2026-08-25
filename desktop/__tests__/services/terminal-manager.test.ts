import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { NO_CONTENT_SYMBOL } = vi.hoisted(() => ({
  NO_CONTENT_SYMBOL: Symbol('no-content'),
}));

const electronSettingsSpies = vi.hoisted(() => ({
  getAll: vi.fn(),
  update: vi.fn(),
}));

const { notePaneActivity } = vi.hoisted(() => ({
  notePaneActivity: vi.fn(),
}));

const { paneGeometryMock, paneStateMock } = vi.hoisted(() => ({
  paneGeometryMock: vi.fn(),
  paneStateMock: vi.fn(),
}));

vi.mock('muxbase/core', () => ({
  execAsync: vi.fn().mockResolvedValue('0'),
  execFileAsync: vi.fn().mockResolvedValue('NORMAL'),
  getStatusDetector: () => ({ notePaneActivity }),
  shQuote: (value: string) => `'${value.replace(/'/g, "'\\''")}'`,
}));

vi.mock('../../src/main/services/Logger.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    infoThrottled: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../src/main/services/ElectronSettingsService.js', () => ({
  ElectronSettingsService: {
    getInstance: () => electronSettingsSpies,
  },
}));

vi.mock('../../src/main/services/terminal-input.js', () => ({
  submitTerminalCommand: vi.fn().mockResolvedValue(undefined),
  writeTerminalInput: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/main/services/terminal-render.js', () => ({
  compactAgentScrollbackForReplay: vi.fn((content: string) => ({
    content,
    droppedLines: 0,
    duplicateNumberedLines: 0,
    duplicateStartupFrames: 0,
  })),
  formatScrollbackInsert: vi.fn((content: string) => `[SCROLLBACK]${content}`),
  formatScrollbackReplay: vi.fn((content: string) => `[SCROLLBACK-REPLAY]${content}`),
  renderCapturedPaneFrame: vi.fn((opts: { content: string }) => `[FRAME]${opts.content}`),
}));

vi.mock('../../src/main/services/terminal-stream-state.js', () => ({
  NO_CONTENT: NO_CONTENT_SYMBOL,
  capturePane: vi.fn().mockResolvedValue('initial-content'),
  capturePaneText: vi.fn().mockResolvedValue('initial-content'),
  displayPaneFormat: vi.fn((tmuxPaneId: string, format: string) => (
    ['alternate_on', 'cursor_x', 'history_size', 'pane_in_mode'].some((field) => format.includes(field))
      ? paneStateMock(tmuxPaneId, format)
      : paneGeometryMock(tmuxPaneId, format)
  )),
  cursorStateEquals: vi.fn(() => false),
  stripAnsiForLog: vi.fn((s: string) => s),
}));

const transcriptStreamSpies = {
  attach: vi.fn().mockResolvedValue(undefined),
  discardBufferedDataAndSeekToEnd: vi.fn(),
  pauseFollowing: vi.fn(),
  queue: vi.fn(),
  readNewData: vi.fn(),
  replayExistingData: vi.fn().mockResolvedValue({ offset: 13, replayed: true }),
  resumeFollowing: vi.fn(),
  resumeFollowingFromOffset: vi.fn(),
  dispose: vi.fn(),
};

const ptyServiceSpies = vi.hoisted(() => ({
  attach: vi.fn(),
}));

const ptyOsc52FollowerSpies = vi.hoisted(() => ({
  attach: vi.fn(),
}));

vi.mock('../../src/main/services/terminal-transcript-stream.js', () => ({
  TerminalTranscriptStream: vi.fn().mockImplementation(() => transcriptStreamSpies),
}));

vi.mock('../../src/main/services/tmux-control-mode.js', () => ({
  TmuxControlModeClient: vi.fn().mockImplementation(() => ({
    ensureStarted: vi.fn().mockResolvedValue(undefined),
    subscribePane: vi.fn(),
    stop: vi.fn(),
    sendCommand: vi.fn(),
  })),
}));

vi.mock('../../src/main/services/terminal-pty-service.js', () => ({
  TerminalPtyService: vi.fn().mockImplementation(() => ptyServiceSpies),
}));

vi.mock('../../src/main/services/terminal-pty-osc52-follower.js', () => ({
  TerminalPtyOsc52Follower: vi.fn().mockImplementation(() => ptyOsc52FollowerSpies),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
}));

import { execAsync, execFileAsync, shQuote } from 'muxbase/core';
import { existsSync } from 'fs';
import { IPC_EVENT } from '../../src/shared/ipc-channels';
import { log } from '../../src/main/services/Logger.js';
import { TerminalManager } from '../../src/main/services/TerminalManager';
import { submitTerminalCommand, writeTerminalInput } from '../../src/main/services/terminal-input';
import {
  compactAgentScrollbackForReplay,
  formatScrollbackInsert,
  formatScrollbackReplay,
  renderCapturedPaneFrame,
} from '../../src/main/services/terminal-render';
import { capturePane, capturePaneText } from '../../src/main/services/terminal-stream-state';

interface FakeWindowHandle {
  window: BrowserWindow;
  send: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
}

interface Deferred<TValue> {
  promise: Promise<TValue>;
  reject: (error: Error) => void;
  resolve: (value: TValue) => void;
}

function createDeferred<TValue>(): Deferred<TValue> {
  let resolveValue: ((value: TValue) => void) | null = null;
  let rejectValue: ((error: Error) => void) | null = null;
  const promise = new Promise<TValue>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  if (!resolveValue || !rejectValue) throw new Error('deferred promise was not initialized');
  return { promise, reject: rejectValue, resolve: resolveValue };
}

function makeFakeWindow(): FakeWindowHandle {
  const send = vi.fn();
  const isDestroyed = vi.fn(() => false);
  const window = {
    webContents: { send },
    isDestroyed,
  } as unknown as BrowserWindow;
  return { window, send, isDestroyed };
}

async function flushMicrotasks(): Promise<void> {
  // Allow chained promise + setTimeout(0) work to drain.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function mockTmuxState(historySize = '0', alternateOn = '0', cursor = '0:0:1'): void {
  paneStateMock.mockImplementation(async (_tmuxPaneId: string, format: string) => {
    if (format.includes('history_size')) return historySize;
    if (format.includes('alternate_on')) return alternateOn;
    if (format.includes('cursor_x')) return cursor;
    return '0';
  });
}

function mockVerifiedPaneResize(from: string, to: string): void {
  paneGeometryMock
    .mockReset()
    .mockResolvedValueOnce(from)
    .mockResolvedValue(to);
}

describe('TerminalManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transcriptStreamSpies.attach.mockReset().mockResolvedValue(undefined);
    transcriptStreamSpies.discardBufferedDataAndSeekToEnd.mockReset();
    transcriptStreamSpies.pauseFollowing.mockReset();
    transcriptStreamSpies.queue.mockReset();
    transcriptStreamSpies.readNewData.mockReset();
    transcriptStreamSpies.replayExistingData.mockReset().mockResolvedValue({ offset: 13, replayed: true });
    transcriptStreamSpies.resumeFollowing.mockReset();
    transcriptStreamSpies.resumeFollowingFromOffset.mockReset();
    transcriptStreamSpies.dispose.mockReset();
    ptyServiceSpies.attach.mockReset();
    ptyOsc52FollowerSpies.attach.mockReset().mockReturnValue({ dispose: vi.fn() });
    electronSettingsSpies.getAll.mockReset().mockReturnValue({
      scrollbackLines: 1000,
      terminalOsc52Clipboard: 'off',
      terminalPreferredLaunchCols: 0,
      terminalPreferredLaunchRows: 0,
    });
    electronSettingsSpies.update.mockReset().mockImplementation(() => electronSettingsSpies.getAll());
    vi.mocked(compactAgentScrollbackForReplay).mockReset().mockImplementation((content: string) => ({
      content,
      droppedLines: 0,
      duplicateNumberedLines: 0,
      duplicateStartupFrames: 0,
    }));
    paneGeometryMock.mockReset().mockResolvedValue('80x24:@1:80x24:1');
    paneStateMock.mockReset().mockResolvedValue('0');
    vi.mocked(capturePane).mockReset().mockResolvedValue('initial-content');
    vi.mocked(capturePaneText).mockReset().mockResolvedValue('initial-content');
    vi.mocked(execAsync).mockReset().mockResolvedValue('0');
    vi.mocked(execFileAsync).mockReset().mockResolvedValue('NORMAL');
    vi.mocked(existsSync).mockReset().mockReturnValue(false);
    vi.mocked(submitTerminalCommand).mockReset().mockResolvedValue(undefined);
    vi.mocked(writeTerminalInput).mockReset().mockResolvedValue(undefined);
  });

  it('attach creates a capture-mode stream and emits initial content to the renderer', async () => {
    // Arrange
    const { window, send } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });

    // Act
    const dims = await manager.attach('p1', 'muxbase-test', '%1');
    await flushMicrotasks();

    // Assert
    expect(dims).toEqual(expect.objectContaining({ cols: 80, rows: 24, windowId: '@1' }));
    expect(paneGeometryMock).toHaveBeenCalledWith('%1', expect.stringContaining('pane_width'));
    expect(capturePane).toHaveBeenCalledWith('%1');
    // initial capture should have been delivered to the renderer
    const terminalDataCalls = send.mock.calls.filter((call) => call[1]?.paneId === 'p1');
    expect(terminalDataCalls.length).toBeGreaterThan(0);

    manager.destroyAll();
  });

  it('rejects attach when tmux reports the pane is missing', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    paneGeometryMock.mockRejectedValue(new Error("can't find pane: %404"));

    // Act
    const attach = manager.attach('p1', 'muxbase-test', '%404');

    // Assert
    await expect(attach).rejects.toThrow('Terminal pane no longer exists');
    expect(capturePane).not.toHaveBeenCalled();

    manager.destroyAll();
  });

  it('reads capture-mode pane state shell-free and still parses every tmux format', async () => {
    // Arrange — a pane id that a shell would mangle proves nothing re-quotes it.
    const hostilePaneId = "%1'; touch /tmp/muxbase-pwn; #";
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    mockTmuxState('7', '0', '4:9:1');

    // Act
    await manager.attach('p1', 'muxbase-test', hostilePaneId);
    await flushMicrotasks();

    // Assert — every format query is argv-based, with the raw pane id.
    expect(paneStateMock).toHaveBeenCalledWith(hostilePaneId, '#{alternate_on}');
    expect(paneStateMock).toHaveBeenCalledWith(hostilePaneId, '#{history_size}');
    expect(paneStateMock).toHaveBeenCalledWith(hostilePaneId, '#{cursor_x}:#{cursor_y}:#{cursor_flag}');
    expect(vi.mocked(execAsync).mock.calls.some(([command]) => (
      String(command).includes('display-message')
    ))).toBe(false);

    // Assert — parsing of each value is unchanged.
    expect(capturePane).toHaveBeenCalledWith(hostilePaneId);
    expect(renderCapturedPaneFrame).toHaveBeenCalledWith(expect.objectContaining({
      alternateOn: false,
      cursor: { x: 4, y: 9, visible: true },
    }));
    expect(vi.mocked(log.debug).mock.calls.some((call) => (
      call[1] === 'Scrollback baseline set (attach)' && call[2]?.historySize === 7
    ))).toBe(true);

    manager.destroyAll();
  });

  it('replays agent transcript panes from a tmux snapshot before following live bytes', async () => {
    // Arrange
    const { window, send } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    vi.mocked(existsSync).mockReturnValue(true);
    mockTmuxState('2');
    vi.mocked(capturePane).mockImplementation(async (_tmuxPaneId, opts) => (
      opts ? 'history-line-1\nhistory-line-2' : 'current-frame'
    ));

    // Act
    const dimensions = await manager.attach('p1', 'muxbase-test', '%1', '/tmp/pane.ansi', undefined, true);
    await flushMicrotasks();

    // Assert
    expect(dimensions).toEqual(expect.objectContaining({ cols: 80, rows: 24, windowId: '@1' }));
    expect(transcriptStreamSpies.replayExistingData).not.toHaveBeenCalled();
    expect(capturePane).toHaveBeenCalledWith('%1', {
      endLine: -1,
      startLine: -2,
    });
    expect(capturePane).toHaveBeenCalledWith('%1');
    expect(formatScrollbackReplay).toHaveBeenCalledWith(
      'history-line-1\nhistory-line-2',
      24,
      80,
    );
    expect(transcriptStreamSpies.attach).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'p1', streamId: 1 }),
      '/tmp/pane.ansi',
    );
    const replayOrder = vi.mocked(capturePane).mock.invocationCallOrder[0];
    const attachOrder = transcriptStreamSpies.attach.mock.invocationCallOrder[0];
    expect(replayOrder).toBeLessThan(attachOrder);

    const payloads = send.mock.calls
      .filter((call) => call[1]?.paneId === 'p1')
      .map((call) => call[1]?.data)
      .join('');
    expect(payloads).toContain('\x1bc');
    expect(payloads).toContain('[SCROLLBACK-REPLAY]history-line-1\nhistory-line-2');
    expect(payloads).toContain('[FRAME]current-frame');
    expect(payloads).not.toContain('[SANITIZED-SCROLLBACK]');

    manager.destroyAll();
  });

  it('compacts duplicate Claude startup redraws in agent snapshot scrollback', async () => {
    // Arrange
    const { window, send } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    vi.mocked(existsSync).mockReturnValue(true);
    mockTmuxState('4');
    vi.mocked(capturePane).mockImplementation(async (_tmuxPaneId, opts) => (
      opts ? 'old-startup\nold-body\nstable-startup\nfirst-prompt' : 'current-frame'
    ));
    vi.mocked(compactAgentScrollbackForReplay).mockReturnValue({
      content: 'stable-startup\nfirst-prompt',
      droppedLines: 2,
      duplicateNumberedLines: 0,
      duplicateStartupFrames: 2,
    });

    // Act
    await manager.attach('p1', 'muxbase-test', '%1', '/tmp/pane.ansi', undefined, true);
    await flushMicrotasks();

    // Assert
    expect(compactAgentScrollbackForReplay).toHaveBeenCalledWith(
      'old-startup\nold-body\nstable-startup\nfirst-prompt',
    );
    const payloads = send.mock.calls
      .filter((call) => call[1]?.paneId === 'p1')
      .map((call) => call[1]?.data)
      .join('');
    expect(payloads).toContain('[SCROLLBACK-REPLAY]stable-startup\nfirst-prompt');
    expect(payloads).not.toContain('old-startup');
    expect(vi.mocked(log.debug)).toHaveBeenCalledWith(
      'terminal',
      'Compacted duplicate agent startup scrollback',
      expect.objectContaining({
        droppedLines: 2,
        duplicateStartupFrames: 2,
        paneId: 'p1',
        tmuxPaneId: '%1',
      }),
    );

    manager.destroyAll();
  });

  it('cancels a stale pending attach when a newer stream id arrives before stream init', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    const firstDimensions = createDeferred<string>();
    vi.mocked(existsSync).mockReturnValue(true);
    paneGeometryMock
      .mockImplementationOnce(() => firstDimensions.promise)
      .mockResolvedValue('80x24:@1:80x24:1');
    vi.mocked(execAsync).mockResolvedValue('0');

    // Act
    const firstAttach = manager.attach('p1', 'muxbase-test', '%1', '/tmp/pane.ansi', undefined, true, 101);
    const secondAttach = manager.attach('p1', 'muxbase-test', '%1', '/tmp/pane.ansi', undefined, true, 202);
    firstDimensions.resolve('80x24:@1:80x24:1');
    const [first, second] = await Promise.all([firstAttach, secondAttach]);

    // Assert
    expect(first.streamId).toBe(101);
    expect(second.streamId).toBe(202);
    expect(transcriptStreamSpies.replayExistingData).not.toHaveBeenCalled();
    expect(capturePane).toHaveBeenCalledWith('%1');
    expect(transcriptStreamSpies.attach).toHaveBeenCalledTimes(1);
    expect(transcriptStreamSpies.attach).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'p1', streamId: 202 }),
      '/tmp/pane.ansi',
    );

    manager.destroyAll();
  });

  it('does not carry a queued stdin unlock across a canceled pre-registration attach', async () => {
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    const firstDimensions = createDeferred<string>();
    paneGeometryMock
      .mockImplementationOnce(() => firstDimensions.promise)
      .mockResolvedValue('80x24:@1:80x24:1');

    const canceledAttach = manager.attach('p1', 'muxbase-test', '%1', undefined, undefined, false, 101);
    manager.unlockStdin('p1');
    manager.detach('p1');
    firstDimensions.resolve('80x24:@1:80x24:1');
    await canceledAttach;

    await manager.attach('p1', 'muxbase-test', '%1', undefined, undefined, false, 202);
    vi.mocked(writeTerminalInput).mockClear();
    await manager.write('p1', 'must-remain-locked');
    expect(writeTerminalInput).not.toHaveBeenCalled();

    manager.unlockStdin('p1');
    await manager.write('p1', 'now-writable');
    expect(writeTerminalInput).toHaveBeenCalledWith('%1', 'now-writable');

    manager.destroyAll();
  });

  it('never lets a canceled pending attach regain ownership during an immediate replacement', async () => {
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    const staleDimensions = createDeferred<string>();
    const replacementDimensions = createDeferred<string>();
    paneGeometryMock
      .mockImplementationOnce(() => staleDimensions.promise)
      .mockImplementationOnce(() => replacementDimensions.promise)
      .mockResolvedValue('80x24:@1:80x24:1');

    const staleAttach = manager.attach('p1', 'muxbase-test', '%old', undefined, undefined, false, 101);
    manager.detach('p1');
    const replacementAttach = manager.attach('p1', 'muxbase-test', '%new', undefined, undefined, false, 202);

    // The canceled operation finishes first while the replacement is still
    // pending. Its generation must remain stale even though its map entry was
    // lifecycle-cleaned by detach.
    staleDimensions.resolve('80x24:@1:80x24:1');
    await staleAttach;
    replacementDimensions.resolve('80x24:@1:80x24:1');
    await replacementAttach;

    manager.unlockStdin('p1');
    vi.mocked(writeTerminalInput).mockClear();
    await manager.write('p1', 'replacement-owned-input');

    expect(writeTerminalInput).toHaveBeenCalledWith('%new', 'replacement-owned-input');
    expect(writeTerminalInput).not.toHaveBeenCalledWith('%old', expect.any(String));

    manager.destroyAll();
  });

  it('serializes superseded pending-attach geometry so the newest size wins', async () => {
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'classic' });
    const firstResizeGate = createDeferred<void>();
    let geometry = '80x24:@1:80x24:1';
    paneGeometryMock.mockImplementation(async () => geometry);
    vi.mocked(execAsync).mockImplementation(async (command: string) => {
      const size = command.match(/-x (\d+) -y (\d+)/);
      if (command.includes('resize-window') && size?.[1] === '120') {
        await firstResizeGate.promise;
      }
      if ((command.includes('resize-window') || command.includes('resize-pane')) && size) {
        geometry = `${size[1]}x${size[2]}:@1:${size[1]}x${size[2]}:1`;
      }
      return '0';
    });

    const firstAttach = manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      undefined,
      { cols: 120, rows: 36 },
      false,
      901,
    );
    await vi.waitFor(() => expect(execAsync).toHaveBeenCalledWith(
      "tmux resize-window -t '%1' -x 120 -y 36",
      { silent: true },
    ));

    const replacementAttach = manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      undefined,
      { cols: 90, rows: 28 },
      false,
      902,
    );
    await flushMicrotasks();
    const commandsBeforeRelease = vi.mocked(execAsync).mock.calls.map(([command]) => String(command));
    expect(commandsBeforeRelease.some((command) => (
      command.includes('resize-window') && command.includes('-x 90')
    ))).toBe(false);

    firstResizeGate.resolve(undefined);
    const [, replacement] = await Promise.all([firstAttach, replacementAttach]);
    expect(replacement).toEqual(expect.objectContaining({ cols: 90, rows: 28, streamId: 902 }));
    const resizeCommands = vi.mocked(execAsync).mock.calls
      .map(([command]) => String(command))
      .filter((command) => command.includes('resize-window') || command.includes('resize-pane'));
    expect(resizeCommands.at(-2)).toContain('-x 90 -y 28');
    expect(resizeCommands.at(-1)).toContain('-x 90 -y 28');
    expect(geometry).toBe('90x28:@1:90x28:1');

    manager.destroyAll();
  });

  it('disposes a capture-mode attach that becomes stale during first capture', async () => {
    // Arrange
    const { window, send } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    let detachedDuringCapture = false;
    paneStateMock.mockImplementation(async (_tmuxPaneId: string, format: string) => {
      if (format.includes('history_size')) return '0';
      if (format.includes('alternate_on')) {
        if (!detachedDuringCapture) {
          detachedDuringCapture = true;
          manager.detach('p1');
        }
        return '0';
      }
      if (format.includes('cursor_x')) return '0:0:1';
      return '0';
    });
    vi.mocked(capturePane).mockResolvedValue('stale-capture-frame');

    // Act
    const dimensions = await manager.attach('p1', 'muxbase-test', '%1', undefined, undefined, false, 303);
    await flushMicrotasks();
    vi.mocked(writeTerminalInput).mockClear();
    await manager.write('p1', 'late-write');

    // Assert
    const payloads = send.mock.calls
      .filter((call) => call[1]?.paneId === 'p1')
      .map((call) => call[1]?.data)
      .join('');
    expect(dimensions).toEqual(expect.objectContaining({ cols: 80, rows: 24, streamId: 303, windowId: '@1' }));
    expect(detachedDuringCapture).toBe(true);
    expect(capturePane).not.toHaveBeenCalled();
    expect(payloads).not.toContain('stale-capture-frame');
    expect(writeTerminalInput).not.toHaveBeenCalled();
    expect(vi.mocked(log.info).mock.calls.some((call) => (
      call[0] === 'terminal' && call[1] === 'Pane stream started'
    ))).toBe(false);

    manager.destroyAll();
  });

  it('paints a captured frame for agent transcript panes when tmux has no scrollback', async () => {
    // Arrange
    const { window, send } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    vi.mocked(existsSync).mockReturnValue(true);
    mockTmuxState('0');
    vi.mocked(capturePane).mockResolvedValue('current-frame');

    // Act
    const dimensions = await manager.attach('p1', 'muxbase-test', '%1', '/tmp/pane.ansi', undefined, true);
    await flushMicrotasks();

    // Assert
    expect(dimensions).toEqual(expect.objectContaining({ cols: 80, rows: 24, windowId: '@1' }));
    expect(transcriptStreamSpies.replayExistingData).not.toHaveBeenCalled();
    expect(capturePane).toHaveBeenCalledWith('%1');
    expect(transcriptStreamSpies.attach).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'p1' }),
      '/tmp/pane.ansi',
    );
    const payloads = send.mock.calls
      .filter((call) => call[1]?.paneId === 'p1')
      .map((call) => call[1]?.data)
      .join('');
    expect(payloads).toContain('\x1bc');
    expect(payloads).toContain('[FRAME]current-frame');

    manager.destroyAll();
  });

  it('preserves tmux scrollback for non-agent transcript panes before following live bytes', async () => {
    // Arrange
    const { window, send } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    vi.mocked(existsSync).mockReturnValue(true);
    mockTmuxState('2');
    vi.mocked(capturePane).mockImplementation(async (_tmuxPaneId, opts) => (
      opts ? 'history-line-1\nhistory-line-2' : 'current-frame'
    ));

    // Act
    const dimensions = await manager.attach('p1', 'muxbase-test', '%1', '/tmp/pane.ansi');
    await flushMicrotasks();

    // Assert
    expect(dimensions).toEqual(expect.objectContaining({ cols: 80, rows: 24, windowId: '@1' }));
    expect(compactAgentScrollbackForReplay).not.toHaveBeenCalled();
    expect(capturePane).toHaveBeenCalledWith('%1', { startLine: -2, endLine: -1 });
    expect(formatScrollbackReplay).toHaveBeenCalledWith(
      'history-line-1\nhistory-line-2',
      24,
      80,
    );
    expect(transcriptStreamSpies.attach).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'p1' }),
      '/tmp/pane.ansi',
    );
    const payloads = send.mock.calls
      .filter((call) => call[1]?.paneId === 'p1')
      .map((call) => call[1]?.data)
      .join('');
    expect(payloads).toContain('\x1bc');
    expect(payloads).toContain('[SCROLLBACK-REPLAY]history-line-1\nhistory-line-2');
    expect(payloads).toContain('[FRAME]current-frame');
    expect(payloads.indexOf('[SCROLLBACK-REPLAY]')).toBeLessThan(payloads.indexOf('[FRAME]'));

    manager.destroyAll();
  });

  it('uses tmux snapshot replay for agent control-mode panes', async () => {
    // Arrange
    const { window, send } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'control' });
    mockTmuxState('2');
    vi.mocked(capturePane).mockImplementation(async (_tmuxPaneId, opts) => (
      opts ? 'history-line-1\nhistory-line-2' : 'current-frame'
    ));

    // Act
    const dimensions = await manager.attach('p1', 'muxbase-test', '%1', undefined, undefined, true);
    await flushMicrotasks();

    // Assert
    expect(dimensions).toEqual(expect.objectContaining({ cols: 80, rows: 24, windowId: '@1' }));
    expect(capturePane).toHaveBeenCalledWith('%1', { startLine: -2, endLine: -1 });
    expect(capturePane).toHaveBeenCalledWith('%1');
    const payloads = send.mock.calls
      .filter((call) => call[1]?.paneId === 'p1')
      .map((call) => call[1]?.data)
      .join('');
    expect(payloads).toContain('\x1bc');
    expect(payloads).toContain('[SCROLLBACK-REPLAY]history-line-1\nhistory-line-2');
    expect(payloads).toContain('[FRAME]current-frame');
    expect(payloads).not.toContain('[SANITIZED-SCROLLBACK]');

    manager.destroyAll();
  });

  it('keeps live control output gated until its resume snapshot is complete', async () => {
    const { window } = makeFakeWindow();
    let controlSubscriber: {
      onOutput: (data: string) => void;
      onUnavailable: (reason: string) => void;
    } | null = null;
    const controlClient = {
      ensureStarted: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn(),
      stop: vi.fn(),
      subscribePane: vi.fn((_paneId: string, subscriber: {
        onOutput: (data: string) => void;
        onUnavailable: (reason: string) => void;
      }) => {
        controlSubscriber = subscriber;
        return vi.fn();
      }),
    };
    const manager = new TerminalManager(window, {
      createControlClient: () => controlClient as never,
      pollIntervalMs: 200,
      transportMode: 'control',
    });
    mockTmuxState();
    await manager.attach('p1', 'muxbase-test', '%1', undefined, undefined, true, 101);
    if (!controlSubscriber) throw new Error('control subscriber was not registered');
    const subscriber = controlSubscriber as {
      onOutput: (data: string) => void;
      onUnavailable: (reason: string) => void;
    };
    const restoreCapture = createDeferred<string>();
    vi.mocked(capturePane).mockReset().mockReturnValueOnce(restoreCapture.promise);
    transcriptStreamSpies.queue.mockClear();

    manager.suspendRendererDelivery();
    subscriber.onOutput('changed-while-hidden');
    const resume = manager.resumeRendererDelivery();
    await vi.waitFor(() => expect(capturePane).toHaveBeenCalledOnce());

    subscriber.onOutput('must-not-interleave');
    expect(transcriptStreamSpies.queue).not.toHaveBeenCalledWith(
      expect.anything(),
      'must-not-interleave',
      'live',
    );

    restoreCapture.resolve('authoritative-control-frame');
    await resume;
    subscriber.onOutput('visible-live-output');

    expect(transcriptStreamSpies.queue).toHaveBeenCalledWith(
      expect.anything(),
      'visible-live-output',
      'live',
    );
    manager.destroyAll();
  });

  it('uses pty transport for attach, writes, resizes, and renderer output', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock
      .mockResolvedValueOnce('100x30:@7:100x30:1')
      .mockResolvedValueOnce('100x30:@7:100x30:1')
      .mockResolvedValue('120x36:@7:120x36:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });

    // Act
    const dimensions = await manager.attach('p1', 'muxbase-test', '%1', '/tmp/pane.ansi', {
      cols: 100,
      rows: 30,
    }, true, 901);
    const attachOptions = ptyServiceSpies.attach.mock.calls[0]?.[0];
    attachOptions.onData('p1', 'pty-live', 'live', 901);
    manager.unlockStdin('p1');
    await manager.write('p1', 'hello');
    await manager.resize('p1', 120, 36);
    manager.destroyAll();

    // Assert
    expect(dimensions).toEqual(expect.objectContaining({ cols: 100, rows: 30, streamId: 901, windowId: '@7' }));
    expect(ptyServiceSpies.attach).toHaveBeenCalledWith(expect.objectContaining({
      cols: 100,
      onData: expect.any(Function),
      onExit: expect.any(Function),
      paneId: 'p1',
      rows: 30,
      sessionName: 'muxbase-test',
      streamId: 901,
      tmuxPaneId: '%1',
      windowId: '@7',
    }));
    expect(ptyServiceSpies.attach.mock.calls[0]?.[0]).not.toHaveProperty('allowClipboard');
    expect(capturePane).not.toHaveBeenCalled();
    expect(transcriptStreamSpies.attach).not.toHaveBeenCalled();
    expect(writeTerminalInput).not.toHaveBeenCalled();
    expect(handle.write).toHaveBeenCalledWith('hello');
    expect(handle.resize).toHaveBeenCalledWith(120, 36);
    expect(execAsync).toHaveBeenCalledWith(
      "tmux resize-window -t '%1' -x 120 -y 36",
      { silent: true },
    );
    expect(execAsync).toHaveBeenCalledWith(
      "tmux resize-pane -t '%1' -x 120 -y 36",
      { silent: true },
    );
    expect(handle.dispose).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith('terminal', 'Terminal transport resolved', expect.objectContaining({
      configuredTransport: 'pty',
      mode: 'pty',
      paneId: 'p1',
    }));
    expect(transcriptStreamSpies.queue).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'p1', streamId: 901 }),
      'pty-live',
      'live',
    );
  });

  it('expands a scrolled PTY selection from authoritative tmux history', async () => {
    const { window } = makeFakeWindow();
    ptyServiceSpies.attach.mockResolvedValue({
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    });
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    vi.mocked(capturePaneText).mockResolvedValue([
      'first viewport',
      'middle viewport',
      'last viewport',
    ].join('\n'));
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);

    const expanded = await manager.expandSelection(
      'p1',
      'first viewport',
      'last viewport',
      'down',
    );

    expect(capturePaneText).toHaveBeenCalledWith('%1');
    expect(expanded).toEqual({
      status: 'expanded',
      text: 'first viewport\nmiddle viewport\nlast viewport',
    });
    manager.destroyAll();
  });

  it('distinguishes a missing normal-screen range from unavailable history', async () => {
    const { window } = makeFakeWindow();
    ptyServiceSpies.attach.mockResolvedValue({
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    });
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    vi.mocked(capturePaneText).mockResolvedValue('physical\nsoft-wrapped\nrows');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);

    const expanded = await manager.expandSelection(
      'p1',
      'logical soft-wrapped anchor',
      'logical soft-wrapped tail',
      'down',
    );

    expect(capturePaneText).toHaveBeenCalledWith('%1');
    expect(expanded).toEqual({ status: 'range-not-found' });
    manager.destroyAll();
  });

  it('does not treat an alternate-screen repaint as authoritative selection history', async () => {
    const { window } = makeFakeWindow();
    ptyServiceSpies.attach.mockResolvedValue({
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    });
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    mockTmuxState('0', '1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    vi.mocked(capturePaneText).mockClear();

    const expanded = await manager.expandSelection(
      'p1',
      'later OpenCode viewport',
      'earlier OpenCode viewport',
      'up',
    );

    expect(expanded).toEqual({ status: 'history-unavailable' });
    expect(capturePaneText).not.toHaveBeenCalled();
    manager.destroyAll();
  });

  it('reissues a tmux window resize when live window geometry drifts from the pane even though the requested size matches the cache', async () => {
    // Arrange — a non-fixed-cols (non-Claude) pty stream whose cached pane
    // size already equals the resize target, but tmux's window has drifted
    // from the pane (the `window-size manual` mismatch that paints a
    // dot-fill client). A live read must still catch the divergence.
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock
      .mockResolvedValueOnce('100x30:@7:100x30:1')
      .mockResolvedValue('100x30:@7:120x40:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);

    // Act
    await manager.resize('p1', 100, 30);

    // Assert — tmux is corrected instead of being skipped, because the drift
    // is only visible on the window dims, not the (already-matching) pane dims.
    expect(execAsync).toHaveBeenCalledWith(
      "tmux resize-window -t '%1' -x 100 -y 30",
      { silent: true },
    );
    expect(execAsync).toHaveBeenCalledWith(
      "tmux resize-pane -t '%1' -x 100 -y 30",
      { silent: true },
    );
    expect(handle.resize).toHaveBeenCalledWith(100, 30);

    manager.destroyAll();
  });

  it('skips the tmux resize when a multi-pane window has drifted but the pane itself already matches the target', async () => {
    // Arrange — the pane shares its tmux window with sibling panes (core-lib
    // sidebar layouts). Window != pane is permanent there, so the divergence
    // guard must not fire a resize on every settled resize.
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock
      .mockResolvedValueOnce('100x30:@7:100x30:2')
      .mockResolvedValue('100x30:@7:220x60:2');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);

    // Act
    await manager.resize('p1', 100, 30);

    // Assert — the pane target already matched, and the window is shared
    // with siblings, so tmux is left untouched despite the window drift.
    expect(execAsync).not.toHaveBeenCalledWith(
      "tmux resize-window -t '%1' -x 100 -y 30",
      { silent: true },
    );
    expect(execAsync).not.toHaveBeenCalledWith(
      "tmux resize-pane -t '%1' -x 100 -y 30",
      { silent: true },
    );
    expect(handle.resize).toHaveBeenCalledWith(100, 30);

    manager.destroyAll();
  });

  it('keeps renderer OSC 52 policy out of the tmux PTY transport contract', async () => {
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    electronSettingsSpies.getAll.mockReturnValue({
      scrollbackLines: 1000,
      terminalOsc52Clipboard: 'off',
      terminalPreferredLaunchCols: 0,
      terminalPreferredLaunchRows: 0,
    });
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });

    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);

    expect(ptyServiceSpies.attach.mock.calls[0]?.[0]).not.toHaveProperty('allowClipboard');

    manager.destroyAll();
  });

  it('re-arms status polling only for user-initiated terminal input', async () => {
    const { window } = makeFakeWindow();
    ptyServiceSpies.attach.mockResolvedValue({
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    });
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });

    await manager.attach('p1', 'muxbase-test', '%1', undefined, {
      cols: 80,
      rows: 24,
    }, true, 902);
    manager.unlockStdin('p1');

    await manager.write('p1', '\x1b[0n', false);
    expect(notePaneActivity).not.toHaveBeenCalled();

    await manager.write('p1', 'x', true);
    expect(notePaneActivity).toHaveBeenCalledOnce();
    expect(notePaneActivity).toHaveBeenCalledWith('p1');

    manager.destroyAll();
  });

  it('forwards only transcript-extracted application OSC 52 in pty mode under external policy', async () => {
    const { window, send } = makeFakeWindow();
    const ptyHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    const followerHandle = { dispose: vi.fn() };
    ptyServiceSpies.attach.mockResolvedValue(ptyHandle);
    ptyOsc52FollowerSpies.attach.mockReturnValue(followerHandle);
    vi.mocked(existsSync).mockReturnValue(true);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    vi.mocked(execAsync).mockImplementation(async (command: string) => (
      command.includes('show-options -sv set-clipboard') ? 'external' : '0'
    ));
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });

    await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      '/tmp/pane.ansi',
      { cols: 100, rows: 30 },
      true,
      901,
    );
    const onSequence = ptyOsc52FollowerSpies.attach.mock.calls[0]?.[1];
    onSequence('\x1b]52;c;QU1VWA==\x07');

    expect(ptyOsc52FollowerSpies.attach).toHaveBeenCalledWith(
      '/tmp/pane.ansi',
      expect.any(Function),
    );
    expect(send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        data: '\x1b]52;c;QU1VWA==\x07',
        paneId: 'p1',
        source: 'live',
        streamId: 901,
      }),
    );

    manager.destroyAll();
    expect(followerHandle.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate OSC 52 from the transcript when tmux policy already forwards it', async () => {
    const { window } = makeFakeWindow();
    ptyServiceSpies.attach.mockResolvedValue({
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    });
    vi.mocked(existsSync).mockReturnValue(true);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    vi.mocked(execAsync).mockImplementation(async (command: string) => (
      command.includes('show-options -sv set-clipboard') ? 'on' : '0'
    ));
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });

    await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      '/tmp/pane.ansi',
      { cols: 100, rows: 30 },
      true,
      901,
    );

    expect(ptyOsc52FollowerSpies.attach).not.toHaveBeenCalled();
    manager.destroyAll();
  });

  it.each(['empty', 'failure'] as const)(
    'does not start transcript OSC 52 extraction when tmux policy lookup returns %s',
    async (lookupResult) => {
      const { window } = makeFakeWindow();
      ptyServiceSpies.attach.mockResolvedValue({
        dispose: vi.fn(),
        resize: vi.fn(),
        write: vi.fn(),
      });
      vi.mocked(existsSync).mockReturnValue(true);
      paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
      vi.mocked(execAsync).mockImplementation(async (command: string) => {
        if (!command.includes('show-options -sv set-clipboard')) return '0';
        if (lookupResult === 'failure') throw new Error('policy unavailable');
        return '';
      });
      const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });

      await manager.attach(
        'p1',
        'muxbase-test',
        '%1',
        '/tmp/pane.ansi',
        { cols: 100, rows: 30 },
        true,
        901,
      );

      expect(ptyOsc52FollowerSpies.attach).not.toHaveBeenCalled();
      manager.destroyAll();
    },
  );

  it('does not install an OSC 52 follower after its stream is detached during policy lookup', async () => {
    const { window } = makeFakeWindow();
    const policy = createDeferred<string>();
    ptyServiceSpies.attach.mockResolvedValue({
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    });
    vi.mocked(existsSync).mockReturnValue(true);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    vi.mocked(execAsync).mockImplementation(async (command: string) => (
      command.includes('show-options -sv set-clipboard') ? policy.promise : '0'
    ));
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });

    const attaching = manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      '/tmp/pane.ansi',
      { cols: 100, rows: 30 },
      true,
      901,
    );
    await flushMicrotasks();
    manager.detach('p1');
    policy.resolve('external');
    await attaching;

    expect(ptyOsc52FollowerSpies.attach).not.toHaveBeenCalled();
    expect(ptyServiceSpies.attach).not.toHaveBeenCalled();
    manager.destroyAll();
  });

  it('does not install an OSC 52 follower when the renderer hides during policy lookup', async () => {
    const { window } = makeFakeWindow();
    const policy = createDeferred<string>();
    ptyServiceSpies.attach.mockResolvedValue({
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    });
    vi.mocked(existsSync).mockReturnValue(true);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    vi.mocked(execAsync).mockImplementation(async (command: string) => (
      command.includes('show-options -sv set-clipboard') ? policy.promise : '0'
    ));
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });

    const attaching = manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      '/tmp/pane.ansi',
      { cols: 100, rows: 30 },
      true,
      901,
    );
    await flushMicrotasks();
    manager.suspendRendererDelivery();
    policy.resolve('external');
    await attaching;

    expect(ptyOsc52FollowerSpies.attach).not.toHaveBeenCalled();
    manager.destroyAll();
  });

  it('does not let stale registered-attach cleanup dispose a rehydrated PTY stream', async () => {
    const { window } = makeFakeWindow();
    const policy = createDeferred<string>();
    const replacementHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(replacementHandle);
    vi.mocked(existsSync).mockReturnValue(true);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    vi.mocked(execAsync).mockImplementation(async (command: string) => (
      command.includes('show-options -sv set-clipboard') ? policy.promise : '0'
    ));
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });

    const staleAttach = manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      '/tmp/pane.ansi',
      { cols: 100, rows: 30 },
      true,
      901,
    );
    await vi.waitFor(() => expect(execAsync).toHaveBeenCalledWith(
      'tmux show-options -sv set-clipboard',
      { silent: true },
    ));

    const replacement = await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      '/tmp/pane.ansi',
      { cols: 100, rows: 30 },
      true,
      902,
    );
    expect(replacement.streamId).toBe(902);
    policy.resolve('external');
    await staleAttach;

    manager.unlockStdin('p1');
    await manager.write('p1', 'x');
    expect(replacementHandle.dispose).not.toHaveBeenCalled();
    expect(replacementHandle.write).toHaveBeenCalledWith('x');

    manager.destroyAll();
  });

  it('pre-sizes pty panes to the requesting view at attach', async () => {
    // Arrange: the pane is 212x54 in tmux; the mounting view fits 104x30.
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock
      .mockResolvedValueOnce('212x54:@7:212x54:1')
      .mockResolvedValue('104x30:@7:104x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });

    // Act
    const dimensions = await manager.attach('p1', 'muxbase-test', '%1', undefined, {
      cols: 104,
      rows: 30,
    }, true, 901);

    // Assert: tmux is brought to the container size before the client spawns.
    expect(execAsync).toHaveBeenCalledWith(
      "tmux resize-window -t '%1' -x 104 -y 30",
      { silent: true },
    );
    expect(dimensions).toEqual(expect.objectContaining({ cols: 104, mode: 'pty', rows: 30 }));
    expect(ptyServiceSpies.attach).toHaveBeenCalledWith(expect.objectContaining({ cols: 104, rows: 30 }));
    expect(manager.getPreferredLaunchSize()).toEqual({ cols: 104, rows: 30 });

    manager.destroyAll();
  });

  it('shell-quotes the tmux pane id at every authoritative resize boundary', async () => {
    const { window } = makeFakeWindow();
    const maliciousPaneId = "%1'; touch /tmp/muxbase-injected; #";
    mockVerifiedPaneResize('80x24:@7:80x24:1', '100x24:@7:100x24:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'classic' });

    await manager.attach(
      'p1',
      'muxbase-test',
      maliciousPaneId,
      undefined,
      { cols: 80, rows: 24 },
      false,
      901,
      100,
    );

    const quotedTarget = shQuote(maliciousPaneId);
    expect(execAsync).toHaveBeenCalledWith(
      `tmux resize-window -t ${quotedTarget} -x 100 -y 24`,
      { silent: true },
    );
    expect(execAsync).toHaveBeenCalledWith(
      `tmux resize-pane -t ${quotedTarget} -x 100 -y 24`,
      { silent: true },
    );

    manager.destroyAll();
  });

  it('enforces fixed columns exactly even when the renderer proposes a wider grid', async () => {
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock
      .mockResolvedValueOnce('120x30:@7:120x30:1')
      .mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });

    const dimensions = await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      undefined,
      { cols: 120, rows: 30 },
      true,
      901,
      100,
    );

    expect(dimensions).toEqual(expect.objectContaining({ cols: 100, rows: 30 }));
    expect(execAsync).toHaveBeenCalledWith(
      "tmux resize-window -t '%1' -x 100 -y 30",
      { silent: true },
    );
    expect(ptyServiceSpies.attach).toHaveBeenCalledWith(expect.objectContaining({
      cols: 100,
      rows: 30,
    }));

    manager.destroyAll();
  });

  it('rejects PTY attach when tmux does not adopt the requested source geometry', async () => {
    const { window } = makeFakeWindow();
    ptyServiceSpies.attach.mockResolvedValue({
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    });
    paneGeometryMock.mockResolvedValue('120x30:@7:120x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });

    await expect(manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      undefined,
      { cols: 100, rows: 30 },
      true,
      901,
      100,
    )).rejects.toThrow('did not reach requested geometry');

    expect(ptyServiceSpies.attach).not.toHaveBeenCalled();
    manager.destroyAll();
  });

  it('does not persist fixed terminal geometry as the preferred launch size', async () => {
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock
      .mockResolvedValueOnce('100x30:@7:100x30:1')
      .mockResolvedValue('100x36:@7:100x36:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });

    await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      undefined,
      { cols: 100, rows: 30 },
      true,
      901,
      100,
    );
    await manager.resize('p1', 140, 36);

    expect(manager.getPreferredLaunchSize()).toBeNull();
    expect(electronSettingsSpies.update).not.toHaveBeenCalledWith(
      'terminalPreferredLaunchCols',
      expect.anything(),
    );
    expect(handle.resize).toHaveBeenCalledWith(100, 36);

    manager.destroyAll();
  });

  it('corrects externally changed fixed geometry even when the cached size already matches', async () => {
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock
      .mockResolvedValueOnce('100x30:@7:100x30:1')
      .mockResolvedValueOnce('120x30:@7:120x30:1')
      .mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      undefined,
      { cols: 100, rows: 30 },
      true,
      901,
      100,
    );

    await manager.resize('p1', 100, 30);

    expect(execAsync).toHaveBeenCalledWith(
      "tmux resize-window -t '%1' -x 100 -y 30",
      { silent: true },
    );
    expect(handle.resize).toHaveBeenCalledWith(100, 30);

    manager.destroyAll();
  });

  it('rejects a pty resize when source geometry verification fails', async () => {
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock
      .mockResolvedValueOnce('100x30:@7:100x30:1')
      .mockResolvedValue('120x30:@7:120x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      undefined,
      { cols: 100, rows: 30 },
      true,
      901,
      100,
    );

    await expect(manager.resize('p1', 100, 30)).rejects.toThrow(
      'did not reach requested geometry',
    );
    expect(handle.resize).not.toHaveBeenCalled();

    manager.destroyAll();
  });

  it('enforces and verifies fixed geometry before a classic transport attach', async () => {
    const { window } = makeFakeWindow();
    vi.mocked(existsSync).mockReturnValue(true);
    paneGeometryMock
      .mockResolvedValueOnce('120x30:@7:120x30:1')
      .mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'classic' });

    const dimensions = await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      '/tmp/pane.ansi',
      { cols: 120, rows: 30 },
      true,
      901,
      100,
    );

    expect(dimensions).toEqual(expect.objectContaining({
      cols: 100,
      mode: 'transcript',
      rows: 30,
    }));
    expect(execAsync).toHaveBeenCalledWith(
      "tmux resize-window -t '%1' -x 100 -y 30",
      { silent: true },
    );

    manager.destroyAll();
  });

  it('rejects a fixed classic resize when source geometry verification fails', async () => {
    const { window } = makeFakeWindow();
    paneGeometryMock
      .mockResolvedValueOnce('100x30:@7:100x30:1')
      .mockResolvedValue('120x30:@7:120x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'classic' });
    await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      undefined,
      { cols: 100, rows: 30 },
      true,
      901,
      100,
    );

    await expect(manager.resize('p1', 100, 30)).rejects.toThrow(
      'did not reach requested geometry',
    );

    manager.destroyAll();
  });

  it('rejects a responsive classic resize when tmux does not reach the requested geometry', async () => {
    const { window } = makeFakeWindow();
    paneGeometryMock.mockResolvedValue('80x24:@7:80x24:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'classic' });
    await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      undefined,
      { cols: 80, rows: 24 },
      false,
      901,
    );
    vi.mocked(execAsync).mockImplementation(async (command: string) => {
      if (command.includes('resize-window')) throw new Error('responsive resize failed');
      return '0';
    });

    await expect(manager.resize('p1', 120, 36)).rejects.toThrow(
      'responsive resize failed',
    );

    manager.destroyAll();
  });

  it('restores externally changed fixed geometry when a classic stream rehydrates', async () => {
    const { window } = makeFakeWindow();
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'classic' });
    await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      undefined,
      { cols: 100, rows: 30 },
      false,
      901,
      100,
    );
    await flushMicrotasks();
    vi.mocked(execAsync).mockClear();
    paneGeometryMock
      .mockReset()
      .mockResolvedValueOnce('80x30:@7:80x30:1')
      .mockResolvedValue('100x30:@7:100x30:1');

    const rehydrated = await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      undefined,
      { cols: 100, rows: 30 },
      false,
      902,
      100,
    );

    expect(rehydrated).toEqual(expect.objectContaining({
      cols: 100,
      mode: 'capture',
      rows: 30,
      streamId: 902,
    }));
    expect(execAsync).toHaveBeenCalledWith(
      "tmux resize-window -t '%1' -x 100 -y 30",
      { silent: true },
    );
    const resizeOrder = vi.mocked(execAsync).mock.invocationCallOrder.find((_, index) => (
      String(vi.mocked(execAsync).mock.calls[index]?.[0]).includes('resize-window')
    ));
    const verificationOrder = paneGeometryMock.mock.invocationCallOrder.at(-1);
    expect(resizeOrder).toBeDefined();
    expect(verificationOrder).toBeDefined();
    expect(resizeOrder!).toBeLessThan(verificationOrder!);

    manager.destroyAll();
  });

  it('scrolls pty panes line-wise with one chained tmux command and cancels before input resumes', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    const dimensions = await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    expect(dimensions).toEqual(expect.objectContaining({ cols: 100, rows: 30, streamId: 901, windowId: '@7' }));
    expect(ptyServiceSpies.attach).toHaveBeenCalledTimes(1);
    manager.unlockStdin('p1');
    vi.mocked(execFileAsync).mockClear();
    paneStateMock.mockClear();

    // Act
    await manager.scroll('p1', 'up', 12);
    await manager.write('p1', 'hello');

    // Assert: one execFileAsync for the scroll (no paneStateMock for alternate_on)
    expect(paneStateMock).not.toHaveBeenCalledWith('%1', '#{alternate_on}');
    expect(execFileAsync).toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['if-shell', '-F', '-t', '%1', '#{alternate_on}']),
    );
    const scrollCall = vi.mocked(execFileAsync).mock.calls.find(
      ([cmd, args]) => cmd === 'tmux' && (args as string[]).includes('if-shell'),
    );
    expect(scrollCall).toBeDefined();
    const args = scrollCall![1] as string[];
    const normalCmd = args[args.length - 1];
    expect(normalCmd).toContain('copy-mode -e');
    expect(normalCmd).toContain('scroll-up');
    expect(normalCmd).toContain('12');
    expect(execAsync).toHaveBeenCalledWith(
      "tmux copy-mode -q -t '%1'",
      { timeout: 1500 },
    );
    expect(handle.write).toHaveBeenCalledWith('hello');

    manager.destroyAll();
  });

  it.each([
    ['', '(empty)'],
    ['UNKNOWN', 'UNKNOWN'],
    ['ALT\nNORMAL', 'ALT\nNORMAL'],
  ])('rejects an invalid pty scroll ownership marker %j', async (stdout, expectedMarker) => {
    // Arrange
    const { window } = makeFakeWindow();
    const handle = { dispose: vi.fn(), resize: vi.fn(), write: vi.fn() };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    manager.unlockStdin('p1');
    vi.mocked(execFileAsync).mockResolvedValue(stdout);

    // Act
    const result = await manager.scroll('p1', 'up', 1);

    // Assert
    expect(result).toEqual({
      error: `unexpected scroll marker: ${expectedMarker}`,
      success: false,
    });

    manager.destroyAll();
  });

  it('does not let wheel input bypass the stdin lock during agent startup', async () => {
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    vi.mocked(execAsync).mockClear();
    paneStateMock.mockClear();

    await manager.scroll('p1', 'up', 5);

    expect(execAsync).not.toHaveBeenCalled();
    expect(execFileAsync).not.toHaveBeenCalled();
    expect(paneStateMock).not.toHaveBeenCalled();
    expect(handle.write).not.toHaveBeenCalled();

    manager.unlockStdin('p1');
    await manager.scroll('p1', 'up', 5);
    expect(execFileAsync).toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['if-shell', '-F', '-t', '%1', '#{alternate_on}']),
    );

    manager.destroyAll();
  });

  it('authoritatively cancels untracked copy-mode before completing a managed pty command', async () => {
    const { window } = makeFakeWindow();
    const events: string[] = [];
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    manager.unlockStdin('p1');
    handle.write.mockClear();
    vi.mocked(execAsync).mockClear().mockImplementation(async (command: string) => {
      if (command === "tmux copy-mode -q -t '%1'") {
        events.push('copy-mode-cancelled');
      }
      return '0';
    });
    vi.mocked(submitTerminalCommand).mockImplementation(async () => {
      events.push('command-submitted');
    });

    await expect(manager.submitCommand('p1', '%1', 'printf ready')).resolves.toBe(true);

    expect(execAsync).toHaveBeenCalledWith("tmux copy-mode -q -t '%1'", { timeout: 1500 });
    expect(handle.write).not.toHaveBeenCalled();
    expect(submitTerminalCommand).toHaveBeenCalledOnce();
    expect(submitTerminalCommand).toHaveBeenCalledWith('%1', 'printf ready');
    expect(events).toEqual(['copy-mode-cancelled', 'command-submitted']);

    manager.destroyAll();
  });

  it('rejects command submission while stdin is locked without buffering stale input', async () => {
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);

    await expect(manager.submitCommand('p1', '%1', 'must-not-run')).rejects.toThrow(/input is locked/i);
    expect(handle.write).not.toHaveBeenCalled();

    manager.unlockStdin('p1');
    await Promise.resolve();
    expect(handle.write).not.toHaveBeenCalled();

    manager.destroyAll();
  });

  it('authoritatively cancels copy-mode before a managed classic command and reports unmanaged panes', async () => {
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'classic' });
    await manager.attach('p1', 'muxbase-test', '%1');
    manager.unlockStdin('p1');
    vi.mocked(execAsync).mockClear();
    vi.mocked(submitTerminalCommand).mockClear();

    await expect(manager.submitCommand('p1', '%1', 'echo classic')).resolves.toBe(true);
    await expect(manager.submitCommand('missing', '%404', 'echo missing')).resolves.toBe(false);

    expect(execAsync).toHaveBeenCalledWith("tmux copy-mode -q -t '%1'", { timeout: 1500 });
    expect(submitTerminalCommand).toHaveBeenCalledOnce();
    expect(submitTerminalCommand).toHaveBeenCalledWith('%1', 'echo classic');

    manager.destroyAll();
  });

  it('keeps classic typing and resize work behind an in-flight command submission', async () => {
    const { window } = makeFakeWindow();
    const submissionGate = createDeferred<void>();
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'classic' });
    await manager.attach('p1', 'muxbase-test', '%1');
    manager.unlockStdin('p1');
    vi.mocked(execAsync).mockClear().mockResolvedValue('0');
    vi.mocked(writeTerminalInput).mockClear();
    mockVerifiedPaneResize('80x24:@1:80x24:1', '100x30:@1:100x30:1');
    vi.mocked(submitTerminalCommand).mockImplementation(async () => submissionGate.promise);

    const submission = manager.submitCommand('p1', '%1', 'echo ordered');
    await vi.waitFor(() => expect(submitTerminalCommand).toHaveBeenCalledWith('%1', 'echo ordered'));
    const typing = manager.write('p1', 'x');
    const resize = manager.resize('p1', 100, 30);
    await Promise.resolve();

    expect(writeTerminalInput).not.toHaveBeenCalled();
    expect(vi.mocked(execAsync).mock.calls.some(([command]) => (
      String(command).includes('resize-window') || String(command).includes('resize-pane')
    ))).toBe(false);

    submissionGate.resolve(undefined);
    await Promise.all([submission, typing, resize]);
    expect(writeTerminalInput).toHaveBeenCalledWith('%1', 'x');
    expect(vi.mocked(execAsync).mock.calls.some(([command]) => (
      String(command).includes('resize-window') && String(command).includes('-x 100')
    ))).toBe(true);

    manager.destroyAll();
  });

  it('declines a managed command when the logical stream is bound to another tmux pane', async () => {
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    manager.unlockStdin('p1');
    handle.write.mockClear();
    vi.mocked(execAsync).mockClear();

    await expect(manager.submitCommand('p1', '%2', 'must-target-new-pane')).resolves.toBe(false);

    expect(execAsync).not.toHaveBeenCalled();
    expect(handle.write).not.toHaveBeenCalled();

    manager.destroyAll();
  });

  it('rejects an accepted managed command if its stream detaches before delivery', async () => {
    const { window } = makeFakeWindow();
    const activeScroll = createDeferred<string>();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    manager.unlockStdin('p1');
    handle.write.mockClear();
    vi.mocked(execFileAsync).mockImplementation(async (cmd: string, args: readonly string[]) => {
      if (cmd === 'tmux' && (args as string[]).includes('if-shell')) return activeScroll.promise;
      return 'NORMAL';
    });

    const scrolling = manager.scroll('p1', 'up', 5);
    await vi.waitFor(() => expect(execFileAsync).toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['if-shell', '-F', '-t', '%1', '#{alternate_on}']),
    ));
    const submission = manager.submitCommand('p1', '%1', 'must-not-disappear');
    manager.detach('p1');
    activeScroll.resolve('0');
    await scrolling;

    await expect(submission).rejects.toThrow(/target changed before delivery/i);
    expect(handle.write).not.toHaveBeenCalled();
  });

  it('does not report command completion when acknowledged tmux delivery rejects', async () => {
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    manager.unlockStdin('p1');
    vi.mocked(submitTerminalCommand).mockRejectedValueOnce(new Error('tmux target disappeared'));

    await expect(manager.submitCommand('p1', '%1', 'must-be-observable'))
      .rejects.toThrow('tmux target disappeared');
    expect(handle.write).not.toHaveBeenCalled();

    manager.destroyAll();
  });

  it('serializes a pty resize while preserving copy-mode until input resumes', async () => {
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    manager.unlockStdin('p1');
    await manager.scroll('p1', 'up', 5);
    vi.mocked(execAsync).mockClear().mockResolvedValue('0');
    vi.mocked(execFileAsync).mockClear().mockResolvedValue('NORMAL');
    paneGeometryMock.mockReset()
      .mockResolvedValueOnce('100x30:@7:100x30:1')
      .mockResolvedValue('120x36:@7:120x36:1');

    await manager.resize('p1', 120, 36);
    await manager.scroll('p1', 'down', 2);
    await manager.write('p1', 'live-input');

    const execAsyncCmds = vi.mocked(execAsync).mock.calls.map(([command]) => String(command));
    const resizeIndex = execAsyncCmds.indexOf("tmux resize-window -t '%1' -x 120 -y 36");
    const copyModeExitIndex = execAsyncCmds.indexOf("tmux copy-mode -q -t '%1'");
    expect(resizeIndex).toBeGreaterThanOrEqual(0);
    expect(copyModeExitIndex).toBeGreaterThan(resizeIndex);
    expect(execAsyncCmds.some((cmd) => cmd.includes('#{scroll_position}'))).toBe(false);
    expect(execAsyncCmds.some((cmd) => cmd.includes(' scroll-up'))).toBe(false);
    const scrollDownCall = vi.mocked(execFileAsync).mock.calls.find(
      ([cmd, args]) => cmd === 'tmux' && (args as string[]).includes('if-shell'),
    );
    expect(scrollDownCall).toBeDefined();
    const scrollDownArgs = scrollDownCall![1] as string[];
    const normalDownCmd = scrollDownArgs[scrollDownArgs.length - 1];
    expect(normalDownCmd).toContain('scroll-down');
    expect(execAsyncCmds.filter((cmd) => cmd === "tmux copy-mode -q -t '%1'")).toHaveLength(1);
    expect(handle.resize).toHaveBeenCalledWith(120, 36);
    expect(handle.write).toHaveBeenCalledWith('live-input');

    manager.destroyAll();
  });

  it('waits for an in-flight pty scroll before resizing the shared tmux pane', async () => {
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    manager.unlockStdin('p1');

    const guardedScroll = createDeferred<string>();
    vi.mocked(execFileAsync).mockImplementation(async (cmd: string, args: readonly string[]) => {
      if (cmd === 'tmux' && (args as string[]).includes('if-shell')) return guardedScroll.promise;
      return 'NORMAL';
    });
    const scrolling = manager.scroll('p1', 'up', 5);
    await vi.waitFor(() => expect(execFileAsync).toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['if-shell', '-F', '-t', '%1', '#{alternate_on}']),
    ));

    paneGeometryMock.mockReset()
      .mockResolvedValueOnce('100x30:@7:100x30:1')
      .mockResolvedValue('120x36:@7:120x36:1');
    const resizing = manager.resize('p1', 120, 36);
    await Promise.resolve();

    expect(execAsync).not.toHaveBeenCalledWith(
      "tmux resize-window -t '%1' -x 120 -y 36",
      { silent: true },
    );
    expect(handle.resize).not.toHaveBeenCalled();

    guardedScroll.resolve('NORMAL');
    await Promise.all([scrolling, resizing]);

    const resizeIndex = vi.mocked(execAsync).mock.calls
      .map(([command]) => String(command))
      .indexOf("tmux resize-window -t '%1' -x 120 -y 36");
    expect(resizeIndex).toBeGreaterThanOrEqual(0);
    expect(handle.resize).toHaveBeenCalledWith(120, 36);

    manager.destroyAll();
  });

  it('never applies a stale pty resize to a replacement stream', async () => {
    const { window } = makeFakeWindow();
    const oldHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    const replacementHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(oldHandle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);

    const oldResizeVerification = createDeferred<string>();
    paneGeometryMock.mockReset()
      .mockImplementationOnce(() => oldResizeVerification.promise)
      .mockResolvedValue('120x36:@7:120x36:1');
    const staleResize = manager.resize('p1', 120, 36);
    await vi.waitFor(() => expect(paneGeometryMock).toHaveBeenCalledTimes(1));

    manager.detach('p1');
    ptyServiceSpies.attach.mockResolvedValue(replacementHandle);
    const replacementAttach = manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      undefined,
      { cols: 120, rows: 36 },
      true,
      902,
    );
    await Promise.resolve();
    expect(paneGeometryMock).toHaveBeenCalledTimes(1);

    oldResizeVerification.resolve('120x36:@7:120x36:1');
    await Promise.all([replacementAttach, staleResize]);

    expect(paneGeometryMock).toHaveBeenCalledTimes(2);
    expect(oldHandle.resize).not.toHaveBeenCalled();
    expect(replacementHandle.resize).not.toHaveBeenCalled();

    manager.destroyAll();
  });

  it('lets a replacement classic attach become the final geometry owner after a stale resize', async () => {
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'classic' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, undefined, false, 901);

    const staleAlternateCheck = createDeferred<string>();
    let alternateCheckBlocked = true;
    vi.mocked(execAsync).mockClear().mockResolvedValue('0');
    paneStateMock.mockImplementation(async (_tmuxPaneId: string, format: string) => {
      if (alternateCheckBlocked && format.includes('alternate_on')) {
        alternateCheckBlocked = false;
        return staleAlternateCheck.promise;
      }
      return '0';
    });
    const staleResize = manager.resize('p1', 120, 36);
    await vi.waitFor(() => expect(alternateCheckBlocked).toBe(false));

    manager.detach('p1');
    mockVerifiedPaneResize('80x24:@1:80x24:1', '90x28:@1:90x28:1');
    const replacementAttach = manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      undefined,
      { cols: 90, rows: 28 },
      false,
      902,
    );
    await Promise.resolve();

    // The replacement must wait for the old interaction transaction before
    // reading or changing the shared tmux pane geometry.
    expect(paneGeometryMock).not.toHaveBeenCalled();

    staleAlternateCheck.resolve('0');
    const [replacement] = await Promise.all([replacementAttach, staleResize]);
    expect(replacement).toEqual(expect.objectContaining({ cols: 90, rows: 28, streamId: 902 }));
    const commands = vi.mocked(execAsync).mock.calls.map(([command]) => String(command));
    expect(commands.some((command) => command.includes('resize-window') && command.includes('-x 120')))
      .toBe(false);
    expect(commands.some((command) => command.includes('resize-window') && command.includes('-x 90')))
      .toBe(true);

    manager.destroyAll();
  });

  it('cleans copy-mode entered by a scroll that loses stream ownership', async () => {
    const { window } = makeFakeWindow();
    const oldHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    const replacementHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(oldHandle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    manager.unlockStdin('p1');
    vi.mocked(execAsync).mockClear();

    const guardedScroll = createDeferred<string>();
    vi.mocked(execFileAsync).mockImplementation(async (cmd: string, args: readonly string[]) => {
      if (cmd === 'tmux' && (args as string[]).includes('if-shell')) return guardedScroll.promise;
      return 'NORMAL';
    });
    const staleScroll = manager.scroll('p1', 'up', 5);
    await vi.waitFor(() => expect(execFileAsync).toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['if-shell', '-F', '-t', '%1', '#{alternate_on}']),
    ));

    manager.detach('p1');
    guardedScroll.resolve('NORMAL');
    await staleScroll;

    expect(execAsync).toHaveBeenCalledWith("tmux copy-mode -q -t '%1'", { timeout: 1500 });
    const staleCleanupCalls = () => vi.mocked(execAsync).mock.calls.filter(
      ([command]) => command === "tmux copy-mode -q -t '%1'",
    );
    expect(staleCleanupCalls()).toHaveLength(1);

    ptyServiceSpies.attach.mockResolvedValue(replacementHandle);
    await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      undefined,
      { cols: 100, rows: 30 },
      true,
      902,
    );
    // A fresh PTY attach also performs its own authoritative source-pane
    // cleanup as a lifecycle barrier.
    expect(staleCleanupCalls()).toHaveLength(2);
    manager.unlockStdin('p1');
    await manager.submitCommand('p1', '%1', 'echo replacement');
    expect(replacementHandle.write).not.toHaveBeenCalled();
    expect(submitTerminalCommand).toHaveBeenCalledWith('%1', 'echo replacement');
    // Command submission performs its own authoritative cancellation even
    // when the local copy-mode tracker believes the pane is already live.
    expect(staleCleanupCalls()).toHaveLength(3);

    manager.destroyAll();
  });

  it('uses OpenCode line controls only when the live tmux pane is on the alternate screen', async () => {
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    manager.unlockStdin('p1');
    let alternateOn = false;
    vi.mocked(execFileAsync).mockImplementation(async (cmd: string, args: readonly string[]) => {
      if (cmd === 'tmux' && (args as string[]).includes('if-shell')) {
        return alternateOn ? 'ALT' : 'NORMAL';
      }
      return '';
    });

    // normal screen up: enters copy-mode (NORMAL branch)
    await manager.scroll('p1', 'up', 4, 'opencode');
    expect(handle.write).not.toHaveBeenCalled();

    // switch to alternate screen
    alternateOn = true;
    await manager.scroll('p1', 'up', 3, 'opencode');
    await manager.scroll('p1', 'down', 2, 'opencode');

    // copy-mode exit: happens because first scroll tracked copy-mode, then ALT branch clears it
    expect(execAsync).toHaveBeenCalledWith("tmux copy-mode -q -t '%1'", { timeout: 1500 });
    expect(handle.write).not.toHaveBeenCalled();

    const scrollCalls = vi.mocked(execFileAsync).mock.calls.filter(
      ([cmd, args]) => cmd === 'tmux' && (args as string[]).includes('if-shell'),
    );
    // 3 scroll calls total: normal-up, alt-up, alt-down
    expect(scrollCalls).toHaveLength(3);

    const altUpArgs = scrollCalls[1][1] as string[];
    const altUpCmd = altUpArgs[5]; // altCommand
    expect(altUpCmd).toContain('ALT');
    expect(altUpCmd).toContain('send-keys');
    expect(altUpCmd).toContain('-l');
    expect(altUpCmd).toContain('\x1b\x19'.repeat(3));

    const altDownArgs = scrollCalls[2][1] as string[];
    const altDownCmd = altDownArgs[5]; // altCommand
    expect(altDownCmd).toContain('ALT');
    expect(altDownCmd).toContain('send-keys');
    expect(altDownCmd).toContain('-l');
    expect(altDownCmd).toContain('\x1b\x05'.repeat(2));

    // No bare arrow-key sends
    const allAltCmds = scrollCalls.map(([, args]) => (args as string[])[5]);
    expect(allAltCmds.every((cmd) => !cmd.includes(' -N 3 Up'))).toBe(true);
    expect(allAltCmds.every((cmd) => !cmd.includes(' -N 2 Down'))).toBe(true);

    manager.destroyAll();
  });

  it('preempts queued pty scrolls and cancels copy-mode before writing user input', async () => {
    // Arrange: hold one tmux scroll open, then issue another wheel event while
    // it is active. User input must invalidate that queued scroll instead of
    // allowing it to re-enter copy-mode after the keystroke is written.
    const { window } = makeFakeWindow();
    const events: string[] = [];
    const activeScroll = createDeferred<void>();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(() => events.push('input-written')),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    manager.unlockStdin('p1');

    vi.mocked(execAsync).mockImplementation(async (command: string) => {
      if (String(command).includes("copy-mode -q -t '%1'")) events.push('copy-mode-cancelled');
      return '0';
    });

    let guardedScrollCalls = 0;
    vi.mocked(execFileAsync).mockImplementation(async (cmd: string, args: readonly string[]) => {
      if (cmd === 'tmux' && (args as string[]).includes('if-shell')) {
        const normalCmd = (args as string[]).at(-1) ?? '';
        if (normalCmd.includes('scroll-up')) {
          guardedScrollCalls += 1;
          if (guardedScrollCalls === 1) {
            events.push('active-scroll-started');
            await activeScroll.promise;
            events.push('active-scroll-completed');
          } else {
            events.push('queued-scroll-ran');
          }
        }
        return 'NORMAL';
      }
      return '';
    });

    // Act
    const activeScrollPromise = manager.scroll('p1', 'up', 8);
    await vi.waitFor(() => expect(events).toContain('active-scroll-started'));
    const queuedScrollPromise = manager.scroll('p1', 'up', 4);
    await flushMicrotasks();
    const writePromise = manager.write('p1', 'hello');
    await flushMicrotasks();

    // Assert: input waits for the in-flight operation; the later wheel event
    // is discarded, then copy-mode is cancelled before bytes reach the PTY.
    expect(handle.write).not.toHaveBeenCalled();
    expect(guardedScrollCalls).toBe(1);

    activeScroll.resolve(undefined);
    await Promise.all([activeScrollPromise, queuedScrollPromise, writePromise]);

    expect(events).toEqual([
      'active-scroll-started',
      'active-scroll-completed',
      'copy-mode-cancelled',
      'input-written',
    ]);
    expect(handle.write).toHaveBeenCalledWith('hello');

    manager.destroyAll();
  });

  it('preserves every input chunk while an in-flight pty scroll blocks delivery', async () => {
    const { window } = makeFakeWindow();
    const activeScroll = createDeferred<void>();
    let scrollStarted = false;
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    manager.unlockStdin('p1');

    vi.mocked(execFileAsync).mockImplementation(async (cmd: string, args: readonly string[]) => {
      if (cmd === 'tmux' && (args as string[]).includes('if-shell')) {
        const normalCmd = (args as string[]).at(-1) ?? '';
        if (normalCmd.includes('scroll-up')) {
          scrollStarted = true;
          await activeScroll.promise;
        }
        return 'NORMAL';
      }
      return '';
    });

    const scrollPromise = manager.scroll('p1', 'up', 8);
    await vi.waitFor(() => expect(scrollStarted).toBe(true));
    const chunks = Array.from({ length: 96 }, (_, index) => `k${String(index).padStart(3, '0')}|`);
    const writePromises = chunks.map((chunk) => manager.write('p1', chunk));
    await flushMicrotasks();
    expect(handle.write).not.toHaveBeenCalled();

    activeScroll.resolve(undefined);
    await Promise.all([scrollPromise, ...writePromises]);

    const delivered = handle.write.mock.calls.map(([data]) => data).join('');
    expect(delivered).toBe(chunks.join(''));

    manager.destroyAll();
  });

  it('preserves rapid input order while copy-mode cancellation is in flight', async () => {
    const { window } = makeFakeWindow();
    const cancelCopyMode = createDeferred<void>();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    manager.unlockStdin('p1');
    await manager.scroll('p1', 'up', 3);

    vi.mocked(execAsync).mockClear().mockImplementation(async (command: string) => {
      if (command.includes("copy-mode -q -t '%1'")) {
        await cancelCopyMode.promise;
      }
      return '0';
    });

    const firstWrite = manager.write('p1', 'a');
    await vi.waitFor(() => expect(execAsync).toHaveBeenCalledWith(
      "tmux copy-mode -q -t '%1'",
      { timeout: 1500 },
    ));
    const secondWrite = manager.write('p1', 'b');
    await flushMicrotasks();

    expect(handle.write).not.toHaveBeenCalled();

    cancelCopyMode.resolve(undefined);
    await Promise.all([firstWrite, secondWrite]);

    expect(handle.write.mock.calls.map(([data]) => data).join('')).toBe('ab');
    expect(vi.mocked(execAsync).mock.calls.filter(([command]) => (
      command.includes("copy-mode -q -t '%1'")
    ))).toHaveLength(1);

    manager.destroyAll();
  });

  it('keeps input typed after a command behind that command while an older pty drain is active', async () => {
    const { window } = makeFakeWindow();
    const cancelCopyMode = createDeferred<void>();
    const delivered: string[] = [];
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn((data: string) => delivered.push(`pty:${data}`)),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    manager.unlockStdin('p1');
    await manager.scroll('p1', 'up', 3);
    handle.write.mockClear();
    delivered.length = 0;

    let cancelAttempts = 0;
    vi.mocked(execAsync).mockClear().mockImplementation(async (command: string) => {
      if (command.includes("copy-mode -q -t '%1'")) {
        cancelAttempts += 1;
        if (cancelAttempts === 1) await cancelCopyMode.promise;
      }
      return '0';
    });
    vi.mocked(submitTerminalCommand).mockImplementation(async (_paneId, data) => {
      delivered.push(`command:${data}`);
    });

    const beforeCommand = manager.write('p1', 'a');
    await vi.waitFor(() => expect(cancelAttempts).toBe(1));
    const command = manager.submitCommand('p1', '%1', 'cmd');
    const afterCommand = manager.write('p1', 'b');
    cancelCopyMode.resolve(undefined);

    await Promise.all([beforeCommand, command, afterCommand]);
    await vi.waitFor(() => expect(delivered).toHaveLength(3));
    expect(delivered).toEqual(['pty:a', 'command:cmd', 'pty:b']);

    manager.destroyAll();
  });

  it('never writes through a disposed pty handle after copy-mode cancellation', async () => {
    const { window } = makeFakeWindow();
    const cancelCopyMode = createDeferred<void>();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    manager.unlockStdin('p1');
    await manager.scroll('p1', 'up', 3);

    vi.mocked(execAsync).mockClear().mockImplementation(async (command: string) => {
      if (command.includes("send-keys -t '%1' -X cancel") || command.includes("copy-mode -q -t '%1'")) {
        await cancelCopyMode.promise;
      }
      return '0';
    });

    const writePromise = manager.write('p1', 'x');
    await vi.waitFor(() => expect(vi.mocked(execAsync).mock.calls.some(([command]) => (
      command.includes("send-keys -t '%1' -X cancel") || command.includes("copy-mode -q -t '%1'")
    ))).toBe(true));
    manager.detach('p1');
    cancelCopyMode.resolve(undefined);
    await writePromise;

    expect(handle.dispose).toHaveBeenCalledTimes(1);
    expect(handle.write).not.toHaveBeenCalled();

    manager.destroyAll();
  });

  it('preserves pty input for retry when copy-mode cancellation fails', async () => {
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    manager.unlockStdin('p1');
    await manager.scroll('p1', 'up', 3);

    let cancelAttempts = 0;
    vi.mocked(execAsync).mockImplementation(async (command: string) => {
      if (command.includes("send-keys -t '%1' -X cancel") || command.includes("copy-mode -q -t '%1'")) {
        cancelAttempts += 1;
        if (cancelAttempts === 1) throw new Error('temporary tmux control failure');
      }
      return '0';
    });

    await manager.write('p1', 'x');
    expect(handle.write).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(handle.write).toHaveBeenCalledWith('x'), { timeout: 500 });
    expect(cancelAttempts).toBe(2);

    manager.destroyAll();
  });

  it('coalesces concurrent pty drain attempts while copy-mode cancellation is unavailable', async () => {
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    manager.unlockStdin('p1');
    await manager.scroll('p1', 'up', 3);

    let cancellationAvailable = false;
    let cancelAttempts = 0;
    vi.mocked(execAsync).mockImplementation(async (command: string) => {
      if (command.includes("copy-mode -q -t '%1'")) {
        cancelAttempts += 1;
        if (!cancellationAvailable) throw new Error('tmux control temporarily unavailable');
      }
      return '0';
    });

    const chunks = Array.from({ length: 96 }, (_, index) => `k${String(index).padStart(3, '0')}|`);
    await Promise.all(chunks.map((chunk) => manager.write('p1', chunk)));

    expect(cancelAttempts).toBe(1);
    expect(handle.write).not.toHaveBeenCalled();

    cancellationAvailable = true;
    await vi.waitFor(() => expect(handle.write).toHaveBeenCalled(), { timeout: 500 });
    expect(cancelAttempts).toBe(2);
    expect(handle.write.mock.calls.map(([data]) => data).join('')).toBe(chunks.join(''));

    manager.destroyAll();
  });

  it('orders pty reattach cleanup after an in-flight scroll before accepting input', async () => {
    const { window } = makeFakeWindow();
    const activeScroll = createDeferred<void>();
    const events: string[] = [];
    let sourcePaneInCopyMode = false;
    const firstHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    const secondHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(() => {
        events.push(sourcePaneInCopyMode ? 'input-swallowed' : 'input-delivered');
      }),
    };
    ptyServiceSpies.attach
      .mockResolvedValueOnce(firstHandle)
      .mockResolvedValueOnce(secondHandle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    manager.unlockStdin('p1');
    await flushMicrotasks();

    vi.mocked(execFileAsync).mockImplementation(async (cmd: string, args: readonly string[]) => {
      if (cmd === 'tmux' && (args as string[]).includes('if-shell')) {
        const normalCmd = (args as string[]).at(-1) ?? '';
        if (normalCmd.includes('scroll-up')) {
          events.push('scroll-started');
          await activeScroll.promise;
          sourcePaneInCopyMode = true;
          events.push('scroll-completed');
          return 'NORMAL';
        }
        return 'NORMAL';
      }
      return '';
    });
    vi.mocked(execAsync).mockImplementation(async (command: string) => {
      if (command.includes("copy-mode -q -t '%1'")) {
        sourcePaneInCopyMode = false;
        events.push('reattach-copy-mode-cleanup');
      }
      if (command.includes("send-keys -t '%1' -X cancel")) {
        sourcePaneInCopyMode = false;
        events.push('input-copy-mode-cancel');
      }
      return '0';
    });

    const scrollPromise = manager.scroll('p1', 'up', 5);
    await vi.waitFor(() => expect(events).toContain('scroll-started'));
    const reattachPromise = manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      undefined,
      { cols: 100, rows: 30 },
      true,
      902,
    );
    await flushMicrotasks();

    activeScroll.resolve(undefined);
    await Promise.all([scrollPromise, reattachPromise]);
    await manager.write('p1', 'x');

    expect(events.indexOf('scroll-completed')).toBeLessThan(events.indexOf('reattach-copy-mode-cleanup'));
    expect(events.at(-1)).toBe('input-delivered');
    expect(firstHandle.dispose).toHaveBeenCalledTimes(1);
    expect(secondHandle.write).toHaveBeenCalledWith('x');

    manager.destroyAll();
  });

  it('scrolls pty copy-mode down line-wise only after an up-scroll opened copy-mode', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    manager.unlockStdin('p1');

    // Act
    await manager.scroll('p1', 'down', 4);
    const downBeforeUp = vi.mocked(execFileAsync).mock.calls
      .filter(([cmd, args]) => cmd === 'tmux' && (args as string[]).includes('if-shell'))
      .some(([, args]) => ((args as string[]).at(-1) ?? '').includes('scroll-down'));
    await manager.scroll('p1', 'up', 5);
    await manager.scroll('p1', 'down', 2);

    // Assert
    expect(downBeforeUp).toBe(false);
    const scrollDownCall = vi.mocked(execFileAsync).mock.calls.find(
      ([cmd, args]) => cmd === 'tmux'
        && (args as string[]).includes('if-shell')
        && ((args as string[]).at(-1) ?? '').includes('scroll-down')
        && ((args as string[]).at(-1) ?? '').includes('-N 2'),
    );
    expect(scrollDownCall).toBeDefined();

    manager.destroyAll();
  });

  it('drops stale pty copy-mode state when scroll-down fails after copy-mode auto-exited', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    manager.unlockStdin('p1');
    await manager.scroll('p1', 'up', 3);
    vi.mocked(execAsync).mockClear();
    vi.mocked(execFileAsync).mockImplementation(async (cmd: string, args: readonly string[]) => {
      if (cmd === 'tmux' && (args as string[]).includes('if-shell')) {
        const normalCmd = (args as string[]).at(-1) ?? '';
        if (normalCmd.includes('scroll-down')) throw new Error('not in a mode');
        return 'NORMAL';
      }
      return '';
    });

    // Act
    await manager.scroll('p1', 'down', 2);
    manager.unlockStdin('p1');
    await manager.write('p1', 'hello');

    // Assert
    expect(execAsync).not.toHaveBeenCalledWith(
      "tmux copy-mode -q -t '%1'",
      { timeout: 1500 },
    );
    expect(handle.write).toHaveBeenCalledWith('hello');

    manager.destroyAll();
  });

  it('returns success when scroll-down hits "not in a mode" after copy-mode auto-exited at bottom', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const handle = { dispose: vi.fn(), resize: vi.fn(), write: vi.fn() };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    manager.unlockStdin('p1');
    await manager.scroll('p1', 'up', 3);
    vi.mocked(execFileAsync).mockImplementation(async (cmd: string, args: readonly string[]) => {
      if (cmd === 'tmux' && (args as string[]).includes('if-shell')) {
        const normalCmd = (args as string[]).at(-1) ?? '';
        if (normalCmd.includes('scroll-down')) throw new Error('not in a mode');
        return 'NORMAL';
      }
      return '';
    });

    // Act
    const result = await manager.scroll('p1', 'down', 2);

    // Assert — natural copy-mode exit must not be surfaced as a failure
    expect(result).toEqual({ success: true });

    manager.destroyAll();
  });

  it('emits static scroll markers without the redundant -l literal flag', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const handle = { dispose: vi.fn(), resize: vi.fn(), write: vi.fn() };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    manager.unlockStdin('p1');
    vi.mocked(execFileAsync).mockClear();

    // Act
    await manager.scroll('p1', 'up', 4);

    // Assert
    const scrollCall = vi.mocked(execFileAsync).mock.calls.find(
      ([cmd, args]) => cmd === 'tmux' && (args as string[]).includes('if-shell'),
    );
    expect(scrollCall).toBeDefined();
    const args = scrollCall![1] as string[];
    const altCmd = args[args.length - 2];
    const normalCmd = args[args.length - 1];
    expect(altCmd).toContain('display-message -p ALT');
    expect(altCmd).not.toContain('display-message -p -l ALT');
    expect(normalCmd).toContain('display-message -p NORMAL');
    expect(normalCmd).not.toContain('display-message -p -l NORMAL');

    manager.destroyAll();
  });

  it('fails closed when tmux returns an unexpected scroll ownership marker', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const handle = { dispose: vi.fn(), resize: vi.fn(), write: vi.fn() };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    manager.unlockStdin('p1');
    vi.mocked(execFileAsync).mockImplementation(async (cmd: string, args: readonly string[]) => {
      if (cmd === 'tmux' && (args as string[]).includes('if-shell')) return 'GARBAGE';
      return '';
    });

    // Act
    const result = await manager.scroll('p1', 'up', 4);

    // Assert
    expect(result.success).toBe(false);
    expect(result.error).toContain('unexpected scroll marker');

    manager.destroyAll();
  });

  it('scrolls alternate-screen pty panes with arrow keys and never freezes them in copy-mode', async () => {
    // Arrange: open copy-mode via a normal-buffer up-scroll, then the pane
    // switches to an alternate-screen TUI.
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    manager.unlockStdin('p1');
    await manager.scroll('p1', 'up', 3);
    vi.mocked(execFileAsync).mockClear();
    vi.mocked(execFileAsync).mockResolvedValue('ALT');

    // Act
    await manager.scroll('p1', 'up', 5);
    await manager.scroll('p1', 'down', 2);

    // Assert: stale copy-mode is exited once, the TUI scrolls itself via
    // arrows, and no copy-mode command targets the alternate screen.
    expect(execAsync).toHaveBeenCalledWith("tmux copy-mode -q -t '%1'", { timeout: 1500 });
    const scrollCalls = vi.mocked(execFileAsync).mock.calls.filter(
      ([cmd, args]) => cmd === 'tmux' && (args as string[]).includes('if-shell'),
    );
    expect(scrollCalls).toHaveLength(2);
    const altUpCmd = (scrollCalls[0][1] as string[])[5];
    expect(altUpCmd).toContain('ALT');
    expect(altUpCmd).toContain('-N 5 Up');
    const altDownCmd = (scrollCalls[1][1] as string[])[5];
    expect(altDownCmd).toContain('ALT');
    expect(altDownCmd).toContain('-N 2 Down');
    const copyModeEntriesWhileAlternate = vi.mocked(execAsync).mock.calls
      .filter(([command]) => String(command).includes('copy-mode -e'));
    expect(copyModeEntriesWhileAlternate).toHaveLength(0);

    manager.destroyAll();
  });

  it('reattaches an existing pty stream without synthetic capture replay', async () => {
    // Arrange
    const { window, send } = makeFakeWindow();
    const firstHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    const secondHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach
      .mockResolvedValueOnce(firstHandle)
      .mockResolvedValueOnce(secondHandle);
    paneGeometryMock
      .mockResolvedValueOnce('100x30:@7:100x30:1')
      .mockResolvedValue('144x37:@7:144x37:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, false, 901);
    send.mockClear();
    vi.mocked(capturePane).mockClear().mockResolvedValue('pty-rehydrate-frame');
    vi.mocked(formatScrollbackInsert).mockClear();
    mockTmuxState('42');

    // Act: the remount requests a different container size; the pane follows
    // it 1:1 like a regular terminal and the client reattaches at that grid.
    const dimensions = await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 144, rows: 37 }, false, 902);
    await flushMicrotasks();

    // Assert
    expect(dimensions).toEqual(expect.objectContaining({ cols: 144, rows: 37, streamId: 902, windowId: '@7' }));
    expect(ptyServiceSpies.attach).toHaveBeenCalledTimes(2);
    expect(ptyServiceSpies.attach.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ cols: 144, rows: 37 }));
    expect(firstHandle.dispose).toHaveBeenCalledTimes(1);
    expect(execAsync).not.toHaveBeenCalledWith(
      "tmux resize-window -t '%1' -x 144 -y 37",
      { silent: true },
    );
    expect(capturePane).not.toHaveBeenCalled();
    expect(formatScrollbackInsert).not.toHaveBeenCalled();
    expect(renderCapturedPaneFrame).not.toHaveBeenCalled();
    expect(send.mock.calls.some((call) => (
      call[1]?.paneId === 'p1'
      && call[1]?.data === '\x1bc'
      && call[1]?.streamId === 902
    ))).toBe(true);

    manager.destroyAll();
    expect(secondHandle.dispose).toHaveBeenCalledTimes(1);
  });

  it('serializes a live resize after the complete pty reattach geometry transaction', async () => {
    const { window } = makeFakeWindow();
    const firstHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    const replacementHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach
      .mockResolvedValueOnce(firstHandle)
      .mockResolvedValueOnce(replacementHandle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);

    const reattachDimensions = createDeferred<string>();
    paneGeometryMock.mockReset()
      .mockImplementationOnce(() => reattachDimensions.promise)
      .mockResolvedValue('120x36:@7:120x36:1');
    const reattaching = manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      undefined,
      undefined,
      true,
      902,
    );
    await vi.waitFor(() => expect(paneGeometryMock).toHaveBeenCalledTimes(1));

    const resizing = manager.resize('p1', 120, 36);
    reattachDimensions.resolve('100x30:@7:100x30:1');
    await Promise.all([reattaching, resizing]);

    expect(ptyServiceSpies.attach).toHaveBeenCalledTimes(2);
    expect(ptyServiceSpies.attach.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      cols: 100,
      rows: 30,
    }));
    expect(firstHandle.resize).not.toHaveBeenCalled();
    expect(replacementHandle.resize).toHaveBeenCalledWith(120, 36);

    manager.destroyAll();
  });

  it('clears fixed columns when an existing stream is attached without a fixed width', async () => {
    const { window } = makeFakeWindow();
    const firstHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    const secondHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach
      .mockResolvedValueOnce(firstHandle)
      .mockResolvedValueOnce(secondHandle);
    paneGeometryMock
      .mockResolvedValueOnce('100x30:@7:100x30:1')
      .mockResolvedValue('80x30:@7:80x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });

    await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      undefined,
      { cols: 100, rows: 30 },
      true,
      901,
      100,
    );
    await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      undefined,
      { cols: 80, rows: 30 },
      true,
      902,
    );

    expect(ptyServiceSpies.attach).toHaveBeenCalledTimes(2);
    expect(ptyServiceSpies.attach.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      cols: 80,
      rows: 30,
    }));

    manager.destroyAll();
  });

  it('buffers input after a pty exit until the replacement handle owns the stream', async () => {
    const { window } = makeFakeWindow();
    const firstHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    const replacementHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach
      .mockResolvedValueOnce(firstHandle)
      .mockResolvedValueOnce(replacementHandle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    manager.unlockStdin('p1');
    const attachOptions = ptyServiceSpies.attach.mock.calls[0]?.[0];

    attachOptions.onExit('p1', { exitCode: 1 });
    await manager.write('p1', 'input-during-recovery');

    expect(firstHandle.dispose).toHaveBeenCalledTimes(1);
    expect(firstHandle.write).not.toHaveBeenCalled();

    await vi.waitFor(
      () => expect(replacementHandle.write).toHaveBeenCalledWith('input-during-recovery'),
      { timeout: 750 },
    );
    expect(ptyServiceSpies.attach).toHaveBeenCalledTimes(2);

    manager.destroyAll();
  });

  it('recovers one pty client exit when the source tmux pane still exists', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const firstHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    const secondHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach
      .mockResolvedValueOnce(firstHandle)
      .mockResolvedValueOnce(secondHandle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    const attachOptions = ptyServiceSpies.attach.mock.calls[0]?.[0];

    // Act
    attachOptions.onExit('p1', { exitCode: 1 });
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Assert
    expect(paneGeometryMock).toHaveBeenCalledWith('%1', expect.stringContaining('pane_width'));
    expect(ptyServiceSpies.attach).toHaveBeenCalledTimes(2);
    expect(firstHandle.dispose).toHaveBeenCalledTimes(1);

    const recoveredAttachOptions = ptyServiceSpies.attach.mock.calls[1]?.[0];
    recoveredAttachOptions.onExit('p1', { exitCode: 1 });
    await flushMicrotasks();

    expect(ptyServiceSpies.attach).toHaveBeenCalledTimes(2);
    expect(secondHandle.dispose).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      'terminal',
      'PTY terminal stream exited again after recovery; detaching',
      expect.objectContaining({
        paneId: 'p1',
        tmuxPaneId: '%1',
      }),
    );

    manager.destroyAll();
    expect(secondHandle.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not replace a healthy pty client installed by a renderer reattach during recovery delay', async () => {
    vi.useFakeTimers();
    let manager: TerminalManager | null = null;
    try {
      const { window } = makeFakeWindow();
      const firstHandle = {
        dispose: vi.fn(),
        resize: vi.fn(),
        write: vi.fn(),
      };
      const rendererReplacement = {
        dispose: vi.fn(),
        resize: vi.fn(),
        write: vi.fn(),
      };
      const redundantRecovery = {
        dispose: vi.fn(),
        resize: vi.fn(),
        write: vi.fn(),
      };
      ptyServiceSpies.attach
        .mockResolvedValueOnce(firstHandle)
        .mockResolvedValueOnce(rendererReplacement)
        .mockResolvedValueOnce(redundantRecovery);
      paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
      manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
      await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
      const firstAttachOptions = ptyServiceSpies.attach.mock.calls[0]?.[0];

      firstAttachOptions.onExit('p1', { exitCode: 1 });
      await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 902);
      expect(ptyServiceSpies.attach).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(300);

      expect(ptyServiceSpies.attach).toHaveBeenCalledTimes(2);
      expect(rendererReplacement.dispose).not.toHaveBeenCalled();
      expect(redundantRecovery.dispose).not.toHaveBeenCalled();
    } finally {
      manager?.destroyAll();
      vi.useRealTimers();
    }
  });

  it('restores and verifies exact fixed geometry before a pty exit-recovery reattach', async () => {
    // Arrange: fixed at 100 cols; the client dies and the live pane has since
    // shrunk to 80. Recovery must restore the source pane before spawning.
    const { window } = makeFakeWindow();
    const firstHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    const secondHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach
      .mockResolvedValueOnce(firstHandle)
      .mockResolvedValueOnce(secondHandle);
    paneGeometryMock
      .mockResolvedValueOnce('100x30:@7:100x30:1')
      .mockResolvedValueOnce('80x30:@7:80x30:1')
      .mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901, 100);
    const attachOptions = ptyServiceSpies.attach.mock.calls[0]?.[0];

    // Act
    attachOptions.onExit('p1', { exitCode: 1 });
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Assert: source geometry is restored and verified before the client is
    // spawned at the same exact size.
    expect(ptyServiceSpies.attach).toHaveBeenCalledTimes(2);
    expect(execAsync).toHaveBeenCalledWith(
      "tmux resize-window -t '%1' -x 100 -y 30",
      { silent: true },
    );
    expect(ptyServiceSpies.attach.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      cols: 100,
      rows: 30,
    }));
    const verificationOrder = paneGeometryMock.mock.invocationCallOrder.at(-1)!;
    const recoveredAttachOrder = ptyServiceSpies.attach.mock.invocationCallOrder[1];
    expect(verificationOrder).toBeLessThan(recoveredAttachOrder);

    manager.destroyAll();
  });

  it('does not spawn a mismatched pty client when recovery geometry cannot be restored', async () => {
    const { window } = makeFakeWindow();
    const firstHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(firstHandle);
    paneGeometryMock
      .mockResolvedValueOnce('100x30:@7:100x30:1')
      .mockResolvedValue('80x30:@7:80x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      undefined,
      { cols: 100, rows: 30 },
      true,
      901,
      100,
    );
    const attachOptions = ptyServiceSpies.attach.mock.calls[0]?.[0];

    attachOptions.onExit('p1', { exitCode: 1 });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(ptyServiceSpies.attach).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      'terminal',
      'PTY source geometry synchronization failed',
      expect.objectContaining({
        paneId: 'p1',
        tmuxPaneId: '%1',
      }),
    );
    manager.unlockStdin('p1');
    await manager.write('p1', 'must-not-reach-mismatched-source');
    expect(writeTerminalInput).not.toHaveBeenCalled();

    manager.destroyAll();
  });

  it('resets the pty exit recovery budget after stable client uptime', async () => {
    // Arrange
    vi.useFakeTimers();
    let manager: TerminalManager | null = null;
    try {
      const { window } = makeFakeWindow();
      const firstHandle = {
        dispose: vi.fn(),
        resize: vi.fn(),
        write: vi.fn(),
      };
      const secondHandle = {
        dispose: vi.fn(),
        resize: vi.fn(),
        write: vi.fn(),
      };
      const thirdHandle = {
        dispose: vi.fn(),
        resize: vi.fn(),
        write: vi.fn(),
      };
      ptyServiceSpies.attach
        .mockResolvedValueOnce(firstHandle)
        .mockResolvedValueOnce(secondHandle)
        .mockResolvedValueOnce(thirdHandle);
      paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
      manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
      await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
      const firstAttachOptions = ptyServiceSpies.attach.mock.calls[0]?.[0];

      // Act: first exit recovers.
      firstAttachOptions.onExit('p1', { exitCode: 1 });
      await vi.advanceTimersByTimeAsync(300);

      // Assert first recovery.
      expect(ptyServiceSpies.attach).toHaveBeenCalledTimes(2);
      expect(firstHandle.dispose).toHaveBeenCalledTimes(1);

      // Act: after stable uptime, a later independent exit gets one fresh recovery.
      await vi.advanceTimersByTimeAsync(30_000);
      const recoveredAttachOptions = ptyServiceSpies.attach.mock.calls[1]?.[0];
      recoveredAttachOptions.onExit('p1', { exitCode: 1 });
      await vi.advanceTimersByTimeAsync(300);

      // Assert
      expect(ptyServiceSpies.attach).toHaveBeenCalledTimes(3);
      expect(secondHandle.dispose).toHaveBeenCalledTimes(1);
      expect(log.debug).toHaveBeenCalledWith(
        'terminal',
        'PTY exit recovery budget reset after stable client uptime',
        expect.objectContaining({
          paneId: 'p1',
          tmuxPaneId: '%1',
        }),
      );
    } finally {
      manager?.destroyAll();
      vi.useRealTimers();
    }
  });

  it('applies a resize that lands during pty exit recovery to the reattached client', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const firstHandle = {
      dispose: vi.fn(),
      resize: vi.fn(() => {
        throw new Error('pty already exited');
      }),
      write: vi.fn(),
    };
    const secondHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach
      .mockResolvedValueOnce(firstHandle)
      .mockResolvedValueOnce(secondHandle);
    paneGeometryMock
      .mockResolvedValueOnce('100x30:@7:100x30:1')
      .mockResolvedValueOnce('100x30:@7:100x30:1')
      .mockResolvedValue('120x36:@7:120x36:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    const attachOptions = ptyServiceSpies.attach.mock.calls[0]?.[0];

    // Act: the resize lands mid-recovery and updates tmux; the recovery
    // reattach reads the live pane geometry and picks it up.
    attachOptions.onExit('p1', { exitCode: 1 });
    await manager.resize('p1', 120, 36);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Assert
    expect(firstHandle.dispose).toHaveBeenCalledTimes(1);
    expect(firstHandle.resize).not.toHaveBeenCalled();
    expect(execAsync).toHaveBeenCalledWith(
      "tmux resize-window -t '%1' -x 120 -y 36",
      { silent: true },
    );
    expect(execAsync).toHaveBeenCalledWith(
      "tmux resize-pane -t '%1' -x 120 -y 36",
      { silent: true },
    );
    expect(ptyServiceSpies.attach).toHaveBeenCalledTimes(2);
    expect(ptyServiceSpies.attach.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      cols: 120,
      rows: 36,
    }));

    manager.destroyAll();
  });

  it('falls back to classic streaming when pty attach fails', async () => {
    // Arrange
    const { window, send } = makeFakeWindow();
    ptyServiceSpies.attach.mockRejectedValue(new Error('native pty unavailable'));
    vi.mocked(existsSync).mockReturnValue(true);
    mockTmuxState('0');
    vi.mocked(capturePane).mockResolvedValue('classic-fallback-frame');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });

    // Act
    const dimensions = await manager.attach('p1', 'muxbase-test', '%1', '/tmp/pane.ansi', undefined, true, 902);
    await flushMicrotasks();

    // Assert
    expect(dimensions).toEqual(expect.objectContaining({ cols: 80, rows: 24, streamId: 902, windowId: '@1' }));
    expect(ptyServiceSpies.attach).toHaveBeenCalledTimes(1);
    expect(transcriptStreamSpies.attach).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'p1', streamId: 902 }),
      '/tmp/pane.ansi',
    );
    expect(capturePane).toHaveBeenCalledWith('%1');
    expect(send.mock.calls.some((call) => (
      call[1]?.paneId === 'p1'
      && call[1]?.data?.includes('[FRAME]classic-fallback-frame')
    ))).toBe(true);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'terminal',
      'PTY attach failed; falling back to classic terminal transport',
      expect.objectContaining({
        error: 'native pty unavailable',
        paneId: 'p1',
        sessionName: 'muxbase-test',
        tmuxPaneId: '%1',
      }),
    );

    manager.destroyAll();
  });

  it('does not let a stale PTY fallback failure detach a replacement stream', async () => {
    const { window } = makeFakeWindow();
    const initialHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    const fallbackAttach = createDeferred<void>();
    ptyServiceSpies.attach
      .mockResolvedValueOnce(initialHandle)
      .mockRejectedValueOnce(new Error('reattach unavailable'));
    transcriptStreamSpies.attach.mockImplementationOnce(() => fallbackAttach.promise);
    vi.mocked(existsSync).mockReturnValue(true);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach(
      'p1',
      'muxbase-test',
      '%old',
      '/tmp/pane.ansi',
      { cols: 100, rows: 30 },
      true,
      901,
    );

    const staleRehydrate = manager.attach(
      'p1',
      'muxbase-test',
      '%old',
      '/tmp/pane.ansi',
      { cols: 100, rows: 30 },
      true,
      902,
    );
    await vi.waitFor(() => expect(transcriptStreamSpies.attach).toHaveBeenCalledTimes(1));

    manager.detach('p1');
    vi.mocked(existsSync).mockReturnValue(false);
    const replacement = await manager.attach(
      'p1',
      '',
      '%new',
      undefined,
      undefined,
      false,
      903,
    );
    expect(replacement.streamId).toBe(903);
    manager.unlockStdin('p1');

    fallbackAttach.reject(new Error('stale fallback failed'));
    await expect(staleRehydrate).rejects.toThrow(/lost ownership/i);
    vi.mocked(writeTerminalInput).mockClear();
    await manager.write('p1', 'replacement-survived');
    expect(writeTerminalInput).toHaveBeenCalledWith('%new', 'replacement-survived');

    manager.destroyAll();
  });

  it('preserves exact fixed geometry when pty attach falls back to transcript transport', async () => {
    const { window } = makeFakeWindow();
    ptyServiceSpies.attach.mockRejectedValue(new Error('native pty unavailable'));
    vi.mocked(existsSync).mockReturnValue(true);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    mockTmuxState('0');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });

    const dimensions = await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      '/tmp/pane.ansi',
      { cols: 140, rows: 30 },
      true,
      902,
      100,
    );

    expect(dimensions).toEqual(expect.objectContaining({
      cols: 100,
      mode: 'transcript',
      rows: 30,
    }));
    expect(transcriptStreamSpies.attach).toHaveBeenCalledWith(
      expect.objectContaining({ cols: 100, fixedCols: 100, paneId: 'p1' }),
      '/tmp/pane.ansi',
    );

    manager.destroyAll();
  });

  it('skips raw transcript replay when tmux has no scrollback and paints the captured frame', async () => {
    // Arrange
    const { window, send } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execAsync).mockResolvedValue('0');
    vi.mocked(capturePane).mockResolvedValue('current-frame');

    // Act
    const dimensions = await manager.attach('p1', 'muxbase-test', '%1', '/tmp/pane.ansi');
    await flushMicrotasks();

    // Assert
    expect(dimensions).toEqual(expect.objectContaining({ cols: 80, rows: 24, windowId: '@1' }));
    expect(transcriptStreamSpies.attach).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'p1' }),
      '/tmp/pane.ansi',
    );
    const payloads = send.mock.calls
      .filter((call) => call[1]?.paneId === 'p1')
      .map((call) => call[1]?.data)
      .join('');
    expect(payloads).toContain('\x1bc');
    expect(payloads).toContain('[FRAME]current-frame');

    manager.destroyAll();
  });

  it('paints transcript frames using tmux alternate-screen state', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    vi.mocked(existsSync).mockReturnValue(true);
    mockTmuxState('0', '1', '0:0:1');
    vi.mocked(capturePane).mockResolvedValue('alternate-frame');

    // Act
    await manager.attach('p1', 'muxbase-test', '%1', '/tmp/pane.ansi');
    await flushMicrotasks();

    // Assert
    expect(capturePane).toHaveBeenCalledWith('%1');
    expect(renderCapturedPaneFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        alternateOn: true,
        content: 'alternate-frame',
      }),
    );

    manager.destroyAll();
  });

  it('resizes tmux before replaying an existing pane during attach', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    vi.mocked(existsSync).mockReturnValue(true);
    paneGeometryMock.mockResolvedValueOnce('220x57:@1:220x57:1');
    vi.mocked(execAsync)
      .mockResolvedValueOnce('0')
      .mockResolvedValueOnce('0')
      .mockResolvedValueOnce('80x24:@1:80x24:1')
      .mockResolvedValueOnce('2')
      .mockResolvedValueOnce('0')
      .mockResolvedValueOnce('0:0:1')
      .mockResolvedValueOnce('2');
    vi.mocked(capturePane).mockResolvedValue('current-frame');

    // Act
    const dimensions = await manager.attach('p1', 'muxbase-test', '%1', '/tmp/pane.ansi', {
      cols: 80,
      rows: 24,
    });
    await flushMicrotasks();

    // Assert
    expect(dimensions).toEqual(expect.objectContaining({ cols: 80, rows: 24, windowId: '@1' }));
    const calls = vi.mocked(execAsync).mock.calls.map((call) => call[0] as string);
    const resizeWindowIndex = calls.findIndex((call) => call.includes('resize-window'));
    expect(resizeWindowIndex).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(execAsync).mock.invocationCallOrder[resizeWindowIndex])
      .toBeLessThan(vi.mocked(capturePane).mock.invocationCallOrder[0]);
    expect(execAsync).toHaveBeenCalledWith(
      "tmux resize-window -t '%1' -x 80 -y 24",
      { silent: true },
    );
    expect(execAsync).toHaveBeenCalledWith(
      "tmux resize-pane -t '%1' -x 80 -y 24",
      { silent: true },
    );

    manager.destroyAll();
  });

  it('rehydrates the renderer when attaching a pane that already has a stream', async () => {
    // Arrange
    const { window, send } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(capturePane).mockResolvedValue('first-frame');
    const first = await manager.attach('p1', 'muxbase-test', '%1', '/tmp/pane.ansi', undefined, true, 101);
    await flushMicrotasks();
    send.mockClear();
    vi.mocked(capturePane).mockClear();
    transcriptStreamSpies.replayExistingData.mockClear();
    transcriptStreamSpies.resumeFollowingFromOffset.mockClear();
    transcriptStreamSpies.discardBufferedDataAndSeekToEnd.mockClear();
    vi.mocked(capturePane).mockResolvedValue('remounted-frame');
    vi.mocked(execAsync).mockReset();
    vi.mocked(execAsync)
      .mockResolvedValueOnce('0')
      .mockResolvedValueOnce('3')
      .mockResolvedValueOnce('0')
      .mockResolvedValueOnce('0:0:1');

    // Act
    paneGeometryMock.mockResolvedValue('40x10:@9:40x10:1'); // would-be new dims
    const second = await manager.attach('p1', 'muxbase-test', '%1', '/tmp/pane.ansi', undefined, true, 202);
    await flushMicrotasks();

    // Assert
    expect(first.streamId).toBe(101);
    expect(second.streamId).toBe(202);
    expect(second.cols).toBe(80);
    expect(second.rows).toBe(24);
    expect(transcriptStreamSpies.attach).toHaveBeenCalledTimes(1);

    const payloads = send.mock.calls
      .filter((call) => call[1]?.paneId === 'p1')
      .map((call) => call[1]?.data)
      .join('');
    expect(payloads).toContain('\x1bc');
    expect(payloads).toContain('[FRAME]remounted-frame');
    expect(payloads).not.toContain('[SANITIZED-SCROLLBACK]');
    expect(payloads).not.toContain('[SCROLLBACK-REPLAY]');
    expect(capturePane).toHaveBeenCalledWith('%1');
    expect(transcriptStreamSpies.replayExistingData).not.toHaveBeenCalled();
    expect(transcriptStreamSpies.resumeFollowingFromOffset).not.toHaveBeenCalled();
    expect(transcriptStreamSpies.discardBufferedDataAndSeekToEnd).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'p1', streamId: 202 }),
    );
    expect(transcriptStreamSpies.readNewData).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'p1' }),
    );
    expect(send.mock.calls.some((call) => (
      call[1]?.paneId === 'p1'
      && call[1]?.data === '\x1bc'
      && call[1]?.streamId === 202
    ))).toBe(true);

    manager.destroyAll();
  });

  it('waits for an in-flight capture before rejecting a fixed existing-stream geometry failure', async () => {
    const { window } = makeFakeWindow();
    const capture = createDeferred<string>();
    const manager = new TerminalManager(window, { pollIntervalMs: 5_000, transportMode: 'classic' });
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      undefined,
      { cols: 100, rows: 30 },
      false,
      101,
      100,
    );
    await flushMicrotasks();

    vi.mocked(capturePane).mockReset().mockImplementationOnce(() => capture.promise);
    manager.unlockStdin('p1');
    await manager.write('p1', 'trigger-capture');
    await new Promise((resolve) => setTimeout(resolve, 20));
    paneGeometryMock
      .mockReset()
      .mockResolvedValue('120x30:@7:120x30:1');

    let settled = false;
    const attaching = manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      undefined,
      { cols: 100, rows: 30 },
      false,
      202,
      100,
    ).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    ).finally(() => {
      settled = true;
    });

    await flushMicrotasks();
    const stayedPendingDuringCapture = !settled;
    capture.resolve('completed-capture');
    const outcome = await attaching;

    expect(stayedPendingDuringCapture).toBe(true);
    expect(outcome).toEqual({
      error: expect.objectContaining({
        message: expect.stringContaining('did not reach requested geometry'),
      }),
    });
    expect(execAsync).toHaveBeenCalledWith(
      "tmux resize-window -t '%1' -x 100 -y 30",
      { silent: true },
    );

    manager.destroyAll();
  });

  it('rejects an existing-stream attach detached while it waits for capture completion', async () => {
    const { window } = makeFakeWindow();
    const capture = createDeferred<string>();
    const manager = new TerminalManager(window, { pollIntervalMs: 5_000, transportMode: 'classic' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, undefined, false, 101);
    await flushMicrotasks();

    vi.mocked(capturePane).mockReset().mockImplementationOnce(() => capture.promise);
    manager.unlockStdin('p1');
    await manager.write('p1', 'trigger-capture');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const attaching = manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      undefined,
      undefined,
      false,
      202,
    );
    await flushMicrotasks();

    manager.detach('p1');
    capture.resolve('completed-after-detach');

    await expect(attaching).rejects.toThrow('Terminal attach lost ownership');
    manager.destroyAll();
  });

  it('cleans a registered stream when transcript startup rejects so the next attach starts fresh', async () => {
    const { window } = makeFakeWindow();
    vi.mocked(existsSync).mockReturnValue(true);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    transcriptStreamSpies.attach
      .mockRejectedValueOnce(new Error('transcript watcher failed'))
      .mockResolvedValueOnce(undefined);
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'classic' });

    await expect(manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      '/tmp/pane.ansi',
      { cols: 100, rows: 30 },
      true,
      101,
      100,
    )).rejects.toThrow('transcript watcher failed');

    expect(transcriptStreamSpies.dispose).toHaveBeenCalledTimes(1);
    const second = await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      '/tmp/pane.ansi',
      { cols: 100, rows: 30 },
      true,
      202,
      100,
    );

    expect(second).toEqual(expect.objectContaining({
      mode: 'transcript',
      streamId: 202,
    }));
    expect(transcriptStreamSpies.attach).toHaveBeenCalledTimes(2);

    manager.destroyAll();
    expect(transcriptStreamSpies.dispose).toHaveBeenCalledTimes(2);
  });

  it('resizes existing agent transcript streams during rehydrate with transcript suppression', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    vi.mocked(existsSync).mockReturnValue(true);
    await manager.attach('p1', 'muxbase-test', '%1', '/tmp/pane.ansi', undefined, true, 101);
    await flushMicrotasks();
    vi.mocked(execAsync).mockClear();
    transcriptStreamSpies.replayExistingData.mockClear();
    transcriptStreamSpies.resumeFollowingFromOffset.mockClear();
    transcriptStreamSpies.discardBufferedDataAndSeekToEnd.mockClear();
    mockVerifiedPaneResize('80x24:@1:80x24:1', '120x36:@1:120x36:1');

    // Act
    const second = await manager.attach('p1', 'muxbase-test', '%1', '/tmp/pane.ansi', {
      cols: 120,
      rows: 36,
    }, true, 202);
    await flushMicrotasks();

    // Assert
    expect(second).toEqual(expect.objectContaining({ cols: 120, rows: 36, streamId: 202 }));
    const calls = vi.mocked(execAsync).mock.calls.map((call) => call[0] as string);
    expect(calls.some((call) => call.includes('resize-window') && call.includes('-x 120') && call.includes('-y 36')))
      .toBe(true);
    expect(calls.some((call) => call.includes('resize-pane') && call.includes('-x 120') && call.includes('-y 36')))
      .toBe(true);
    expect(transcriptStreamSpies.discardBufferedDataAndSeekToEnd).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'p1', skipScrollbackReplay: true, streamId: 202 }),
    );
    expect(transcriptStreamSpies.replayExistingData).not.toHaveBeenCalled();
    expect(transcriptStreamSpies.resumeFollowingFromOffset).not.toHaveBeenCalled();

    manager.destroyAll();
  });

  it('does not shrink cold agent transcript panes before snapshot replay', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    vi.mocked(existsSync).mockReturnValue(true);
    paneGeometryMock
      .mockResolvedValueOnce('120x36:@1:120x36:1');
    await flushMicrotasks();
    vi.mocked(execAsync).mockClear();

    // Act
    const attached = await manager.attach('p1', 'muxbase-test', '%1', '/tmp/pane.ansi', {
      cols: 80,
      rows: 24,
    }, true, 101);
    await flushMicrotasks();

    // Assert
    expect(attached).toEqual(expect.objectContaining({ cols: 120, rows: 36, streamId: 101 }));
    expect(execAsync).not.toHaveBeenCalledWith(
      expect.stringContaining('resize-window'),
      expect.anything(),
    );
    expect(execAsync).not.toHaveBeenCalledWith(
      expect.stringContaining('resize-pane'),
      expect.anything(),
    );
    expect(transcriptStreamSpies.replayExistingData).not.toHaveBeenCalled();
    expect(capturePane).toHaveBeenCalledWith('%1');
    expect(transcriptStreamSpies.attach).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'p1', streamId: 101 }),
      '/tmp/pane.ansi',
    );

    manager.destroyAll();
  });

  it('pre-sizes cold agent transcript panes before snapshot replay when requested geometry expands', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    vi.mocked(existsSync).mockReturnValue(true);
    paneGeometryMock
      .mockResolvedValueOnce('80x24:@1:80x24:1')
      .mockResolvedValueOnce('120x36:@1:120x36:1');
    await flushMicrotasks();
    vi.mocked(execAsync).mockClear();

    // Act
    const attached = await manager.attach('p1', 'muxbase-test', '%1', '/tmp/pane.ansi', {
      cols: 120,
      rows: 36,
    }, true, 101);
    await flushMicrotasks();

    // Assert
    expect(attached).toEqual(expect.objectContaining({ cols: 120, rows: 36, streamId: 101 }));
    const calls = vi.mocked(execAsync).mock.calls.map((call) => call[0] as string);
    const resizeWindowIndex = calls.findIndex((call) => call.includes('resize-window'));
    expect(resizeWindowIndex).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(execAsync).mock.invocationCallOrder[resizeWindowIndex])
      .toBeLessThan(vi.mocked(capturePane).mock.invocationCallOrder[0]);
    expect(execAsync).toHaveBeenCalledWith(
      "tmux resize-window -t '%1' -x 120 -y 36",
      { silent: true },
    );
    expect(execAsync).toHaveBeenCalledWith(
      "tmux resize-pane -t '%1' -x 120 -y 36",
      { silent: true },
    );

    manager.destroyAll();
  });

  it('remembers the latest requested terminal geometry for future pane launches', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    paneGeometryMock
      .mockResolvedValueOnce('80x24:@1:80x24:1')
      .mockResolvedValueOnce('118x34:@1:118x34:1')
      .mockResolvedValueOnce('118x34:@1:118x34:1')
      .mockResolvedValue('132x42:@1:132x42:1');

    // Act
    await manager.attach('p1', 'muxbase-test', '%1', undefined, {
      cols: 118,
      rows: 34,
    });
    await manager.resize('p1', 132, 42);

    // Assert
    expect(manager.getPreferredLaunchSize()).toEqual({ cols: 132, rows: 42 });
    expect(electronSettingsSpies.update).toHaveBeenCalledWith('terminalPreferredLaunchCols', 132);
    expect(electronSettingsSpies.update).toHaveBeenCalledWith('terminalPreferredLaunchRows', 42);

    manager.destroyAll();
  });

  it('hydrates the preferred launch geometry from persisted settings', () => {
    // Arrange
    electronSettingsSpies.getAll.mockReturnValue({
      scrollbackLines: 1000,
      terminalPreferredLaunchCols: 132,
      terminalPreferredLaunchRows: 42,
    });

    // Act
    const manager = new TerminalManager(null, { pollIntervalMs: 200 });

    // Assert
    expect(manager.getPreferredLaunchSize()).toEqual({ cols: 132, rows: 42 });

    manager.destroyAll();
  });

  it('captures one post-follow snapshot for agent transcript bytes written during attach', async () => {
    // Arrange
    const { window, send } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(capturePane)
      .mockResolvedValueOnce('snapshot-before-follow')
      .mockResolvedValue('snapshot-after-follow');
    transcriptStreamSpies.attach.mockImplementationOnce(async () => {
      vi.mocked(capturePane).mockResolvedValue('snapshot-after-follow');
    });

    // Act
    await manager.attach('p1', 'muxbase-test', '%1', '/tmp/pane.ansi', undefined, true, 101);
    await flushMicrotasks();

    // Assert
    const payloads = send.mock.calls
      .filter((call) => call[1]?.paneId === 'p1')
      .map((call) => call[1]?.data)
      .join('');
    expect(payloads).toContain('[FRAME]snapshot-before-follow');
    expect(payloads).toContain('[FRAME]snapshot-after-follow');
    expect(capturePane).toHaveBeenCalledWith('%1');

    manager.destroyAll();
  });

  it('does not shrink cold control-mode agent panes before snapshot replay', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'control' });
    paneGeometryMock.mockResolvedValueOnce('120x36:@1:120x36:1');
    await flushMicrotasks();
    vi.mocked(execAsync).mockClear();

    // Act
    const attached = await manager.attach('p1', 'muxbase-test', '%1', undefined, {
      cols: 80,
      rows: 24,
    }, true, 101);
    await flushMicrotasks();

    // Assert
    expect(attached).toEqual(expect.objectContaining({ cols: 120, rows: 36, streamId: 101 }));
    expect(execAsync).not.toHaveBeenCalledWith(
      expect.stringContaining('resize-window'),
      expect.anything(),
    );
    expect(execAsync).not.toHaveBeenCalledWith(
      expect.stringContaining('resize-pane'),
      expect.anything(),
    );

    manager.destroyAll();
  });

  it('preserves scrollback when an agent pane falls back to capture mode', async () => {
    // Arrange
    const { window, send } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    vi.mocked(existsSync).mockReturnValue(false);
    mockTmuxState('2');
    vi.mocked(capturePane).mockImplementation(async (_tmuxPaneId, opts) => (
      opts ? 'history-line-1\nhistory-line-2' : 'current-frame'
    ));

    // Act
    await manager.attach('p1', 'muxbase-test', '%1', '/tmp/missing.ansi', undefined, true);
    await flushMicrotasks();

    // Assert
    const payloads = send.mock.calls
      .filter((call) => call[1]?.paneId === 'p1')
      .map((call) => call[1]?.data)
      .join('');
    expect(payloads).toContain('[SCROLLBACK-REPLAY]history-line-1\nhistory-line-2');
    expect(payloads).toContain('[FRAME]current-frame');

    manager.destroyAll();
  });

  it('detach disposes the stream and stops polling', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    await manager.attach('p1', 'muxbase-test', '%1');
    await flushMicrotasks();

    const captureCallsBeforeDetach = vi.mocked(capturePane).mock.calls.length;

    // Act
    manager.detach('p1');

    // Allow any in-flight setTimeout to drain
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Assert — no further captures occurred after detach
    expect(vi.mocked(capturePane).mock.calls.length).toBe(captureCallsBeforeDetach);
    // Transcript dispose is also invoked for any stream the manager owns
    expect(transcriptStreamSpies.dispose).toHaveBeenCalled();
  });

  it('resize sends tmux resize-window then resize-pane with correct dimensions', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    await manager.attach('p1', 'muxbase-test', '%1');
    vi.mocked(execAsync).mockClear();
    vi.mocked(execAsync).mockResolvedValue('0');
    mockVerifiedPaneResize('80x24:@1:80x24:1', '100x30:@1:100x30:1');

    // Act
    await manager.resize('p1', 100, 30);

    // Assert
    const calls = vi.mocked(execAsync).mock.calls.map((c) => c[0] as string);
    const resizeWindow = calls.find((c) => c.includes('resize-window'));
    const resizePane = calls.find((c) => c.includes('resize-pane'));
    expect(resizeWindow).toBeDefined();
    expect(resizeWindow).toContain('-x 100');
    expect(resizeWindow).toContain('-y 30');
    expect(resizePane).toBeDefined();
    expect(resizePane).toContain('-x 100');
    expect(resizePane).toContain('-y 30');
    // window is resized before pane (boundary safety)
    expect(calls.indexOf(resizeWindow!)).toBeLessThan(calls.indexOf(resizePane!));

    manager.destroyAll();
  });

  it('repaints transcript panes from tmux after resize even when no new transcript bytes arrive', async () => {
    // Arrange
    const { window, send } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execAsync).mockResolvedValue('0');
    vi.mocked(capturePane).mockResolvedValue('initial-frame');
    await manager.attach('p1', 'muxbase-test', '%1', '/tmp/pane.ansi');
    await flushMicrotasks();
    send.mockClear();
    vi.mocked(capturePane).mockClear();
    vi.mocked(capturePane).mockResolvedValue('resized-frame');
    mockVerifiedPaneResize('80x24:@1:80x24:1', '100x30:@1:100x30:1');

    // Act
    await manager.resize('p1', 100, 30);
    await flushMicrotasks();

    // Assert
    expect(capturePane).toHaveBeenCalledWith('%1');
    expect(transcriptStreamSpies.discardBufferedDataAndSeekToEnd).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'p1' }),
    );
    const payloads = send.mock.calls
      .filter((call) => call[1]?.paneId === 'p1')
      .map((call) => call[1]?.data)
      .join('');
    expect(payloads).toContain('[FRAME]resized-frame');
    expect(send.mock.calls.some((call) => (
      call[1]?.paneId === 'p1'
      && call[1]?.data?.includes('[FRAME]resized-frame')
      && call[1]?.source === 'replay'
    ))).toBe(true);

    manager.destroyAll();
  });

  it('suppresses transcript resize bytes before issuing tmux resize commands', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execAsync).mockResolvedValue('0');
    vi.mocked(capturePane).mockResolvedValue('initial-frame');
    await manager.attach('p1', 'muxbase-test', '%1', '/tmp/pane.ansi');
    await flushMicrotasks();
    vi.mocked(execAsync).mockClear();
    transcriptStreamSpies.discardBufferedDataAndSeekToEnd.mockClear();
    mockVerifiedPaneResize('80x24:@1:80x24:1', '100x30:@1:100x30:1');

    // Act
    await manager.resize('p1', 100, 30);

    // Assert
    const resizeOrder = vi.mocked(execAsync).mock.invocationCallOrder.find((_, index) => {
      const command = vi.mocked(execAsync).mock.calls[index]?.[0] as string | undefined;
      return command?.includes('resize-window') === true;
    });
    expect(resizeOrder).toBeDefined();
    expect(transcriptStreamSpies.discardBufferedDataAndSeekToEnd.mock.invocationCallOrder[0])
      .toBeLessThan(resizeOrder!);

    manager.destroyAll();
  });

  it('repaints transcript panes again after resize redraw bytes settle', async () => {
    // Arrange
    const { window, send } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execAsync).mockResolvedValue('0');
    vi.mocked(capturePane).mockResolvedValue('initial-frame');
    await manager.attach('p1', 'muxbase-test', '%1', '/tmp/pane.ansi');
    await flushMicrotasks();
    vi.useFakeTimers();
    send.mockClear();
    transcriptStreamSpies.discardBufferedDataAndSeekToEnd.mockClear();
    vi.mocked(capturePane)
      .mockClear()
      .mockResolvedValueOnce('resize-frame')
      .mockResolvedValueOnce('settled-frame');
    mockVerifiedPaneResize('80x24:@1:80x24:1', '100x30:@1:100x30:1');

    try {
      // Act
      await manager.resize('p1', 100, 30);
      await vi.advanceTimersByTimeAsync(100);

      // Assert
      expect(transcriptStreamSpies.discardBufferedDataAndSeekToEnd).toHaveBeenCalledTimes(3);
      const payloads = send.mock.calls
        .filter((call) => call[1]?.paneId === 'p1')
        .map((call) => call[1]?.data)
        .join('');
      expect(payloads).toContain('[FRAME]resize-frame');
      expect(payloads).toContain('[FRAME]settled-frame');
    } finally {
      manager.destroyAll();
      vi.useRealTimers();
    }
  });

  it('resizes post-attach agent transcript panes with transcript suppression', async () => {
    // Arrange
    const { window, send } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execAsync).mockResolvedValue('0');
    vi.mocked(capturePane).mockResolvedValue('initial-frame');
    await manager.attach('p1', 'muxbase-test', '%1', '/tmp/pane.ansi', undefined, true);
    await flushMicrotasks();
    send.mockClear();
    vi.mocked(execAsync).mockClear();
    vi.mocked(capturePane).mockClear();
    transcriptStreamSpies.discardBufferedDataAndSeekToEnd.mockClear();
    mockVerifiedPaneResize('80x24:@1:80x24:1', '100x30:@1:100x30:1');

    // Act
    await manager.resize('p1', 100, 30);
    await flushMicrotasks();

    // Assert
    const calls = vi.mocked(execAsync).mock.calls.map((call) => call[0] as string);
    expect(calls.some((call) => call.includes('resize-window') && call.includes('-x 100') && call.includes('-y 30')))
      .toBe(true);
    expect(calls.some((call) => call.includes('resize-pane') && call.includes('-x 100') && call.includes('-y 30')))
      .toBe(true);
    expect(transcriptStreamSpies.discardBufferedDataAndSeekToEnd).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'p1', skipScrollbackReplay: true }),
    );
    expect(capturePane).toHaveBeenCalledWith('%1');
    expect(send.mock.calls.some((call) => (
      call[1]?.paneId === 'p1'
      && call[1]?.data?.includes('[FRAME]initial-frame')
      && call[1]?.source === 'replay'
    ))).toBe(true);

    manager.destroyAll();
  });

  it('continues resizing non-agent transcript panes', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execAsync).mockResolvedValue('0');
    vi.mocked(capturePane).mockResolvedValue('initial-frame');
    await manager.attach('p1', 'muxbase-test', '%1', '/tmp/pane.ansi');
    await flushMicrotasks();
    vi.mocked(execAsync).mockClear();
    transcriptStreamSpies.discardBufferedDataAndSeekToEnd.mockClear();
    mockVerifiedPaneResize('80x24:@1:80x24:1', '100x30:@1:100x30:1');

    // Act
    await manager.resize('p1', 100, 30);
    await flushMicrotasks();

    // Assert
    const calls = vi.mocked(execAsync).mock.calls.map((call) => call[0] as string);
    expect(calls.some((call) => call.includes('resize-window') && call.includes('-x 100') && call.includes('-y 30')))
      .toBe(true);
    expect(calls.some((call) => call.includes('resize-pane') && call.includes('-x 100') && call.includes('-y 30')))
      .toBe(true);
    expect(transcriptStreamSpies.discardBufferedDataAndSeekToEnd).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'p1' }),
    );

    manager.destroyAll();
  });

  it('write forwards data to tmux when not stdin-locked', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    await manager.attach('p1', 'muxbase-test', '%1');
    // Newly attached streams start with stdin locked — unlock first.
    manager.unlockStdin('p1');

    // Act
    await manager.write('p1', 'hello');

    // Assert
    expect(writeTerminalInput).toHaveBeenCalledWith('%1', 'hello');

    manager.destroyAll();
  });

  it('write is silently dropped while stdin is locked', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    await manager.attach('p1', 'muxbase-test', '%1');
    // Do NOT unlockStdin — stream stays in locked state from attach.

    // Act
    await manager.write('p1', 'should-be-dropped');

    // Assert
    expect(writeTerminalInput).not.toHaveBeenCalled();

    manager.destroyAll();
  });

  it('does not let an old capture failure detach a rehydrated stream generation', async () => {
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'classic' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, undefined, false, 901);
    await flushMicrotasks();
    manager.unlockStdin('p1');

    const staleCapture = createDeferred<string>();
    vi.mocked(capturePane).mockReset()
      .mockImplementationOnce(() => staleCapture.promise)
      .mockResolvedValue('rehydrated-frame');
    await manager.write('p1', 'x');
    await vi.waitFor(() => expect(capturePane).toHaveBeenCalledTimes(1));

    const rehydrated = manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      undefined,
      undefined,
      false,
      902,
    );
    staleCapture.reject(new Error("can't find pane: stale generation"));
    await expect(rehydrated).resolves.toEqual(expect.objectContaining({ streamId: 902 }));

    vi.mocked(writeTerminalInput).mockClear();
    await manager.write('p1', 'still-owned');
    expect(writeTerminalInput).toHaveBeenCalledWith('%1', 'still-owned');

    manager.destroyAll();
  });

  it('does not let an old capture failure detach a replacement stream object', async () => {
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'classic' });
    await manager.attach('p1', 'muxbase-test', '%old', undefined, undefined, false, 901);
    await flushMicrotasks();
    manager.unlockStdin('p1');

    const staleCapture = createDeferred<string>();
    vi.mocked(capturePane).mockReset()
      .mockImplementationOnce(() => staleCapture.promise)
      .mockResolvedValue('replacement-frame');
    await manager.write('p1', 'x');
    await vi.waitFor(() => expect(capturePane).toHaveBeenCalledTimes(1));

    manager.detach('p1');
    const replacement = await manager.attach(
      'p1',
      'muxbase-test',
      '%new',
      undefined,
      undefined,
      false,
      902,
    );
    expect(replacement.streamId).toBe(902);
    manager.unlockStdin('p1');
    staleCapture.reject(new Error("can't find pane: stale object"));
    await flushMicrotasks();

    vi.mocked(writeTerminalInput).mockClear();
    await manager.write('p1', 'replacement-owned');
    expect(writeTerminalInput).toHaveBeenCalledWith('%new', 'replacement-owned');

    manager.destroyAll();
  });

  it('pauses capture polling while hidden and restores from a reset snapshot', async () => {
    const { window, send } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 50, transportMode: 'classic' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, undefined, false, 901);
    await flushMicrotasks();
    vi.mocked(capturePane).mockClear();
    send.mockClear();

    manager.suspendRendererDelivery();
    await new Promise((resolve) => setTimeout(resolve, 140));

    expect(capturePane).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    vi.mocked(capturePane).mockResolvedValue('restored-content');
    await manager.resumeRendererDelivery();

    const delivered = send.mock.calls
      .map((call) => call[1]?.data as string | undefined)
      .filter((data): data is string => typeof data === 'string');
    expect(delivered[0]).toBe('\x1bc');
    expect(delivered.some((data) => data.includes('[FRAME]restored-content'))).toBe(true);

    manager.destroyAll();
  });

  it('finishes restoring when show arrives during an earlier restore', async () => {
    const { window, send } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 50, transportMode: 'classic' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, undefined, false, 901);
    await flushMicrotasks();
    const firstRestore = createDeferred<string>();
    vi.mocked(capturePane).mockReset()
      .mockReturnValueOnce(firstRestore.promise)
      .mockResolvedValue('latest-visible-content');
    send.mockClear();

    manager.suspendRendererDelivery();
    const initialResume = manager.resumeRendererDelivery();
    await vi.waitFor(() => expect(capturePane).toHaveBeenCalledOnce());

    manager.suspendRendererDelivery();
    const finalResume = manager.resumeRendererDelivery();
    firstRestore.resolve('interrupted-content');
    await Promise.all([initialResume, finalResume]);

    expect(capturePane).toHaveBeenCalledTimes(2);
    const delivered = send.mock.calls
      .map((call) => call[1]?.data as string | undefined)
      .filter((data): data is string => typeof data === 'string');
    expect(delivered.some((data) => data.includes('[FRAME]latest-visible-content'))).toBe(true);

    manager.destroyAll();
  });

  it('reattaches a PTY stream on resume instead of replaying a capture snapshot', async () => {
    const { window } = makeFakeWindow();
    const firstHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    const resumedHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach
      .mockResolvedValueOnce(firstHandle)
      .mockResolvedValue(resumedHandle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      '/tmp/pane.ansi',
      { cols: 100, rows: 30 },
      true,
      901,
    );
    vi.mocked(capturePane).mockClear();

    manager.suspendRendererDelivery();
    const firstAttach = ptyServiceSpies.attach.mock.calls[0]?.[0];
    firstAttach.onData('p1', 'changed-while-hidden', 'live', 901);
    await manager.resumeRendererDelivery();

    expect(firstHandle.dispose).toHaveBeenCalledOnce();
    expect(ptyServiceSpies.attach).toHaveBeenCalledTimes(2);
    expect(ptyServiceSpies.attach.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      cols: 100,
      rows: 30,
    }));
    expect(capturePane).not.toHaveBeenCalled();

    manager.destroyAll();
  });

  it('refreshes a PTY stream after hide and show even without an observed output event', async () => {
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      '/tmp/pane.ansi',
      { cols: 100, rows: 30 },
      true,
      901,
    );

    manager.suspendRendererDelivery();
    await manager.resumeRendererDelivery();

    expect(ptyServiceSpies.attach).toHaveBeenCalledTimes(2);
    expect(handle.dispose).toHaveBeenCalledOnce();

    manager.destroyAll();
  });

  it('keeps view-session mouse off after screen-reader detection and PTY reattach', async () => {
    const { window } = makeFakeWindow();
    const firstHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      setMouse: vi.fn(),
      write: vi.fn(),
    };
    const resumedHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      setMouse: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach
      .mockResolvedValueOnce(firstHandle)
      .mockResolvedValueOnce(resumedHandle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      '/tmp/pane.ansi',
      { cols: 100, rows: 30 },
      true,
      901,
      undefined,
      true,
    );
    const firstAttach = ptyServiceSpies.attach.mock.calls[0]?.[0];
    expect(firstAttach.enableMouse).toBe(true);

    firstAttach.onScreenReaderDetected('p1');
    await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      '/tmp/pane.ansi',
      { cols: 100, rows: 30 },
      true,
      902,
      undefined,
      true,
    );
    expect(ptyServiceSpies.attach.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      enableMouse: false,
    }));

    manager.suspendRendererDelivery();
    await manager.resumeRendererDelivery();

    expect(ptyServiceSpies.attach).toHaveBeenCalledTimes(3);
    expect(ptyServiceSpies.attach.mock.calls[2]?.[0]).toEqual(expect.objectContaining({
      enableMouse: false,
    }));

    manager.destroyAll();
  });

  it('keeps view-session mouse off after full stream detach and fresh attach', async () => {
    const { window } = makeFakeWindow();
    const firstHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      setMouse: vi.fn(),
      write: vi.fn(),
    };
    const freshHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      setMouse: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach
      .mockResolvedValueOnce(firstHandle)
      .mockResolvedValueOnce(freshHandle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach(
      'p1', 'muxbase-test', '%1', '/tmp/pane.ansi',
      { cols: 100, rows: 30 }, true, 901, undefined, true,
    );
    const firstAttach = ptyServiceSpies.attach.mock.calls[0]?.[0];
    firstAttach.onScreenReaderDetected('p1');

    manager.detach('p1');
    await manager.attach(
      'p1', 'muxbase-test', '%1', '/tmp/pane.ansi',
      { cols: 100, rows: 30 }, true, 902, undefined, true,
    );

    expect(ptyServiceSpies.attach).toHaveBeenCalledTimes(2);
    expect(ptyServiceSpies.attach.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      enableMouse: false,
    }));

    manager.destroyAll();
  });

  it('clears the screen-reader mouse latch when the logical pane is removed', async () => {
    const { window } = makeFakeWindow();
    const firstHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      setMouse: vi.fn(),
      write: vi.fn(),
    };
    const replacementHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      setMouse: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach
      .mockResolvedValueOnce(firstHandle)
      .mockResolvedValueOnce(replacementHandle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach(
      'p1', 'muxbase-test', '%1', '/tmp/pane.ansi',
      { cols: 100, rows: 30 }, true, 901, undefined, true,
    );
    const firstAttach = ptyServiceSpies.attach.mock.calls[0]?.[0];
    firstAttach.onScreenReaderDetected('p1');

    manager.removePane('p1');
    await manager.attach(
      'p1', 'muxbase-test', '%1', '/tmp/pane.ansi',
      { cols: 100, rows: 30 }, true, 902, undefined, true,
    );

    expect(ptyServiceSpies.attach.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      enableMouse: true,
    }));

    manager.destroyAll();
  });

  it('preserves a PTY scroll position across hide and show', async () => {
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      '/tmp/pane.ansi',
      { cols: 100, rows: 30 },
      true,
      901,
    );
    manager.unlockStdin('p1');
    await manager.scroll('p1', 'up', 5);
    paneStateMock.mockImplementation(async (_paneId, format) => (
      format === '#{pane_in_mode}' ? '1' : '0'
    ));
    vi.mocked(execAsync).mockClear();

    manager.suspendRendererDelivery();
    await manager.resumeRendererDelivery();

    expect(ptyServiceSpies.attach).toHaveBeenCalledTimes(1);
    expect(handle.dispose).not.toHaveBeenCalled();
    expect(execAsync).not.toHaveBeenCalledWith(
      "tmux copy-mode -q -t '%1'",
      { timeout: 1500 },
    );
    expect(paneStateMock).toHaveBeenCalledWith('%1', '#{pane_in_mode}');

    manager.destroyAll();
  });

  it('delivers the replacement PTY repaint while that pane owns resume restore', async () => {
    const { window, send } = makeFakeWindow();
    const resumedAttach = createDeferred<{
      dispose: ReturnType<typeof vi.fn>;
      resize: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
    }>();
    const firstHandle = { dispose: vi.fn(), resize: vi.fn(), write: vi.fn() };
    const resumedHandle = { dispose: vi.fn(), resize: vi.fn(), write: vi.fn() };
    ptyServiceSpies.attach
      .mockResolvedValueOnce(firstHandle)
      .mockReturnValueOnce(resumedAttach.promise);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      '/tmp/pane.ansi',
      { cols: 100, rows: 30 },
      true,
      901,
    );
    const initialAttach = ptyServiceSpies.attach.mock.calls[0]?.[0];
    send.mockClear();

    manager.suspendRendererDelivery();
    initialAttach.onData('p1', 'hidden-change', 'live', 901);
    const resume = manager.resumeRendererDelivery();
    await vi.waitFor(() => expect(ptyServiceSpies.attach).toHaveBeenCalledTimes(2));
    const resumeAttach = ptyServiceSpies.attach.mock.calls[1]?.[0];
    resumeAttach.onData('p1', 'authoritative-resume-repaint', 'live', 901);

    expect(transcriptStreamSpies.queue).toHaveBeenCalledWith(
      expect.anything(),
      'authoritative-resume-repaint',
      'live',
    );

    resumedAttach.resolve(resumedHandle);
    await resume;
    resumeAttach.onData('p1', 'visible-live-data', 'live', 901);
    await flushMicrotasks();

    expect(transcriptStreamSpies.queue).toHaveBeenCalledWith(
      expect.anything(),
      'visible-live-data',
      'live',
    );
    manager.destroyAll();
  });

  it('defers a hidden-attached PTY OSC 52 follower until renderer resume', async () => {
    const { window } = makeFakeWindow();
    ptyServiceSpies.attach.mockResolvedValue({
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    });
    vi.mocked(existsSync).mockReturnValue(true);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    vi.mocked(execAsync).mockImplementation(async (command: string) => (
      command.includes('show-options -sv set-clipboard') ? 'external' : '0'
    ));
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });

    manager.suspendRendererDelivery();
    await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      '/tmp/pane.ansi',
      { cols: 100, rows: 30 },
      true,
      901,
    );

    expect(ptyOsc52FollowerSpies.attach).not.toHaveBeenCalled();

    await manager.resumeRendererDelivery();
    expect(ptyOsc52FollowerSpies.attach).toHaveBeenCalledOnce();
    manager.destroyAll();
  });

  it('pauses transcript following for a pane attached while the renderer is hidden', async () => {
    const { window } = makeFakeWindow();
    vi.mocked(existsSync).mockReturnValue(true);
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'classic' });

    manager.suspendRendererDelivery();
    await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      '/tmp/pane.ansi',
      undefined,
      false,
      901,
    );

    expect(transcriptStreamSpies.attach).toHaveBeenCalledOnce();
    expect(transcriptStreamSpies.pauseFollowing).toHaveBeenCalled();

    await manager.resumeRendererDelivery();
    expect(transcriptStreamSpies.resumeFollowing).toHaveBeenCalled();
    manager.destroyAll();
  });

  it('serializes classic resume restore with a concurrent resize', async () => {
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'classic' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, undefined, false, 901);
    await flushMicrotasks();
    const restoreCapture = createDeferred<string>();
    vi.mocked(capturePane).mockReset()
      .mockReturnValueOnce(restoreCapture.promise)
      .mockResolvedValue('resized-frame');
    paneGeometryMock.mockResolvedValue('120x36:@1:120x36:1');
    paneGeometryMock.mockClear();

    manager.suspendRendererDelivery();
    const resume = manager.resumeRendererDelivery();
    await vi.waitFor(() => expect(capturePane).toHaveBeenCalledOnce());
    const resize = manager.resize('p1', 120, 36);
    await flushMicrotasks();

    expect(paneGeometryMock).not.toHaveBeenCalled();

    restoreCapture.resolve('restored-frame');
    await Promise.all([resume, resize]);
    expect(paneGeometryMock).toHaveBeenCalled();

    manager.destroyAll();
  });

  it('keeps the PTY client alive but drops hidden output before transcript buffering', async () => {
    const { window } = makeFakeWindow();
    const handle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach.mockResolvedValue(handle);
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach(
      'p1',
      'muxbase-test',
      '%1',
      '/tmp/pane.ansi',
      { cols: 100, rows: 30 },
      true,
      901,
    );
    const attachOptions = ptyServiceSpies.attach.mock.calls[0]?.[0];
    transcriptStreamSpies.queue.mockClear();

    manager.suspendRendererDelivery();
    attachOptions.onData('p1', 'hidden-output', 'live', 901);

    expect(transcriptStreamSpies.queue).not.toHaveBeenCalled();
    expect(handle.dispose).not.toHaveBeenCalled();

    manager.destroyAll();
  });

  it('auto-detaches a stream when tmux reports the pane no longer exists', async () => {
    // Arrange
    const { window } = makeFakeWindow();
    const manager = new TerminalManager(window, { pollIntervalMs: 200 });
    await manager.attach('p1', 'muxbase-test', '%1');

    // Simulate tmux refusing further captures
    vi.mocked(capturePane).mockRejectedValue(new Error("can't find pane: %1"));

    // Act — explicit call to write triggers scheduleWriteCapture which calls capturePaneContent
    manager.unlockStdin('p1');
    await manager.write('p1', 'x');
    // Wait for the debounced write-capture (8ms) + its async chain
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Assert — subsequent writes should no-op because the stream was detached
    vi.mocked(writeTerminalInput).mockClear();
    await manager.write('p1', 'y');
    expect(writeTerminalInput).not.toHaveBeenCalled();
  });

  it('emits TERMINAL_STREAM_MODE_CHANGED from fallbackControlStream when control becomes unavailable', async () => {
    // Arrange
    const { window, send } = makeFakeWindow();
    let controlSubscriber: {
      onOutput: (data: string) => void;
      onUnavailable: (reason: string) => void;
    } | null = null;
    const controlClient = {
      ensureStarted: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn(),
      stop: vi.fn(),
      subscribePane: vi.fn((_paneId: string, subscriber: {
        onOutput: (data: string) => void;
        onUnavailable: (reason: string) => void;
      }) => {
        controlSubscriber = subscriber;
        return vi.fn();
      }),
    };
    const manager = new TerminalManager(window, {
      createControlClient: () => controlClient as never,
      pollIntervalMs: 200,
      transportMode: 'control',
    });
    mockTmuxState();
    await manager.attach('p1', 'muxbase-test', '%1', undefined, undefined, true, 201);
    if (!controlSubscriber) throw new Error('control subscriber not registered');
    send.mockClear();

    // Act: control mode becomes unavailable at runtime
    controlSubscriber.onUnavailable('server exited');
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Assert: the event was sent with the correct paneId, streamId, and mode
    const modeEvents = send.mock.calls.filter(
      (call) => call[0] === IPC_EVENT.TERMINAL_STREAM_MODE_CHANGED,
    );
    expect(modeEvents).toHaveLength(1);
    expect(modeEvents[0][1]).toMatchObject({
      paneId: 'p1',
      streamId: 201,
      mode: expect.stringMatching(/^(capture|transcript)$/),
    });

    manager.destroyAll();
  });

  it('emits TERMINAL_STREAM_MODE_CHANGED from startClassicFallbackAfterPtyFailure after pty exit reattach failure', async () => {
    // Arrange
    const { window, send } = makeFakeWindow();
    const firstHandle = {
      dispose: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
    };
    ptyServiceSpies.attach
      .mockResolvedValueOnce(firstHandle)
      .mockRejectedValue(new Error('pty reattach unavailable'));
    paneGeometryMock.mockResolvedValue('100x30:@7:100x30:1');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });
    await manager.attach('p1', 'muxbase-test', '%1', undefined, { cols: 100, rows: 30 }, true, 901);
    const attachOptions = ptyServiceSpies.attach.mock.calls[0]?.[0];
    send.mockClear();

    // Act: pty exits; recovery attempts reattach which fails, triggering classic fallback
    attachOptions.onExit('p1', { exitCode: 1 });
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Assert: stream mode changed event emitted
    const modeEvents = send.mock.calls.filter(
      (call) => call[0] === IPC_EVENT.TERMINAL_STREAM_MODE_CHANGED,
    );
    expect(modeEvents).toHaveLength(1);
    expect(modeEvents[0][1]).toMatchObject({
      paneId: 'p1',
      streamId: 901,
      mode: expect.stringMatching(/^(capture|transcript)$/),
    });

    manager.destroyAll();
  });

  it('does not emit TERMINAL_STREAM_MODE_CHANGED during initial attach even when pty falls back to classic', async () => {
    // Arrange: initial PTY attach fails — uses prepareClassicFallback inline, not startClassicFallbackAfterPtyFailure
    const { window, send } = makeFakeWindow();
    ptyServiceSpies.attach.mockRejectedValue(new Error('native pty unavailable'));
    mockTmuxState('0');
    vi.mocked(capturePane).mockResolvedValue('classic-fallback-frame');
    const manager = new TerminalManager(window, { pollIntervalMs: 200, transportMode: 'pty' });

    // Act
    await manager.attach('p1', 'muxbase-test', '%1', undefined, undefined, true, 902);
    await flushMicrotasks();

    // Assert: no stream mode changed event on initial attach
    const modeEvents = send.mock.calls.filter(
      (call) => call[0] === IPC_EVENT.TERMINAL_STREAM_MODE_CHANGED,
    );
    expect(modeEvents).toHaveLength(0);

    manager.destroyAll();
  });

  it('does not emit TERMINAL_STREAM_MODE_CHANGED for a superseded stream after detach', async () => {
    // Arrange
    const { window, send } = makeFakeWindow();
    let controlSubscriber: {
      onOutput: (data: string) => void;
      onUnavailable: (reason: string) => void;
    } | null = null;
    const controlClient = {
      ensureStarted: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn(),
      stop: vi.fn(),
      subscribePane: vi.fn((_paneId: string, subscriber: {
        onOutput: (data: string) => void;
        onUnavailable: (reason: string) => void;
      }) => {
        controlSubscriber = subscriber;
        return vi.fn();
      }),
    };
    const manager = new TerminalManager(window, {
      createControlClient: () => controlClient as never,
      pollIntervalMs: 200,
      transportMode: 'control',
    });
    mockTmuxState();
    await manager.attach('p1', 'muxbase-test', '%1', undefined, undefined, true, 301);
    if (!controlSubscriber) throw new Error('control subscriber not registered');

    // Detach before the runtime fallback fires
    manager.detach('p1');
    send.mockClear();

    // Act: onUnavailable fires on the now-detached stream
    controlSubscriber.onUnavailable('server exited after detach');
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Assert: no event for a superseded (detached) stream
    const modeEvents = send.mock.calls.filter(
      (call) => call[0] === IPC_EVENT.TERMINAL_STREAM_MODE_CHANGED,
    );
    expect(modeEvents).toHaveLength(0);

    manager.destroyAll();
  });
});
