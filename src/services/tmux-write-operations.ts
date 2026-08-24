import { shQuote } from '../utils/shellEscape.js';
import { RetryStrategy } from './tmux-retry.js';
import { TmuxSyncOperations } from './tmux-sync-operations.js';

export abstract class TmuxWriteOperations extends TmuxSyncOperations {
  protected abstract executeNonBlocking(
    command: string,
    options?: { silent?: boolean; timeout?: number },
  ): Promise<string>;

  protected abstract executeWithRetry<T>(
    operation: () => T,
    strategy?: RetryStrategy,
    context?: string,
  ): Promise<T>;

  async splitPane(options: {
    targetPane?: string;
    cwd?: string;
    command?: string;
  } = {}): Promise<string> {
    return this.executeWithRetry(
      () => {
        let cmd = 'tmux split-window -h -P -F \'#{pane_id}\'';

        if (options.targetPane) {
          cmd += ` -t ${shQuote(options.targetPane)}`;
        }
        if (options.cwd) {
          cmd += ` -c ${shQuote(options.cwd)}`;
        }
        if (options.command) {
          cmd += ` ${shQuote(options.command)}`;
        }

        return this.execute(cmd);
      },
      RetryStrategy.FAST,
      'splitPane',
    );
  }

  async resizePane(paneId: string, dimensions: { width?: number; height?: number }): Promise<void> {
    await this.executeWithRetry(
      () => {
        if (dimensions.width !== undefined) {
          this.execute(`tmux resize-pane -t ${shQuote(paneId)} -x ${dimensions.width}`);
        }
        if (dimensions.height !== undefined) {
          this.execute(`tmux resize-pane -t ${shQuote(paneId)} -y ${dimensions.height}`);
        }
      },
      RetryStrategy.FAST,
      `resizePane(${paneId})`,
    );
  }

  async resizeWindow(dimensions: { width: number; height: number }): Promise<void> {
    await this.executeWithRetry(
      () => {
        this.execute(`tmux resize-window -x ${dimensions.width} -y ${dimensions.height}`);
      },
      RetryStrategy.FAST,
      'resizeWindow',
    );
  }

  async selectLayout(layoutString: string): Promise<void> {
    await this.executeWithRetry(
      () => {
        this.execute(`tmux select-layout ${shQuote(layoutString)}`);
      },
      RetryStrategy.FAST,
      'selectLayout',
    );
  }

  async setPaneTitle(paneId: string, title: string): Promise<void> {
    const target = shQuote(paneId);
    const literalTitle = shQuote(title);
    await this.executeWithRetry(
      () => {
        this.execute(`tmux select-pane -t ${target} -T ${literalTitle}`);
      },
      RetryStrategy.FAST,
      `setPaneTitle(${paneId})`,
    );
  }

  async selectPane(paneId: string): Promise<void> {
    await this.executeWithRetry(
      () => {
        this.execute(`tmux select-pane -t ${shQuote(paneId)}`);
      },
      RetryStrategy.FAST,
      `selectPane(${paneId})`,
    );
  }

  async setOption(option: string, value: string): Promise<void> {
    await this.executeWithRetry(
      () => {
        this.execute(`tmux set-option -g ${shQuote(option)} ${shQuote(value)}`);
      },
      RetryStrategy.FAST,
      `setOption(${option})`,
    );
  }

  async sendKeys(paneId: string, keys: string): Promise<void> {
    await this.executeWithRetry(
      () => {
        this.execute(`tmux send-keys -t ${shQuote(paneId)} ${keys}`);
      },
      RetryStrategy.FAST,
      `sendKeys(${paneId})`,
    );
  }

  async sendShellCommand(paneId: string, command: string): Promise<void> {
    const quotedCommand = shQuote(command);
    await this.executeWithRetry(
      () => {
        this.execute(`tmux send-keys -t ${shQuote(paneId)} -l -- ${quotedCommand}`);
      },
      RetryStrategy.FAST,
      `sendShellCommand(${paneId})`,
    );
  }

  async respawnPane(options: {
    command: string;
    cwd?: string;
    paneId: string;
  }): Promise<void> {
    const target = shQuote(options.paneId);
    const cwd = options.cwd ? ` -c ${shQuote(options.cwd)}` : '';
    const command = shQuote(options.command);
    await this.executeWithRetry(
      () => {
        this.execute(`tmux respawn-pane -k -t ${target}${cwd} ${command}`);
      },
      RetryStrategy.FAST,
      `respawnPane(${options.paneId})`,
    );
  }

