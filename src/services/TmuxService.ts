import { LogService } from './LogService.js';
import { executeTmuxCommand, executeTmuxCommandAsync } from './tmux-command-runner.js';
import { executeWithRetry as executeTmuxWithRetry, RetryStrategy } from './tmux-retry.js';
import { TmuxWriteOperations } from './tmux-write-operations.js';
import { execFileAsync } from '../utils/execAsync.js';
import { shQuote } from '../utils/shellEscape.js';
import type { PanePosition, WindowDimensions } from '../types.js';

export { RetryStrategy } from './tmux-retry.js';

/**
 * Comprehensive dimension info from a single tmux query
 */
export interface DimensionInfo {
  windowWidth: number;
  windowHeight: number;
  clientWidth: number;
  clientHeight: number;
  statusEnabled: boolean;
  statusFormatLines: number;
}

/**
 * Centralized tmux command execution service
 * Provides:
 * - Consistent error handling
 * - Retry logic for transient failures
 * - Logging and debugging
 * - Type-safe tmux operations
 */
export class TmuxService extends TmuxWriteOperations {
  private static instance: TmuxService;
  protected logger = LogService.getInstance();

  private constructor() {
    super();
  }

  public static getInstance(): TmuxService {
    if (!TmuxService.instance) {
      TmuxService.instance = new TmuxService();
    }
    return TmuxService.instance;
  }

  /**
   * Execute a tmux command with retry logic
   */
  protected async executeWithRetry<T>(
    operation: () => T | Promise<T>,
    strategy: RetryStrategy = RetryStrategy.IDEMPOTENT,
    context?: string
  ): Promise<T> {
    return executeTmuxWithRetry(operation, this.logger, strategy, context);
  }

  /**
   * Execute a synchronous tmux command (most common case)
   * @deprecated Use executeNonBlocking for new code
   */
  protected execute(
    command: string,
    options: {
      encoding?: BufferEncoding;
      stdio?: 'pipe' | 'inherit';
      silent?: boolean;
    } = {}
  ): string {
    return executeTmuxCommand(command, this.logger, options);
  }

  /**
   * Execute a tmux command asynchronously (non-blocking)
   * This is the preferred method for new code.
   */
  protected async executeNonBlocking(
    command: string,
    options: {
      silent?: boolean;
      timeout?: number;
    } = {}
  ): Promise<string> {
    return executeTmuxCommandAsync(command, this.logger, options);
  }

  // ===== BATCHED QUERIES (Performance optimization) =====

  /**
   * Get all dimension info in a single tmux command.
   * This replaces multiple calls to getWindowDimensions, getTerminalDimensions, etc.
   *
   * Performance: 1 command instead of 4+
   */
  async getAllDimensions(): Promise<DimensionInfo> {
    const output = await this.executeNonBlocking(
      `tmux display-message -p "#{window_width}|#{window_height}|#{client_width}|#{client_height}|#{status}"`
    );
    const [ww, wh, cw, ch, status] = output.split('|');

    // Get status format lines (requires separate command due to newlines)
    let statusFormatLines = 0;
    if (status === 'on') {
      try {
        const formats = await this.executeNonBlocking(
          `tmux show-options -gv status-format`,
          { silent: true }
        );
        statusFormatLines = formats.split('\n').filter(line => line.trim()).length;
      } catch {
        statusFormatLines = 1; // Default assumption
      }
    }

    return {
      windowWidth: parseInt(ww, 10),
      windowHeight: parseInt(wh, 10),
      clientWidth: parseInt(cw, 10),
      clientHeight: parseInt(ch, 10),
      statusEnabled: status === 'on',
      statusFormatLines,
    };
  }

  /**
   * Get all pane info in a single tmux command.
   * Returns pane ID, title, position, and dimensions for all panes.
   *
   * Performance: 1 command instead of N * 3+ (where N = pane count)
   */
  async getAllPaneInfo(): Promise<Array<PanePosition & { title: string }>> {
    const output = await this.executeNonBlocking(
      `tmux list-panes -F '#{pane_id}|#{pane_title}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}'`
    );

    return output.split('\n').filter(Boolean).map(line => {
      const [paneId, title, left, top, width, height] = line.split('|');
      return {
        paneId,
        title,
        left: parseInt(left, 10),
        top: parseInt(top, 10),
        width: parseInt(width, 10),
        height: parseInt(height, 10),
      };
    });
  }

  /**
   * List every pane across all sessions/windows in a single tmux command,
   * with its pid and current command. Used to resolve liveness + running
   * agent for many panes without N separate display-message spawns.
   *
   * Retries transient failures (IDEMPOTENT). Returns `null` when the query
   * genuinely fails so callers can distinguish "couldn't determine liveness"
   * from an empty-but-successful result — treating a transient failure as
   * "no panes" would let callers wrongly declare live panes dead.
   */
  async listAllPanes(): Promise<Array<{ paneId: string; pid: number; currentCommand: string }> | null> {
    let output: string;
    try {
      output = await this.executeWithRetry(
        () => this.execute(
          `tmux list-panes -a -F '#{pane_id}|#{pane_pid}|#{pane_current_command}'`,
          { silent: true },
        ),
        RetryStrategy.IDEMPOTENT,
        'listAllPanes',
      );
    } catch {
      return null;
    }

    return output.split('\n').filter(Boolean).map(line => {
      const parts = line.split('|');
      return {
        paneId: parts[0],
        pid: Number.parseInt(parts[1], 10),
        currentCommand: parts.slice(2).join('|'),
      };
    });
  }

  // ===== READ OPERATIONS (IDEMPOTENT - safe to retry) =====

