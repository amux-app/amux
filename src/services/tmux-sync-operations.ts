import type { LogService } from './LogService.js';
import type { PanePosition, WindowDimensions } from '../types.js';
import { shQuote } from '../utils/shellEscape.js';

interface ExecuteOptions {
  encoding?: BufferEncoding;
  silent?: boolean;
  stdio?: 'pipe' | 'inherit';
}

export abstract class TmuxSyncOperations {
  protected abstract logger: LogService;

  protected abstract execute(command: string, options?: ExecuteOptions): string;

  getWindowDimensionsSync(): WindowDimensions {
    try {
      const output = this.execute(
        'tmux display-message -p "#{window_width} #{window_height}"',
      );
      const [width, height] = output.split(' ').map((n) => parseInt(n, 10));
      return { width, height };
    } catch {
      this.logger.warn('Failed to get window dimensions, using fallback', 'TmuxService');
      return { width: 120, height: 40 };
    }
  }

  getTerminalDimensionsSync(): WindowDimensions {
    try {
      const output = this.execute(
        'tmux display-message -p "#{client_width} #{client_height}"',
      );
      const [width, height] = output.split(' ').map((n) => parseInt(n, 10));
      return { width, height };
    } catch {
      this.logger.warn('Failed to get terminal dimensions, using fallback', 'TmuxService');
      return { width: 120, height: 40 };
    }
  }

  getStatusBarHeightSync(): number {
    try {
      const statusEnabled = this.execute('tmux display-message -p "#{status}"').trim();
      if (statusEnabled !== 'on') {
        return 0;
      }

      const statusFormats = this.execute('tmux show-options -gv status-format');
      return statusFormats.split('\n').filter((line) => line.trim()).length;
    } catch {
      this.logger.debug('Failed to get status bar height, assuming 0', 'TmuxService');
      return 0;
    }
  }

  getDimensionInfoSync(): {
    clientWidth: number;
    clientHeight: number;
    windowWidth: number;
    windowHeight: number;
    statusBarHeight: number;
    statusBarEnabled: boolean;
  } {
    const client = this.getTerminalDimensionsSync();
    const window = this.getWindowDimensionsSync();
    const statusBarHeight = this.getStatusBarHeightSync();

    return {
      clientWidth: client.width,
      clientHeight: client.height,
      windowWidth: window.width,
      windowHeight: window.height,
      statusBarHeight,
      statusBarEnabled: statusBarHeight > 0,
    };
  }

  calculateWindowDimensions(): WindowDimensions {
    const termDims = this.getTerminalDimensionsSync();
    const statusBarHeight = this.getStatusBarHeightSync();

    return {
      width: termDims.width,
      height: termDims.height - statusBarHeight,
    };
  }

  getAllPaneIdsSync(): string[] {
    try {
      const output = this.execute('tmux list-panes -F "#{pane_id}"');
      return output.split('\n').filter((id) => id.trim());
    } catch {
      this.logger.warn('Failed to get pane IDs, returning empty array', 'TmuxService');
      return [];
    }
  }

  getPanePositionsSync(): PanePosition[] {
    try {
      const output = this.execute(
        `tmux list-panes -F '#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height}'`,
      );

      return output.split('\n').map((line) => {
        const [paneId, left, top, width, height] = line.split(' ');
        return {
          paneId,
          left: parseInt(left, 10),
          top: parseInt(top, 10),
          width: parseInt(width, 10),
          height: parseInt(height, 10),
        };
      });
    } catch {
      this.logger.warn('Failed to get pane positions, returning empty array', 'TmuxService');
      return [];
    }
  }

  getPaneTitleSync(paneId: string): string {
    try {
      return this.execute(`tmux display-message -t ${shQuote(paneId)} -p '#{pane_title}'`);
    } catch {
      this.logger.warn(`Failed to get pane title for ${paneId}, returning empty string`, 'TmuxService');
      return '';
    }
  }

  getPaneSessionNameSync(paneId: string): string {
    try {
      return this.execute(`tmux display-message -t ${shQuote(paneId)} -p '#{session_name}'`);
    } catch {
      this.logger.warn(`Failed to get session name for ${paneId}, returning empty string`, 'TmuxService');
      return '';
    }
  }

  splitPaneSync(options: {
    targetPane?: string;
    cwd?: string;
    command?: string;
  } = {}): string {
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
  }

  newWindowPaneSync(options: {
    sessionName?: string;
    cwd?: string;
    name?: string;
  } = {}): string {
    let cmd = "tmux new-window -d -P -F '#{pane_id}'";

    if (options.sessionName) {
      cmd += ` -t ${shQuote(options.sessionName)}`;
    }
    if (options.name) {
      cmd += ` -n ${shQuote(options.name)}`;
    }
    if (options.cwd) {
      cmd += ` -c ${shQuote(options.cwd)}`;
    }

    return this.execute(cmd);
  }

  refreshClientSync(): void {
    try {
      this.execute('tmux refresh-client', { silent: true });
    } catch {
    }
  }

