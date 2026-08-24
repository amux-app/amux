import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execAsync } from 'aumx/core';
import { ensureTmuxSession } from '../../src/main/utils/tmuxSession';
import type { ThemeMode } from '../../src/shared/theme-mode';

const execAsyncMock = vi.hoisted(() => vi.fn());
const terminalTheme = vi.hoisted(() => ({ mode: 'dark' as ThemeMode }));

vi.mock('aumx/core', () => ({
  AGENT_TERMINAL_ENVIRONMENT: [
    ['TERM', 'tmux-256color'],
    ['COLORTERM', 'truecolor'],
    ['CLICOLOR', '1'],
    ['FORCE_COLOR', '1'],
    ['CLICOLOR_FORCE', '1'],
  ],
  AGENT_TERMINAL_ENV_UNSETS: ['NO_COLOR'],
  execAsync: execAsyncMock,
  shQuote: (value: string) => `'${value}'`,
}));

vi.mock('../../src/main/services/app-theme.js', () => ({
  getTerminalThemeMode: () => terminalTheme.mode,
}));

vi.mock('../../src/main/services/Logger.js', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

describe('ensureTmuxSession', () => {
  beforeEach(() => {
    execAsyncMock.mockReset();
    terminalTheme.mode = 'dark';
  });

  it('reuses a session when tmux show returns the option name with the value', async () => {
    // Arrange
    execAsyncMock.mockImplementation((command: string) => {
      if (command.includes('list-sessions')) return Promise.resolve('aumx-example-rag\n');
      if (command.includes('has-session')) return Promise.resolve('');
      if (command.includes('@aumx_project_root')) {
        return Promise.resolve('@aumx_project_root /Users/me/projects/example-rag');
      }
      if (command.includes('list-panes')) return Promise.resolve('%7');
      return Promise.resolve('');
    });

    // Act
    const result = await ensureTmuxSession(
      'aumx-example-rag',
      '/Users/me/projects/example-rag',
      'example-rag',
    );

    // Assert
    expect(result).toEqual({
      created: false,
      paneId: '%7',
      sessionName: 'aumx-example-rag',
    });
    expect(execAsync).toHaveBeenNthCalledWith(
      1,
      'tmux list-sessions -F "#{session_name}"',
      { silent: true },
    );
    expect(execAsync).not.toHaveBeenCalledWith(
      expect.stringContaining('new-session'),
      expect.anything(),
    );
    expect(execAsync).toHaveBeenCalledWith(
      "tmux set-environment -t 'aumx-example-rag' -r NO_COLOR",
      { silent: true },
    );
    expect(execAsync).toHaveBeenCalledWith(
      "tmux set-environment -t 'aumx-example-rag' COLORTERM 'truecolor'",
      { silent: true },
    );
    expect(execAsync).toHaveBeenCalledWith(
      "tmux set-environment -t 'aumx-example-rag' COLORFGBG '15;0'",
      { silent: true },
    );
  });

  it('publishes the light COLORFGBG hint to the session agents inherit', async () => {
    // Arrange
    terminalTheme.mode = 'light';
    execAsyncMock.mockImplementation((command: string) => {
      if (command.includes('list-sessions')) return Promise.resolve('');
      if (command.includes('has-session')) return Promise.reject(new Error('no session'));
      if (command.includes('new-session')) return Promise.resolve('%1\n');
      return Promise.resolve('');
    });

    // Act
    await ensureTmuxSession('aumx-example-rag', '/Users/me/projects/example-rag', 'example-rag');

    // Assert
    expect(execAsync).toHaveBeenCalledWith(
      "tmux set-environment -t 'aumx-example-rag' COLORFGBG '0;15'",
      { silent: true },
    );
  });
});