  /**
   * Get current pane ID
   */
  async getCurrentPaneId(): Promise<string> {
    return this.executeWithRetry(
      () => this.execute('tmux display-message -p "#{pane_id}"'),
      RetryStrategy.IDEMPOTENT,
      'getCurrentPaneId'
    );
  }

  /**
   * Get current window dimensions
   */
  async getWindowDimensions(): Promise<WindowDimensions> {
    return this.executeWithRetry(
      async () => {
        const output = this.execute(
          'tmux display-message -p "#{window_width} #{window_height}"'
        );
        const [width, height] = output.split(' ').map(n => parseInt(n, 10));
        return { width, height };
      },
      RetryStrategy.IDEMPOTENT,
      'getWindowDimensions'
    );
  }

  /**
   * Get current terminal (client) dimensions
   */
  async getTerminalDimensions(): Promise<WindowDimensions> {
    return this.executeWithRetry(
      () => {
        const output = this.execute(
          'tmux display-message -p "#{client_width} #{client_height}"'
        );
        const [width, height] = output.split(' ').map(n => parseInt(n, 10));
        return { width, height };
      },
      RetryStrategy.IDEMPOTENT,
      'getTerminalDimensions'
    );
  }

  /**
   * Get the current command running in a pane (e.g., "fish", "zsh", "claude")
   */
  async getPaneCurrentCommand(paneId: string): Promise<string> {
    return this.executeWithRetry(
      () => {
        return this.execute(`tmux display-message -t ${shQuote(paneId)} -p "#{pane_current_command}"`);
      },
      RetryStrategy.IDEMPOTENT,
      `getPaneCurrentCommand(${paneId})`
    );
  }

  async getPanePid(paneId: string): Promise<number | null> {
    return this.executeWithRetry(
      () => {
        const output = this.execute(`tmux display-message -t ${shQuote(paneId)} -p "#{pane_pid}"`);
        const pid = Number.parseInt(output.trim(), 10);
        return Number.isFinite(pid) && pid > 0 ? pid : null;
      },
      RetryStrategy.IDEMPOTENT,
      `getPanePid(${paneId})`
    );
  }

  /**
   * Get all pane IDs in current window
   */
  async getAllPaneIds(): Promise<string[]> {
    return this.executeWithRetry(
      () => {
        const output = this.execute('tmux list-panes -F "#{pane_id}"');
        return output.split('\n').filter(id => id.trim());
      },
      RetryStrategy.IDEMPOTENT,
      'getAllPaneIds'
    );
  }

  /**
   * Get pane count in current window
   */
  async getPaneCount(): Promise<number> {
    return this.executeWithRetry(
      () => {
        const output = this.execute('tmux list-panes | wc -l');
        return parseInt(output, 10);
      },
      RetryStrategy.IDEMPOTENT,
      'getPaneCount'
    );
  }

  /**
   * Get pane positions for all panes
   */
  async getPanePositions(): Promise<PanePosition[]> {
    return this.executeWithRetry(
      () => {
        const output = this.execute(
          `tmux list-panes -F '#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height}'`
        );

        return output.split('\n').map(line => {
          const [paneId, left, top, width, height] = line.split(' ');
          return {
            paneId,
            left: parseInt(left, 10),
            top: parseInt(top, 10),
            width: parseInt(width, 10),
            height: parseInt(height, 10),
          };
        });
      },
      RetryStrategy.IDEMPOTENT,
      'getPanePositions'
    );
  }

  /**
   * Get pane title
   */
  async getPaneTitle(paneId: string): Promise<string> {
    return this.executeWithRetry(
      () => {
        return this.execute(
          `tmux display-message -t ${shQuote(paneId)} -p '#{pane_title}'`
        );
      },
      RetryStrategy.IDEMPOTENT,
      `getPaneTitle(${paneId})`
    );
  }

  /**
   * Get pane content (capture-pane)
   */
  async getPaneContent(paneId: string, options?: { start?: number; end?: number }): Promise<string> {
    return this.executeWithRetry(
      async () => {
        let cmd = `tmux capture-pane -t ${shQuote(paneId)} -p`;
        if (options?.start !== undefined) {
          cmd += ` -S ${options.start}`;
        }
        if (options?.end !== undefined) {
          cmd += ` -E ${options.end}`;
        }
        return this.executeNonBlocking(cmd);
      },
      RetryStrategy.IDEMPOTENT,
      `getPaneContent(${paneId})`
    );
  }

  /**
   * Check if a pane exists
   */
  async paneExists(paneId: string): Promise<boolean> {
    try {
      const result = await this.executeWithRetry(
        () => execFileAsync('tmux', ['display-message', '-t', paneId, '-p', '#{pane_id}']),
        RetryStrategy.FAST,
        `paneExists(${paneId})`
      );
      // Verify the pane ID is actually returned (not empty)
      // Empty output indicates a zombie pane that exists but has no properties
      return result.trim() === paneId;
    } catch {
      // Expected - pane doesn't exist, or every retry hit a transient failure
      return false;
    }
  }

  /**
   * Get content pane IDs (excludes control pane and spacer panes)
   */
  async getContentPaneIds(controlPaneId: string): Promise<string[]> {
    const allPanes = await this.getAllPaneIds();
    const contentPanes: string[] = [];

    for (const id of allPanes) {
      if (id === controlPaneId) continue;

      try {
        const title = await this.getPaneTitle(id);
        if (title !== 'aumx-spacer') {
          contentPanes.push(id);
        }
      } catch {
        // Include pane if we can't get title
        contentPanes.push(id);
      }
    }

    return contentPanes;
  }

}