  clearHistorySync(): void {
    try {
      this.execute('tmux clear-history', { silent: true });
    } catch {
    }
  }

  async clearPaneHistory(paneId: string): Promise<void> {
    try {
      this.execute(`tmux clear-history -t ${shQuote(paneId)}`, { silent: true });
    } catch {
    }
  }

  getVersionSync(): string {
    try {
      return this.execute('tmux -V');
    } catch {
      this.logger.warn('Failed to get tmux version', 'TmuxService');
      return '';
    }
  }

  getSessionOptionSync(sessionName: string, option: string): string {
    try {
      return this.execute(`tmux show -t ${shQuote(sessionName)} ${shQuote(option)}`);
    } catch {
      this.logger.warn(`Failed to get session option ${option} for ${sessionName}`, 'TmuxService');
      return '';
    }
  }

  setSessionOptionSync(sessionName: string, option: string, value: string): void {
    try {
      this.execute(`tmux set -t ${shQuote(sessionName)} ${shQuote(option)} ${shQuote(value)}`, { silent: true });
    } catch {
      this.logger.warn(`Failed to set session option ${option} for ${sessionName}`, 'TmuxService');
    }
  }

  getCurrentPaneIdSync(): string {
    try {
      return this.execute('tmux display-message -p "#{pane_id}"');
    } catch (error) {
      this.logger.warn('Failed to get current pane ID', 'TmuxService');
      throw error;
    }
  }

  setWindowOptionSync(option: string, value: string): void {
    try {
      this.execute(`tmux set-window-option ${shQuote(option)} ${shQuote(value)}`, { silent: true });
    } catch {
      this.logger.warn(`Failed to set window option ${option}`, 'TmuxService');
    }
  }

  selectLayoutSync(layout: string): boolean {
    try {
      this.execute(`tmux select-layout ${shQuote(layout)}`);
      return true;
    } catch {
      this.logger.warn(`Failed to select layout ${layout}`, 'TmuxService');
      return false;
    }
  }

  resizePaneSync(paneId: string, dimensions: { width?: number; height?: number }): boolean {
    try {
      if (dimensions.width !== undefined) {
        this.execute(`tmux resize-pane -t ${shQuote(paneId)} -x ${dimensions.width}`);
      }
      if (dimensions.height !== undefined) {
        this.execute(`tmux resize-pane -t ${shQuote(paneId)} -y ${dimensions.height}`);
      }
      return true;
    } catch {
      this.logger.warn(`Failed to resize pane ${paneId}`, 'TmuxService');
      return false;
    }
  }

  resizeWindowSync(dimensions: { width: number; height: number }): boolean {
    try {
      this.execute(`tmux resize-window -x ${dimensions.width} -y ${dimensions.height}`);
      return true;
    } catch {
      this.logger.warn('Failed to resize window', 'TmuxService');
      return false;
    }
  }

  selectPaneSync(paneId: string): void {
    try {
      this.execute(`tmux select-pane -t ${shQuote(paneId)}`);
    } catch (error) {
      this.logger.warn(`Failed to select pane ${paneId}`, 'TmuxService');
      throw error;
    }
  }

  setPaneTitleSync(paneId: string, title: string): void {
    try {
      this.execute(`tmux select-pane -t ${shQuote(paneId)} -T ${shQuote(title)}`);
    } catch (error) {
      this.logger.warn(`Failed to set pane title for ${paneId}`, 'TmuxService');
      throw error;
    }
  }

  killPaneSync(paneId: string): void {
    try {
      this.execute(`tmux kill-pane -t ${shQuote(paneId)}`);
    } catch (error) {
      this.logger.warn(`Failed to kill pane ${paneId}`, 'TmuxService');
      throw error;
    }
  }

  listPanesSync(format?: string): string {
    try {
      const formatStr = format || '#{pane_id}=#{pane_index}';
      return this.execute(`tmux list-panes -F ${shQuote(formatStr)}`);
    } catch {
      this.logger.warn('Failed to list panes', 'TmuxService');
      return '';
    }
  }

  setGlobalOptionSync(option: string, value: string): void {
    try {
      this.execute(`tmux set-option -g ${shQuote(option)} ${shQuote(value)}`, { silent: true });
    } catch {
      this.logger.warn(`Failed to set global option ${option}`, 'TmuxService');
    }
  }

  getPaneWidthSync(paneId: string): number {
    try {
      const output = this.execute(`tmux display-message -t ${shQuote(paneId)} -p '#{pane_width}'`);
      return parseInt(output, 10);
    } catch {
      this.logger.warn(`Failed to get pane width for ${paneId}`, 'TmuxService');
      return 0;
    }
  }

  getCurrentLayoutSync(): string {
    try {
      return this.execute('tmux display-message -p "#{window_layout}"');
    } catch {
      this.logger.warn('Failed to get current layout', 'TmuxService');
      return '';
    }
  }
}
