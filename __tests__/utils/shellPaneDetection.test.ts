import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ExecAsyncModule = typeof import('../../src/utils/execAsync.js');

const execFileAsync = vi.fn<ExecAsyncModule['execFileAsync']>();

vi.mock('../../src/utils/execAsync.js', async (importOriginal) => {
  const actual = await importOriginal<ExecAsyncModule>();
  return { ...actual, execFileAsync };
});

vi.mock('../../src/services/TmuxService.js', () => ({
  TmuxService: { getInstance: () => ({ setPaneTitle: vi.fn().mockResolvedValue(undefined) }) },
}));

const { createShellPane, detectShellType } = await import('../../src/utils/shellPaneDetection.js');
const { execFileAsync: realExecFileAsync } = await vi.importActual<ExecAsyncModule>('../../src/utils/execAsync.js');

const HOSTILE_PANE_ID = "%1'; touch /tmp/muxbase-injected; echo '";

describe('shellPaneDetection command construction', () => {
  beforeEach(() => {
    execFileAsync.mockReset();
    execFileAsync.mockImplementation(async (file, args) => {
      if (file === 'tmux' && args.includes('#{pane_current_command}')) return 'vim';
      if (file === 'tmux' && args.includes('#{pane_pid}')) return '4242';
      if (file === 'ps' && args.includes('ppid=')) return '4200';
      if (file === 'ps' && args.includes('comm=')) return '/bin/zsh';
      return '';
    });
  });

  it('passes a hostile pane id to tmux as a literal argv entry', async () => {
    // Arrange / Act
    const shellType = await detectShellType(HOSTILE_PANE_ID);

    // Assert
    expect(shellType).toBe('zsh');
    expect(execFileAsync).toHaveBeenCalledWith(
      'tmux',
      ['display-message', '-t', HOSTILE_PANE_ID, '-p', '#{pane_current_command}'],
      expect.objectContaining({ silent: true }),
    );
    expect(execFileAsync).toHaveBeenCalledWith(
      'tmux',
      ['display-message', '-t', HOSTILE_PANE_ID, '-p', '#{pane_pid}'],
      expect.objectContaining({ silent: true }),
    );
  });

  it('never builds a shell string from pane ids or process ids', async () => {
    // Arrange / Act
    await createShellPane(HOSTILE_PANE_ID, 7);

    // Assert
    const calls = execFileAsync.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [file, args] of calls) {
      expect(['tmux', 'ps']).toContain(file);
      expect(args.some(arg => arg.includes(';') && arg !== HOSTILE_PANE_ID)).toBe(false);
    }
  });

  it('reads the pane path with the hostile id kept literal', async () => {
    // Arrange / Act
    await createShellPane(HOSTILE_PANE_ID, 7);

    // Assert
    expect(execFileAsync).toHaveBeenCalledWith(
      'tmux',
      ['display-message', '-t', HOSTILE_PANE_ID, '-p', '#{pane_current_path}'],
      expect.objectContaining({ silent: true }),
    );
  });
});

describe('execFileAsync literal argument execution', () => {
  it('treats shell metacharacters in an argument as data', async () => {
    // Arrange
    const sentinel = join(tmpdir(), `muxbase-shell-injection-${process.pid}.txt`);
    rmSync(sentinel, { force: true });
    const hostileArgument = `%1'; touch ${sentinel}; echo '`;

    // Act
    const output = await realExecFileAsync('printf', ['%s', hostileArgument]);

    // Assert
    expect(output).toBe(hostileArgument);
    expect(existsSync(sentinel)).toBe(false);
  });
});
