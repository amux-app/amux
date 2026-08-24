import { describe, expect, it } from 'vitest';
import {
  AGENT_TERMINAL_ENVIRONMENT,
  AGENT_TERMINAL_ENV_UNSETS,
  withAgentTerminalEnvironment,
  withHiddenAgentTerminalEnvironment,
  withInteractiveShellAfterCommand,
} from '../src/utils/agentTerminalEnvironment.js';

describe('agentTerminalEnvironment', () => {
  it('launches agents with a color-capable terminal environment', () => {
    // Arrange / Act
    const command = withAgentTerminalEnvironment('claude --permission-mode auto');

    // Assert
    expect(command).toBe(
      'env -u NO_COLOR TERM=tmux-256color COLORTERM=truecolor CLICOLOR=1 FORCE_COLOR=1 CLICOLOR_FORCE=1 claude --permission-mode auto',
    );
  });

  it('emits -u for each extra unset after the shared unsets', () => {
    // Arrange / Act
    const command = withAgentTerminalEnvironment('claude', undefined, ['TMUX']);

    // Assert
    expect(command).toContain('env -u NO_COLOR -u TMUX TERM=tmux-256color');
  });

  it('keeps the tmux session environment repair list aligned with launch commands', () => {
    // Arrange / Act / Assert
    expect(AGENT_TERMINAL_ENV_UNSETS).toEqual(['NO_COLOR']);
    expect(AGENT_TERMINAL_ENVIRONMENT).toEqual([
      ['TERM', 'tmux-256color'],
      ['COLORTERM', 'truecolor'],
      ['CLICOLOR', '1'],
      ['FORCE_COLOR', '1'],
      ['CLICOLOR_FORCE', '1'],
    ]);
  });

  it('hides the launch wrapper from the pane before the agent takes over', () => {
    // Arrange / Act
    const command = withHiddenAgentTerminalEnvironment('claude --permission-mode auto');

    // Assert
    expect(command).toContain('sh -c');
    expect(command).toContain('printf');
    expect(command).toContain('exec env -u NO_COLOR');
    expect(command).toContain('claude --permission-mode auto');
  });

  it('keeps the fallback shell wrapper inside a POSIX shell command', () => {
    // Arrange / Act
    const command = withInteractiveShellAfterCommand('claude');

    // Assert
    expect(command).toMatch(/^sh -c /);
    expect(command).toContain('claude');
    expect(command).toContain('exec "${SHELL:-/bin/sh}"');
  });

  it('exports pane environment into the fallback shell wrapper', () => {
    // Arrange / Act
    const command = withInteractiveShellAfterCommand('claude', { AUMX_PANE_ID: 'aumx-123' });

    // Assert
    expect(command).toContain('export AUMX_PANE_ID=');
    expect(command).toContain('aumx-123');
    expect(command).toContain('claude');
    expect(command).toContain('exec "${SHELL:-/bin/sh}"');
  });

  it('runs fallback shell setup before handing control to the user shell', () => {
    // Arrange / Act
    const command = withInteractiveShellAfterCommand('claude', { AUMX_PANE_ID: 'aumx-123' }, 'export PATH=/tmp/aumx:"$PATH"');

    // Assert
    expect(command).toContain('claude; export PATH=/tmp/aumx:"$PATH"; exec "${SHELL:-/bin/sh}"');
  });
});
