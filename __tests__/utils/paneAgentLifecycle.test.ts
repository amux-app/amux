import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resumeAgentInPane } from '../../src/utils/paneAgentLifecycle.js';

const mockTmuxInstance = vi.hoisted(() => ({
  getPaneCurrentCommand: vi.fn(),
  respawnPane: vi.fn(),
}));
const assertClaudeFullscreenSupported = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/LogService.js', () => ({
  LogService: {
    getInstance: () => ({
      info: vi.fn(),
    }),
  },
}));

vi.mock('../../src/services/TmuxService.js', () => ({
  TmuxService: {
    getInstance: () => mockTmuxInstance,
  },
}));

vi.mock('../../src/utils/agentLaunch.js', () => ({
  claudeUsesFullscreen: (settings: { claudeFullscreenRendering?: boolean }) =>
    settings.claudeFullscreenRendering === true,
  getOpencodeTuiCommand: (scrollbackMode: boolean | undefined) =>
    scrollbackMode === true ? 'opencode --mini' : 'opencode',
  getPermissionFlags: vi.fn(() => ''),
}));

vi.mock('../../src/utils/agentTerminalEnvironment.js', () => ({
  CLAUDE_ENV_UNSETS: ['TMUX'] as const,
  withHiddenAgentTerminalEnvironment: vi.fn(
    (command: string, extraEnv?: Record<string, string>, extraUnsets?: readonly string[]) => {
      const unsets = (extraUnsets ?? []).map((name) => `-u ${name}`).join(' ');
      const env = Object.entries(extraEnv ?? {})
        .map(([name, value]) => `${name}=${value}`)
        .join(' ');
      return `hidden(${[unsets, env, command].filter(Boolean).join(' ')})`;
    },
  ),
  withInteractiveShellAfterCommand: vi.fn((command: string) => `shell(${command})`),
}));

vi.mock('../../src/utils/autoApproveTrustPrompt.js', () => ({
  autoApproveTrustPrompt: vi.fn(async () => undefined),
}));

vi.mock('../../src/utils/agentDetection.js', () => ({
  findPiCommand: vi.fn(async () => '/verified/pi'),
}));

vi.mock('../../src/utils/claudeVersion.js', () => ({
  assertClaudeFullscreenSupported,
}));

