import { describe, expect, it } from 'vitest';
import { LogService } from '../../src/services/LogService.js';
import type { RetryStrategy } from '../../src/services/tmux-retry.js';
import { TmuxWriteOperations } from '../../src/services/tmux-write-operations.js';
import { shQuote } from '../../src/utils/shellEscape.js';

class TestTmuxWriteOperations extends TmuxWriteOperations {
  protected logger = LogService.getInstance();
  readonly commands: string[] = [];

  protected execute(command: string): string {
    this.commands.push(command);
    return '';
  }

  protected async executeWithRetry<T>(
    operation: () => T,
    _strategy?: RetryStrategy,
    _context?: string,
  ): Promise<T> {
    return operation();
  }
}

describe('TmuxWriteOperations', () => {
  it('passes hostile pane titles and targets to tmux as literal values', async () => {
    // Arrange
    const tmux = new TestTmuxWriteOperations();
    const paneId = "%1'; display-message 'unexpected";
    const title = "R&D's pane ; display-message unexpected 🚀";

    // Act
    await tmux.setPaneTitle(paneId, title);

    // Assert
    expect(tmux.commands).toEqual([
      `tmux select-pane -t ${shQuote(paneId)} -T ${shQuote(title)}`,
    ]);
  });

  it('quotes hostile pane titles in the synchronous sink too', () => {
    // Arrange
    const tmux = new TestTmuxWriteOperations();
    const paneId = "%2'; display-message 'unexpected";
    const title = "Unicode π title's value ; next-command";

    // Act
    tmux.setPaneTitleSync(paneId, title);

    // Assert
    expect(tmux.commands).toEqual([
      `tmux select-pane -t ${shQuote(paneId)} -T ${shQuote(title)}`,
    ]);
  });

  it('quotes respawn-pane target, cwd, and command safely', async () => {
    // Arrange
    const tmux = new TestTmuxWriteOperations();

    // Act
    await tmux.respawnPane({
      command: "echo 'hello'",
      cwd: '/tmp/muxbase worktree',
      paneId: '%1',
    });

    // Assert
    expect(tmux.commands).toEqual([
      "tmux respawn-pane -k -t '%1' -c '/tmp/muxbase worktree' 'echo '\\''hello'\\'''",
    ]);
  });
});
