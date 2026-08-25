import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execAsync } from 'muxbase/core';
import { ensureTmuxSession } from '../../src/main/utils/tmuxSession';
import type { ThemeMode } from '../../src/shared/theme-mode';

const execAsyncMock = vi.hoisted(() => vi.fn());
const terminalTheme = vi.hoisted(() => ({ mode: 'dark' as ThemeMode }));

vi.mock('muxbase/core', () => ({
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
      if (command.includes('list-sessions')) return Promise.resolve('muxbase-example-rag\n');
      if (command.includes('has-session')) return Promise.resolve('');
      if (command.includes('@muxbase_project_root')) {
        return Promise.resolve('@muxbase_project_root /Users/me/projects/example-rag');
      }
      if (command.includes('list-panes')) return Promise.resolve('%7');
      return Promise.resolve('');
    });

    // Act
    const result = await ensureTmuxSession(
      'muxbase-example-rag',
      '/Users/me/projects/example-rag',
      'example-rag',
    );

    // Assert
    expect(result).toEqual({
      created: false,
      paneId: '%7',
      sessionName: 'muxbase-example-rag',
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
      "tmux set-environment -t 'muxbase-example-rag' -r NO_COLOR",
      { silent: true },
    );
    expect(execAsync).toHaveBeenCalledWith(
      "tmux set-environment -t 'muxbase-example-rag' COLORTERM 'truecolor'",
      { silent: true },
    );
    expect(execAsync).toHaveBeenCalledWith(
      "tmux set-environment -t 'muxbase-example-rag' COLORFGBG '15;0'",
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
    await ensureTmuxSession('muxbase-example-rag', '/Users/me/projects/example-rag', 'example-rag');

    // Assert
    expect(execAsync).toHaveBeenCalledWith(
      "tmux set-environment -t 'muxbase-example-rag' COLORFGBG '0;15'",
      { silent: true },
    );
  });

  it('allocates a suffix when the desired session belongs to another project', async () => {
    let listCalls = 0;
    execAsyncMock.mockImplementation((command: string) => {
      if (command.includes('list-sessions')) {
        listCalls += 1;
        return Promise.resolve(listCalls === 1 ? 'muxbase-example-rag\n' : 'muxbase-example-rag\nmuxbase-example-rag_01\n');
      }
      if (command.includes('@muxbase_project_root')) return Promise.resolve('@muxbase_project_root /other/project');
      if (command.includes('has-session')) return Promise.resolve('');
      if (command.includes('new-session')) return Promise.resolve('%2\n');
      return Promise.resolve('');
    });

    await expect(ensureTmuxSession('muxbase-example-rag', '/repo', 'repo')).resolves.toEqual({
      created: true,
      paneId: '%2',
      sessionName: 'muxbase-example-rag_02',
    });
  });

  it('recreates a project-owned session that has no panes', async () => {
    execAsyncMock.mockImplementation((command: string) => {
      if (command.includes('list-sessions')) return Promise.resolve('muxbase-example-rag\n');
      if (command.includes('@muxbase_project_root')) return Promise.resolve('@muxbase_project_root /repo');
      if (command.includes('list-panes')) return Promise.resolve('');
      if (command.includes('new-session')) return Promise.resolve('%8\n');
      return Promise.resolve('');
    });

    await expect(ensureTmuxSession('muxbase-example-rag', '/repo', 'repo')).resolves.toMatchObject({
      created: true,
      paneId: '%8',
      sessionName: 'muxbase-example-rag',
    });
    expect(execAsyncMock).toHaveBeenCalledWith("tmux kill-session -t 'muxbase-example-rag'", { silent: true });
  });

  it('still creates a session when session listing is unavailable', async () => {
    execAsyncMock.mockImplementation((command: string) => {
      if (command.includes('list-sessions') || command.includes('has-session')) {
        return Promise.reject(new Error('tmux unavailable'));
      }
      if (command.includes('new-session')) return Promise.resolve('%3\n');
      return Promise.resolve('');
    });

    await expect(ensureTmuxSession('muxbase-new', '/repo', 'repo')).resolves.toEqual({
      created: true,
      paneId: '%3',
      sessionName: 'muxbase-new',
    });
  });

  it('fails clearly after exhausting all suffixes', async () => {
    let listCalls = 0;
    execAsyncMock.mockImplementation((command: string) => {
      if (command.includes('list-sessions')) {
        listCalls += 1;
        const sessions = [
          'muxbase-full',
          ...Array.from({ length: 99 }, (_, index) => `muxbase-full_${String(index + 1).padStart(2, '0')}`),
        ];
        return Promise.resolve(sessions.join('\n'));
      }
      if (command.includes('@muxbase_project_root')) return Promise.resolve('@muxbase_project_root /other');
      if (command.includes('has-session')) return Promise.resolve('');
      return Promise.resolve('');
    });

    await expect(ensureTmuxSession('muxbase-full', '/repo', 'repo'))
      .rejects.toThrow("No available session name for 'muxbase-full'");
    expect(listCalls).toBe(2);
  });

  it('does not hide a created session when metadata or environment setup fails', async () => {
    execAsyncMock.mockImplementation((command: string) => {
      if (command.includes('list-sessions') || command.includes('has-session'))
        return Promise.reject(new Error('not available'));
      if (command.includes('new-session')) return Promise.resolve('%4\n');
      return Promise.reject(new Error('metadata failed'));
    });

    await expect(ensureTmuxSession('muxbase-created', '/repo', 'repo')).resolves.toEqual({
      created: true,
      paneId: '%4',
      sessionName: 'muxbase-created',
    });
  });
});
