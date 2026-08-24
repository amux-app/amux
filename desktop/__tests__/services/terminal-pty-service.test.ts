import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execAsyncMock = vi.hoisted(() => vi.fn());

vi.mock('aumx/core', () => ({
  execAsync: execAsyncMock,
  shQuote: (value: string) => `'${value.replace(/'/g, "'\\''")}'`,
}));

vi.mock('../../src/main/services/Logger.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  TerminalPtyService,
  type TerminalPtyProcess,
} from '../../src/main/services/terminal-pty-service';
import {
  cleanupDetachedTerminalPtyViewSessions,
  isTerminalPtyViewSessionName,
  makeTerminalPtyViewSessionName,
} from '../../src/main/services/terminal-pty-session';

class FakePtyProcess implements TerminalPtyProcess {
  readonly kill = vi.fn();
  readonly resize = vi.fn();
  readonly write = vi.fn();
  private dataHandler: ((data: string) => void) | null = null;
  private exitHandler: ((event: { exitCode: number; signal?: number }) => void) | null = null;

  emitData(data: string): void {
    this.dataHandler?.(data);
  }

  emitExit(event = { exitCode: 0 }): void {
    this.exitHandler?.(event);
  }

  onData(callback: (data: string) => void): { dispose(): void } {
    this.dataHandler = callback;
    return {
      dispose: () => {
        this.dataHandler = null;
      },
    };
  }

  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitHandler = callback;
    return {
      dispose: () => {
        this.exitHandler = null;
      },
    };
  }
}

