import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerTerminalHandlers } from '../../src/main/ipc/terminal.handlers';
import { IPC } from '../../src/shared/ipc-channels';

const attachMock = vi.hoisted(() => vi.fn());
const getTerminalManagerMock = vi.hoisted(() => vi.fn());
const resizeMock = vi.hoisted(() => vi.fn());
const secureHandleMock = vi.hoisted(() => vi.fn());
const setWindowMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/main/ipc/ipc-security.js', () => ({
  secureHandle: (channel: string, handler: unknown) => secureHandleMock(channel, handler),
}));

vi.mock('../../src/main/services/TerminalStreamService.js', () => ({
  getTerminalManager: getTerminalManagerMock,
}));

vi.mock('../../src/main/services/terminal-pane-dimensions.js', () => ({
  isTerminalPaneMissingError: vi.fn(() => false),
}));

const getLogDirMock = vi.hoisted(() => vi.fn<() => string | null>(() => null));

vi.mock('../../src/main/services/Logger.js', () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    getLogDir: getLogDirMock,
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const registration = secureHandleMock.mock.calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!registration) throw new Error(`missing handler registration for ${channel}`);
  return registration[1] as (...args: unknown[]) => unknown;
}

describe('terminal IPC handlers', () => {
  beforeEach(() => {
    attachMock.mockReset().mockResolvedValue({
      cols: 120,
      mode: 'pty',
      rows: 36,
      streamId: 77,
    });
    getTerminalManagerMock.mockReset().mockReturnValue({
      attach: attachMock,
      resize: resizeMock,
      setWindow: setWindowMock,
    });
    resizeMock.mockReset().mockResolvedValue(undefined);
    getLogDirMock.mockReset().mockReturnValue('/project/.log');
    secureHandleMock.mockClear();
    setWindowMock.mockClear();
  });

  it('uses the bridge session name for terminal attach even if the renderer sends stale state', async () => {
    // Arrange
    const bridge = {
      getPanes: () => [{
        agent: 'claude',
        claudeRenderer: 'classic',
        id: 'pane-1',
        paneId: '%9',
        terminalFixedCols: 100,
        terminalTranscriptPath: '/project/.log/terminal/tmux-9-shell-1.ansi',
      }],
      getSessionName: () => 'aumx-current-project',
      getWindow: () => ({ id: 1 }),
    };
    registerTerminalHandlers(bridge as never);

    // Act
    const result = await getHandler(IPC.TERMINAL_ATTACH)(undefined, {
      cols: 80,
      fixedCols: 80,
      paneId: 'pane-1',
      rows: 24,
      sessionName: 'aumx-stale-renderer-project',
      skipScrollbackReplay: true,
      streamId: 77,
      transcriptPath: '/project/.log/terminal/tmux-9-shell-1.ansi',
    });

    // Assert
    expect(result).toEqual({
      cols: 120,
      mode: 'pty',
      rows: 36,
      streamId: 77,
      success: true,
    });
    expect(setWindowMock).toHaveBeenCalledWith({ id: 1 });
    expect(attachMock).toHaveBeenCalledWith(
      'pane-1',
      'aumx-current-project',
      '%9',
      '/project/.log/terminal/tmux-9-shell-1.ansi',
      { cols: 80, rows: 24 },
      true,
      77,
      100,
      undefined,
    );
  });

  it('derives fullscreen mouse policy from canonical pane state', async () => {
    const bridge = {
      getPanes: () => [{
        agent: 'claude',
        claudeRenderer: 'fullscreen',
        id: 'pane-1',
        paneId: '%9',
      }],
      getSessionName: () => 'aumx-current-project',
      getWindow: () => ({ id: 1 }),
    };
    registerTerminalHandlers(bridge as never);

    await getHandler(IPC.TERMINAL_ATTACH)(undefined, {
      paneId: 'pane-1',
      sessionName: 'renderer-controlled',
      enableMouse: false,
    });

    expect(attachMock.mock.calls[0][8]).toBe(true);
  });

  it('rejects mixed fullscreen and fixed-column pane metadata', async () => {
    const bridge = {
      getPanes: () => [{
        agent: 'claude',
        claudeRenderer: 'fullscreen',
        id: 'pane-1',
        paneId: '%9',
        terminalFixedCols: 100,
      }],
      getSessionName: () => 'aumx-current-project',
      getWindow: () => ({ id: 1 }),
    };
    registerTerminalHandlers(bridge as never);

    const result = await getHandler(IPC.TERMINAL_ATTACH)(undefined, { paneId: 'pane-1' });

    expect(result).toEqual({
      error: 'Invalid persisted Claude terminal profile',
      success: false,
    });
    expect(attachMock).not.toHaveBeenCalled();
  });

  it.each([
    ['classic Claude', { agent: 'claude', claudeRenderer: 'classic', terminalFixedCols: 100 }],
    ['Codex', { agent: 'codex' }],
    ['OpenCode', { agent: 'opencode' }],
    ['shell', { type: 'shell' }],
  ])('does not apply fullscreen mouse policy to %s', async (_label, paneFields) => {
    const bridge = {
      getPanes: () => [{ ...paneFields, id: 'pane-1', paneId: '%9' }],
      getSessionName: () => 'aumx-current-project',
      getWindow: () => ({ id: 1 }),
    };
    registerTerminalHandlers(bridge as never);

    await getHandler(IPC.TERMINAL_ATTACH)(undefined, { paneId: 'pane-1' });

    expect(attachMock.mock.calls[0][8]).toBeUndefined();
  });

  it('rejects a renderer supplied transcript path outside the pane state', async () => {
    // Arrange
    const bridge = {
      getPanes: () => [{
        id: 'pane-1',
        paneId: '%9',
        terminalTranscriptPath: '/project/.log/terminal/tmux-9-shell-1.ansi',
      }],
      getSessionName: () => 'aumx-current-project',
      getWindow: () => ({ id: 1 }),
    };
    registerTerminalHandlers(bridge as never);

    // Act
    await getHandler(IPC.TERMINAL_ATTACH)(undefined, {
      paneId: 'pane-1',
      sessionName: 'aumx-current-project',
      transcriptPath: '/etc/hosts',
    });

    // Assert
    expect(attachMock.mock.calls[0][3]).toBe('/project/.log/terminal/tmux-9-shell-1.ansi');
  });

  it('falls back to the renderer transcript path inside the transcript root while pane state lags', async () => {
    // Arrange
    const bridge = {
      getPanes: () => [{ id: 'pane-1', paneId: '%9' }],
      getSessionName: () => 'aumx-current-project',
      getWindow: () => ({ id: 1 }),
    };
    registerTerminalHandlers(bridge as never);

    // Act
    await getHandler(IPC.TERMINAL_ATTACH)(undefined, {
      paneId: 'pane-1',
      sessionName: 'aumx-current-project',
      transcriptPath: '/project/.log/terminal/tmux-9-shell-1.ansi',
    });
    await getHandler(IPC.TERMINAL_ATTACH)(undefined, {
      paneId: 'pane-1',
      sessionName: 'aumx-current-project',
      transcriptPath: '/project/.log/terminal/../../../etc/hosts',
    });

    // Assert
    expect(attachMock.mock.calls[0][3]).toBe('/project/.log/terminal/tmux-9-shell-1.ansi');
    expect(attachMock.mock.calls[1][3]).toBeUndefined();
  });

  it('attaches with the tmux pane id held in main state, ignoring any renderer supplied value', async () => {
    // Arrange
    const bridge = {
      getPanes: () => [{ id: 'pane-1', paneId: '%12' }],
      getSessionName: () => 'aumx-current-project',
      getWindow: () => ({ id: 1 }),
    };
    registerTerminalHandlers(bridge as never);

    // Act
    const result = await getHandler(IPC.TERMINAL_ATTACH)(undefined, {
      paneId: 'pane-1',
      sessionName: 'aumx-current-project',
      tmuxPaneId: '%3',
    });

    // Assert
    expect(result).toMatchObject({ success: true });
    expect(attachMock.mock.calls[0][2]).toBe('%12');
  });

  it('rejects a terminal attach for a pane id that is not in main state', async () => {
    // Arrange
    const bridge = {
      getPanes: () => [{ id: 'pane-1', paneId: '%1' }],
      getSessionName: () => 'aumx-current-project',
      getWindow: () => ({ id: 1 }),
    };
    registerTerminalHandlers(bridge as never);

    // Act
    const result = await getHandler(IPC.TERMINAL_ATTACH)(undefined, {
      paneId: 'pane-9',
      sessionName: 'aumx-current-project',
    });

    // Assert
    expect(result).toEqual({ error: 'Unauthorized terminal pane', success: false });
    expect(attachMock).not.toHaveBeenCalled();
  });

  it('does not trust an out-of-root transcript path persisted in pane state', async () => {
    // Arrange
    const bridge = {
      getPanes: () => [{ id: 'pane-1', paneId: '%9', terminalTranscriptPath: '/etc/hosts' }],
      getSessionName: () => 'aumx-current-project',
      getWindow: () => ({ id: 1 }),
    };
    registerTerminalHandlers(bridge as never);

    // Act
    await getHandler(IPC.TERMINAL_ATTACH)(undefined, {
      paneId: 'pane-1',
      sessionName: 'aumx-current-project',
      transcriptPath: '/etc/hosts',
    });

    // Assert
    expect(attachMock.mock.calls[0][3]).toBeUndefined();
  });

  it('reports PTY resize failures instead of acknowledging mismatched geometry', async () => {
    const bridge = {
      getPanes: () => [],
      getSessionName: () => 'aumx-current-project',
      getWindow: () => ({ id: 1 }),
    };
    resizeMock.mockRejectedValue(new Error('tmux geometry mismatch'));
    registerTerminalHandlers(bridge as never);

    const result = await getHandler(IPC.TERMINAL_RESIZE)(undefined, {
      cols: 100,
      paneId: 'pane-1',
      rows: 30,
    });

    expect(result).toEqual({
      error: 'tmux geometry mismatch',
      success: false,
    });
  });
});