describe('resumeAgentInPane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertClaudeFullscreenSupported.mockResolvedValue({ command: '/usr/bin/claude', version: [2, 1, 220] });
    mockTmuxInstance.getPaneCurrentCommand.mockResolvedValue('bash');
    mockTmuxInstance.respawnPane.mockResolvedValue(undefined);
  });

  it('resumes a persisted OpenCode session in the standard interface by default', async () => {
    // Arrange
    const settings = { permissionMode: 'auto' as const };

    // Act
    await resumeAgentInPane('%1', 'opencode', settings, 'ses_123');

    // Assert
    expect(mockTmuxInstance.respawnPane).toHaveBeenCalledWith({
      command: expect.stringContaining("opencode --session 'ses_123'"),
      paneId: '%1',
    });
  });

  it('resumes the latest OpenCode session in the standard interface by default', async () => {
    // Arrange
    const settings = { permissionMode: '' as const };

    // Act
    await resumeAgentInPane('%1', 'opencode', settings);

    // Assert
    expect(mockTmuxInstance.respawnPane).toHaveBeenCalledWith({
      command: expect.stringContaining('opencode --continue'),
      paneId: '%1',
    });
  });

  it('resumes OpenCode in the mini interface when scrollback-friendly mode is enabled', async () => {
    // Arrange
    const settings = {
      permissionMode: 'auto' as const,
      opencodeScrollbackMode: true,
    };

    // Act
    await resumeAgentInPane('%1', 'opencode', settings, 'ses_123');

    // Assert
    expect(mockTmuxInstance.respawnPane).toHaveBeenCalledWith({
      command: expect.stringContaining("opencode --mini --session 'ses_123'"),
      paneId: '%1',
    });
  });

  it('unsets TMUX when resuming Claude so it keeps its truecolor brand palette', async () => {
    // Arrange
    const settings = { permissionMode: 'auto' as const };

    // Act
    await resumeAgentInPane('%1', 'claude', settings, 'sess_abc');

    // Assert
    const command = mockTmuxInstance.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(command).toContain('-u TMUX');
    expect(command).toContain('--resume');
    expect(command).toContain('-u CLAUDE_CODE_NO_FLICKER');
    expect(command).toContain('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1');
  });

  it('injects CLAUDE_CODE_NO_FLICKER from the persisted fullscreen renderer', async () => {
    // Arrange: current settings may have changed since this pane was created.
    const settings = { permissionMode: 'auto' as const, claudeFullscreenRendering: false };

    // Act
    await resumeAgentInPane('%1', 'claude', settings, 'sess_abc', 'fullscreen');

    // Assert
    const command = mockTmuxInstance.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(command).toContain('-u TMUX');
    expect(command).toContain('CLAUDE_CODE_NO_FLICKER=1');
    expect(command).toContain('-u CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN');
  });

  it('rejects an unsupported direct fullscreen resume before reading or mutating tmux', async () => {
    assertClaudeFullscreenSupported.mockRejectedValueOnce(new Error('Update Claude'));

    await expect(resumeAgentInPane(
      '%1',
      'claude',
      { permissionMode: 'auto' },
      'sess_abc',
      'fullscreen',
    )).rejects.toThrow('Update Claude');

    expect(mockTmuxInstance.getPaneCurrentCommand).not.toHaveBeenCalled();
    expect(mockTmuxInstance.respawnPane).not.toHaveBeenCalled();
  });

  it('keeps a persisted classic Claude resume inline when the current default is fullscreen', async () => {
    const settings = { permissionMode: 'auto' as const, claudeFullscreenRendering: true };

    await resumeAgentInPane('%1', 'claude', settings, 'sess_abc', 'classic');

    const command = mockTmuxInstance.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(command).toContain('-u TMUX');
    expect(command).toContain('-u CLAUDE_CODE_NO_FLICKER');
    expect(command).toContain('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1');
  });

  it('does not unset TMUX when resuming Codex', async () => {
    // Arrange
    const settings = { permissionMode: 'auto' as const };

    // Act
    await resumeAgentInPane('%1', 'codex', settings, 'sess_abc');

    // Assert
    const command = mockTmuxInstance.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(command).not.toContain('-u TMUX');
    expect(command).toContain('codex --no-alt-screen resume');
    expect(command).toContain('AUMX_ACTIVITY_JOURNAL=');
    expect(command).toContain('AUMX_PANE_ID=%1');
    expect(command).toContain('AUMX_PANE_INCARNATION_ID=');
  });

  it('resumes a persisted Pi session by id', async () => {
    await resumeAgentInPane('%1', 'pi', { permissionMode: 'auto' }, '019fd282-216d');

    expect(mockTmuxInstance.respawnPane).toHaveBeenCalledWith({
      command: expect.stringContaining("'/verified/pi' --session '019fd282-216d'"),
      paneId: '%1',
    });
  });

  it('continues the latest Pi session when no id is provided', async () => {
    await resumeAgentInPane('%1', 'pi', { permissionMode: 'auto' });

    expect(mockTmuxInstance.respawnPane).toHaveBeenCalledWith({
      command: expect.stringContaining("'/verified/pi' --continue"),
      paneId: '%1',
    });
  });

  it('forks a selected Pi session when the destination is a new worktree', async () => {
    await resumeAgentInPane(
      '%1',
      'pi',
      { permissionMode: 'auto' },
      '019fd282-216d',
      undefined,
      { piSessionMode: 'fork' },
    );

    expect(mockTmuxInstance.respawnPane).toHaveBeenCalledWith({
      command: expect.stringContaining("'/verified/pi' --fork '019fd282-216d'"),
      paneId: '%1',
    });
  });

  it('forks a selected Pi session by its resolved source file', async () => {
    await resumeAgentInPane(
      '%1',
      'pi',
      { permissionMode: 'auto' },
      '019fd282-216d',
      undefined,
      {
        piSessionMode: 'fork',
        piSessionPath: '/project/.pi-sessions/source.jsonl',
      },
    );

    expect(mockTmuxInstance.respawnPane).toHaveBeenCalledWith({
      command: expect.stringContaining("'/verified/pi' --fork '/project/.pi-sessions/source.jsonl'"),
      paneId: '%1',
    });
  });
});