describe('TerminalPtyService', () => {
  let process: FakePtyProcess;
  let killViewSession: ReturnType<typeof vi.fn>;
  let spawn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('COLORFGBG', undefined);
    process = new FakePtyProcess();
    killViewSession = vi.fn();
    spawn = vi.fn(() => process);
    execAsyncMock.mockReset().mockResolvedValue('');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('creates an isolated one-window tmux view session and attaches it through node-pty', async () => {
    const onData = vi.fn();
    const onExit = vi.fn();
    const service = new TerminalPtyService({ killViewSession, spawner: { spawn } });

    const handle = await service.attach({
      cols: 120,
      onData,
      onExit,
      paneId: 'pane-1',
      rows: 34,
      sessionName: 'aumx-demo',
      streamId: 44,
      tmuxPaneId: '%3',
      windowId: '@7',
    });

    expect(execAsyncMock).toHaveBeenCalledWith(
      "tmux kill-session -t '=aumx-demo--view-pane-1'",
      { timeout: 5000 },
    );
    expect(execAsyncMock).toHaveBeenCalledWith(
      "tmux new-session -d -s 'aumx-demo--view-pane-1' -n '__aumx_view_bootstrap__' 'sleep 86400' ';' set -t 'aumx-demo--view-pane-1' @aumx_view_session 1",
      { timeout: 5000 },
    );
    expect(execAsyncMock).toHaveBeenCalledWith(
      "tmux set-option -t 'aumx-demo--view-pane-1' status off",
      { timeout: 5000 },
    );
    expect(execAsyncMock).toHaveBeenCalledWith(
      "tmux link-window -s '=aumx-demo:@7' -t '=aumx-demo--view-pane-1:'",
      { timeout: 5000 },
    );
    expect(execAsyncMock).toHaveBeenCalledWith(
      "tmux kill-window -t '=aumx-demo--view-pane-1:__aumx_view_bootstrap__'",
      { timeout: 5000 },
    );
    expect(execAsyncMock).toHaveBeenCalledWith(
      "tmux select-window -t '=aumx-demo--view-pane-1:@7'",
      { timeout: 5000 },
    );
    const setupCommands = execAsyncMock.mock.calls.map((call) => call[0] as string);
    expect(setupCommands.some((command) => command.includes('set-clipboard'))).toBe(false);
    expect(setupCommands.some((command) => command.includes('resize-window'))).toBe(false);
    expect(spawn).toHaveBeenCalledWith('tmux', [
      '-u',
      '-T',
      'RGB,hyperlinks,usstyle,overline,strikethrough,sync,clipboard',
      'attach-session',
      '-t',
      '=aumx-demo--view-pane-1',
    ], expect.objectContaining({
      cols: 120,
      name: 'xterm-256color',
      rows: 34,
    }));

    process.emitData('hello from tmux');
    expect(onData).toHaveBeenCalledWith('pane-1', 'hello from tmux', 'live', 44);

    handle.write('x');
    handle.resize(132, 40);
    handle.dispose();

    expect(process.write).toHaveBeenCalledWith('x');
    expect(process.resize).toHaveBeenCalledWith(132, 40);
    expect(process.kill).toHaveBeenCalledTimes(1);
    expect(killViewSession).toHaveBeenCalledWith('aumx-demo--view-pane-1');

    process.emitExit();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('leaves COLORFGBG to the project session so the hint reaches agent panes', async () => {
    const service = new TerminalPtyService({ killViewSession, spawner: { spawn } });

    await service.attach({
      cols: 80,
      onData: vi.fn(),
      paneId: 'pane-1',
      rows: 24,
      sessionName: 'aumx-demo',
      streamId: 1,
      tmuxPaneId: '%3',
      windowId: '@7',
    });

    // The pty env only tags the tmux client process, which no agent inherits.
    const env = (spawn.mock.calls[0][2] as { env: NodeJS.ProcessEnv }).env;
    expect(env.COLORFGBG).toBeUndefined();
    expect(env.TMUX).toBeUndefined();
  });

  it('replaces any stale view session before attaching', async () => {
    const service = new TerminalPtyService({ killViewSession, spawner: { spawn } });

    await service.attach({
      cols: 80,
      onData: vi.fn(),
      paneId: 'pane-1',
      rows: 24,
      sessionName: 'aumx-demo',
      streamId: 1,
      tmuxPaneId: '%3',
      windowId: '@7',
    });

    const commands = execAsyncMock.mock.calls.map((call) => call[0] as string);
    expect(commands[0]).toBe("tmux kill-session -t '=aumx-demo--view-pane-1'");
    expect(commands.some((command) => command.includes('new-session'))).toBe(true);
  });

  it('uses a stable view session name across repeated attaches for the same pane', async () => {
    const service = new TerminalPtyService({ killViewSession, spawner: { spawn } });

    await service.attach({
      cols: 80,
      onData: vi.fn(),
      paneId: 'pane-1',
      rows: 24,
      sessionName: 'aumx-demo',
      streamId: 1,
      tmuxPaneId: '%3',
      windowId: '@7',
    });
    execAsyncMock.mockClear();
    spawn.mockClear();

    await service.attach({
      cols: 80,
      onData: vi.fn(),
      paneId: 'pane-1',
      rows: 24,
      sessionName: 'aumx-demo',
      streamId: 2,
      tmuxPaneId: '%3',
      windowId: '@7',
    });

    const commands = execAsyncMock.mock.calls.map((call) => call[0] as string);
    expect(commands[0]).toBe("tmux kill-session -t '=aumx-demo--view-pane-1'");
    expect(spawn).toHaveBeenCalledWith('tmux', expect.arrayContaining([
      '=aumx-demo--view-pane-1',
    ]), expect.anything());
  });

  it('never mutates the tmux server clipboard policy', async () => {
    const service = new TerminalPtyService({ killViewSession, spawner: { spawn } });

    await service.attach({
      cols: 80,
      onData: vi.fn(),
      paneId: 'pane-1',
      rows: 24,
      sessionName: 'aumx-demo',
      streamId: 1,
      tmuxPaneId: '%3',
      windowId: '@7',
    });

    const setupCommands = execAsyncMock.mock.calls.map((call) => call[0] as string);
    expect(setupCommands.some((command) => command.includes('set-clipboard'))).toBe(false);
  });

  it('enables mouse only on the exact isolated view session and can switch it off', async () => {
    const service = new TerminalPtyService({ killViewSession, spawner: { spawn } });

    const handle = await service.attach({
      cols: 80,
      enableMouse: true,
      onData: vi.fn(),
      paneId: 'pane-1',
      rows: 24,
      sessionName: 'aumx-demo',
      streamId: 1,
      tmuxPaneId: '%3',
      windowId: '@7',
    });

    expect(execAsyncMock).toHaveBeenCalledWith(
      "tmux set-option -t 'aumx-demo--view-pane-1' mouse on",
      { timeout: 5000 },
    );
    await handle.setMouse(false);
    expect(execAsyncMock).toHaveBeenCalledWith(
      "tmux set-option -t 'aumx-demo--view-pane-1' mouse off",
      { timeout: 5000 },
    );
    expect(execAsyncMock.mock.calls.flat().join(' ')).not.toContain(' -g ');
  });

  it('turns view-session mouse off when a screen-reader marker is split across chunks', async () => {
    const onData = vi.fn();
    const onScreenReaderDetected = vi.fn();
    const service = new TerminalPtyService({ killViewSession, spawner: { spawn } });
    await service.attach({
      cols: 80,
      enableMouse: true,
      onData,
      onScreenReaderDetected,
      paneId: 'pane-1',
      rows: 24,
      sessionName: 'aumx-demo',
      streamId: 1,
      tmuxPaneId: '%3',
      windowId: '@7',
    });
    execAsyncMock.mockClear();

    process.emitData('\u001b[32m[Screen Reader Mode: on via ');
    process.emitData('settings]\u001b[0m\r\n');
    await vi.waitFor(() => {
      expect(execAsyncMock).toHaveBeenCalledWith(
        "tmux set-option -t 'aumx-demo--view-pane-1' mouse off",
        { timeout: 5000 },
      );
    });
    process.emitData('[Screen Reader Mode: on via settings]\r\n');
    expect(execAsyncMock).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenCalledTimes(3);
    expect(onScreenReaderDetected).toHaveBeenCalledOnce();
    expect(onScreenReaderDetected).toHaveBeenCalledWith('pane-1');
  });

  it('does not scan for screen-reader markers when the stream has no mouse policy', async () => {
    const onScreenReaderDetected = vi.fn();
    const service = new TerminalPtyService({ killViewSession, spawner: { spawn } });
    await service.attach({
      cols: 80,
      onData: vi.fn(),
      onScreenReaderDetected,
      paneId: 'pane-1',
      rows: 24,
      sessionName: 'aumx-demo',
      streamId: 1,
      tmuxPaneId: '%3',
      windowId: '@7',
    });
    execAsyncMock.mockClear();

    process.emitData('[Screen Reader Mode: on via settings]\r\n');
    await Promise.resolve();

    expect(onScreenReaderDetected).not.toHaveBeenCalled();
    expect(execAsyncMock).not.toHaveBeenCalled();
  });

  it.each([
    '[Screen Reader Mode: on via flag]',
    '[Screen Reader Mode: on via env]',
    '[Screen Reader Mode: on via settings]',
    '[Accessible screen reader mode: on]',
  ])('recognizes the supported screen-reader marker %s', async (marker) => {
    const service = new TerminalPtyService({ killViewSession, spawner: { spawn } });
    await service.attach({
      cols: 80,
      enableMouse: true,
      onData: vi.fn(),
      paneId: 'pane-1',
      rows: 24,
      sessionName: 'aumx-demo',
      streamId: 1,
      tmuxPaneId: '%3',
      windowId: '@7',
    });
    execAsyncMock.mockClear();

    process.emitData(`${marker}\r\n`);

    await vi.waitFor(() => expect(execAsyncMock).toHaveBeenCalledWith(
      "tmux set-option -t 'aumx-demo--view-pane-1' mouse off",
      { timeout: 5000 },
    ));
  });

  it('rejects before spawning when the isolated view session cannot be created', async () => {
    execAsyncMock.mockImplementation(async (command: string) => {
      if (command.includes('new-session')) throw new Error('source session missing');
      return '';
    });
    const service = new TerminalPtyService({ killViewSession, spawner: { spawn } });

    await expect(service.attach({
      cols: 80,
      onData: vi.fn(),
      paneId: 'pane-1',
      rows: 24,
      sessionName: 'aumx-demo',
      streamId: 1,
      tmuxPaneId: '%3',
      windowId: '@7',
    })).rejects.toThrow('source session missing');

    expect(spawn).not.toHaveBeenCalled();
  });

  it('attaches when the supported tmux version lacks the cosmetic copy-mode position option', async () => {
    execAsyncMock.mockImplementation(async (command: string) => {
      if (command.includes('copy-mode-position-format')) {
        throw new Error('invalid option: copy-mode-position-format');
      }
      return '';
    });
    const service = new TerminalPtyService({ killViewSession, spawner: { spawn } });

    await expect(service.attach({
      cols: 80,
      onData: vi.fn(),
      paneId: 'pane-1',
      rows: 24,
      sessionName: 'aumx-demo',
      streamId: 1,
      tmuxPaneId: '%3',
      windowId: '@7',
    })).resolves.toBeDefined();

    expect(spawn).toHaveBeenCalledOnce();
  });

  it('cleans the pane-scoped view session when node-pty spawn fails', async () => {
    spawn.mockImplementation(() => {
      throw new Error('pty spawn failed');
    });
    const service = new TerminalPtyService({ killViewSession, spawner: { spawn } });

    await expect(service.attach({
      cols: 80,
      onData: vi.fn(),
      paneId: 'pane-1',
      rows: 24,
      sessionName: 'aumx-demo',
      streamId: 7,
      tmuxPaneId: '%3',
      windowId: '@7',
    })).rejects.toThrow('pty spawn failed');

    expect(killViewSession).toHaveBeenCalledWith('aumx-demo--view-pane-1');
  });

  it('cleans detached pty view sessions without touching attached clients or unmarked sessions', async () => {
    execAsyncMock.mockResolvedValue([
      'aumx-demo|0|',
      'aumx-demo--view-pane-1|0|1',
      'aumx-demo--view-pane-2|1|1',
      'user-session--view-main|0|',
      'other-session|0|',
    ].join('\n'));

    const cleaned = await cleanupDetachedTerminalPtyViewSessions(execAsyncMock);

    expect(cleaned).toBe(1);
    expect(execAsyncMock).toHaveBeenCalledWith(
      'tmux list-sessions -F "#{session_name}|#{session_attached}|#{@aumx_view_session}"',
      { silent: true },
    );
    expect(execAsyncMock).toHaveBeenCalledWith(
      "tmux kill-session -t '=aumx-demo--view-pane-1'",
      { silent: true },
    );
    expect(execAsyncMock).not.toHaveBeenCalledWith(
      "tmux kill-session -t '=aumx-demo--view-pane-2'",
      expect.anything(),
    );
    expect(execAsyncMock).not.toHaveBeenCalledWith(
      "tmux kill-session -t '=user-session--view-main'",
      expect.anything(),
    );
  });

  it('generates bounded tmux-safe view session names', () => {
    expect(makeTerminalPtyViewSessionName('aumx-demo', 'pane 1 / strange')).toBe('aumx-demo--view-pane-1-strange');
    expect(makeTerminalPtyViewSessionName('aumx-demo', 'x'.repeat(120)).length).toBeLessThanOrEqual(80);
    expect(makeTerminalPtyViewSessionName('s'.repeat(120), 'x'.repeat(120)).length).toBeLessThanOrEqual(80);
    expect(isTerminalPtyViewSessionName('aumx-demo--view-pane-1')).toBe(true);
    expect(isTerminalPtyViewSessionName('aumx-demo')).toBe(false);
  });

  it('still recognizes legacy stream-suffixed view session names from older builds so the boot reaper can reap them', () => {
    expect(isTerminalPtyViewSessionName('aumx-demo--view-pane-1')).toBe(true);
    expect(isTerminalPtyViewSessionName('aumx-demo--view-pane-1-44')).toBe(true);
    expect(isTerminalPtyViewSessionName('aumx-demo--view-pane-1-9007199254740991')).toBe(true);
  });
});