  async sendTmuxKeys(paneId: string, keys: string): Promise<void> {
    await this.executeWithRetry(
      () => {
        this.execute(`tmux send-keys -t ${shQuote(paneId)} ${keys}`);
      },
      RetryStrategy.FAST,
      `sendTmuxKeys(${paneId})`,
    );
  }

  async setBuffer(bufferName: string, content: string): Promise<void> {
    await this.executeWithRetry(
      () => {
        this.execute(`tmux set-buffer -b ${shQuote(bufferName)} -- ${shQuote(content)}`);
      },
      RetryStrategy.FAST,
      `setBuffer(${bufferName})`,
    );
  }

  async loadBufferFromFile(bufferName: string, filePath: string): Promise<void> {
    await this.executeWithRetry(
      () => {
        this.execute(`tmux load-buffer -b ${shQuote(bufferName)} ${shQuote(filePath)}`);
      },
      RetryStrategy.FAST,
      `loadBufferFromFile(${bufferName})`,
    );
  }

  async pasteBuffer(bufferName: string, paneId: string): Promise<void> {
    await this.executeWithRetry(
      () => {
        this.execute(`tmux paste-buffer -b ${shQuote(bufferName)} -t ${shQuote(paneId)}`);
      },
      RetryStrategy.FAST,
      `pasteBuffer(${bufferName})`,
    );
  }

  async deleteBuffer(bufferName: string): Promise<void> {
    await this.executeWithRetry(
      () => {
        this.execute(`tmux delete-buffer -b ${shQuote(bufferName)}`);
      },
      RetryStrategy.FAST,
      `deleteBuffer(${bufferName})`,
    );
  }

  async refreshClient(): Promise<void> {
    try {
      await this.executeWithRetry(
        () => {
          this.execute('tmux refresh-client', { silent: true });
        },
        RetryStrategy.FAST,
        'refreshClient',
      );
    } catch {
      this.logger.debug('tmux refresh-client failed (non-critical)', 'debug');
    }
  }

  async killPane(paneId: string): Promise<void> {
    try {
      await this.executeWithRetry(
        () => {
          this.execute(`tmux kill-pane -t ${shQuote(paneId)}`);
        },
        RetryStrategy.NONE,
        `killPane(${paneId})`,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("can't find pane")) {
        this.logger.debug(`Pane ${paneId} already gone, treating as success`, 'killPane');
        return;
      }
      throw error;
    }
  }

  async killWindow(windowId: string): Promise<void> {
    await this.executeWithRetry(
      () => {
        this.execute(`tmux kill-window -t ${shQuote(windowId)}`);
      },
      RetryStrategy.NONE,
      `killWindow(${windowId})`,
    );
  }

  async newWindow(options: {
    name?: string;
    detached?: boolean;
  } = {}): Promise<string> {
    return this.executeWithRetry(
      () => {
        let cmd = 'tmux new-window';
        if (options.detached) {
          cmd += ' -d';
        }
        if (options.name) {
          cmd += ` -n ${shQuote(options.name)}`;
        }
        cmd += " -P -F '#{window_id}'";
        return this.execute(cmd);
      },
      RetryStrategy.FAST,
      'newWindow',
    );
  }

  async newWindowPane(options: {
    sessionName?: string;
    cwd?: string;
    name?: string;
  } = {}): Promise<string> {
    let command = "tmux new-window -d -P -F '#{pane_id}'";
    if (options.sessionName) command += ` -t ${shQuote(options.sessionName)}`;
    if (options.name) command += ` -n ${shQuote(options.name)}`;
    if (options.cwd) command += ` -c ${shQuote(options.cwd)}`;
    return this.executeNonBlocking(command);
  }

  async getPaneSessionName(paneId: string): Promise<string> {
    try {
      return await this.executeNonBlocking(
        `tmux display-message -t ${shQuote(paneId)} -p '#{session_name}'`,
      );
    } catch {
      this.logger.warn(`Failed to get session name for ${paneId}, returning empty string`, 'TmuxService');
      return '';
    }
  }

  async joinPane(sourceWindowId: string, horizontal: boolean = true): Promise<void> {
    await this.executeWithRetry(
      () => {
        const direction = horizontal ? '-h' : '-v';
        this.execute(`tmux join-pane ${direction} -s ${shQuote(sourceWindowId)}`);
      },
      RetryStrategy.FAST,
      `joinPane(${sourceWindowId})`,
    );
  }

  async windowExists(windowId: string): Promise<boolean> {
    try {
      await this.executeWithRetry(
        () => {
          this.execute(`tmux list-windows -F '#{window_id}' | grep -q ${shQuote(windowId)}`, { silent: true });
          return true;
        },
        RetryStrategy.FAST,
        `windowExists(${windowId})`,
      );
      return true;
    } catch {
      return false;
    }
  }
}
