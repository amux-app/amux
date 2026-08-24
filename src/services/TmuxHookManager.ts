/**
 * TmuxHookManager - Manages tmux hooks for event-driven updates
 *
 * Instead of polling every 5 seconds, tmux hooks notify aumx immediately
 * when panes are created, closed, or resized. This reduces CPU usage and
 * improves responsiveness.
 *
 * Hooks are optional - users can decline and fall back to polling.
 */

import { EventEmitter } from 'events';
import { execAsync, execAsyncWithStatus } from '../utils/execAsync.js';
import { shQuote } from '../utils/shellEscape.js';
import { LogService } from './LogService.js';

export interface HookStatus {
  installed: boolean;
  hooks: {
    afterSplitWindow: boolean;
    paneExited: boolean;
    clientResized: boolean;
    afterSelectPane: boolean;
  };
}

/**
 * TmuxHookManager singleton
 *
 * Manages the lifecycle of tmux hooks and emits events when they fire.
 * Uses Unix signals (SIGUSR2) to receive hook notifications.
 */
export class TmuxHookManager extends EventEmitter {
  private static instance: TmuxHookManager;
  private logger = LogService.getInstance();
  private sessionName: string = '';
  private pid: number = process.pid;
  private hooksInstalled = false;
  private signalHandlerSetup = false;

  private constructor() {
    super();
  }

  static getInstance(): TmuxHookManager {
    if (!TmuxHookManager.instance) {
      TmuxHookManager.instance = new TmuxHookManager();
    }
    return TmuxHookManager.instance;
  }

  /**
   * Initialize the hook manager with the current session
   */
  initialize(sessionName: string): void {
    this.sessionName = sessionName;
    this.setupSignalHandler();
  }

  /**
   * Set up the SIGUSR2 signal handler to receive hook notifications
   */
  private setupSignalHandler(): void {
    if (this.signalHandlerSetup) return;

    process.on('SIGUSR2', () => {
      this.logger.debug('Received SIGUSR2 signal from tmux hook', 'hooks');
      // Emit a generic event - the listener will need to check what changed
      this.emit('hook-triggered');
    });

    this.signalHandlerSetup = true;
    this.logger.debug('SIGUSR2 signal handler set up for tmux hooks', 'hooks');
  }

  /**
   * Check which hooks are currently installed for this session.
   * Uses a single tmux show-hooks call and checks stdout for each hook name.
   */
  async checkHookStatus(): Promise<HookStatus> {
    if (!this.sessionName) {
      return {
        installed: false,
        hooks: {
          afterSplitWindow: false,
          paneExited: false,
          clientResized: false,
          afterSelectPane: false,
        },
      };
    }

    const hooks = {
      afterSplitWindow: false,
      paneExited: false,
      clientResized: false,
      afterSelectPane: false,
    };

    try {
      const sn = shQuote(this.sessionName);
      const result = await execAsyncWithStatus(
        `tmux show-hooks -t ${sn}`,
        { timeout: 2000 }
      );

      const output = result.stdout;
      hooks.afterSplitWindow = output.includes('after-split-window');
      hooks.paneExited = output.includes('pane-exited');
      hooks.clientResized = output.includes('client-resized');
      hooks.afterSelectPane = output.includes('after-select-pane');

      const installed = hooks.afterSplitWindow && hooks.paneExited
        && hooks.clientResized && hooks.afterSelectPane;

      return { installed, hooks };
    } catch (error) {
      this.logger.debug(`Failed to check hook status: ${error}`, 'hooks');
      return { installed: false, hooks };
    }
  }

  /**
   * Quick check if hooks are installed AND targeting the current process PID.
   * Detects stale hooks left by a prior aumx instance that crashed/restarted.
   */
  async areHooksInstalled(): Promise<boolean> {
    if (!this.sessionName) return false;

    const sn = shQuote(this.sessionName);
    const result = await execAsyncWithStatus(
      `tmux show-hooks -t ${sn}`,
      { timeout: 1000 }
    );

    if (result.exitCode !== 0) return false;

    const output = result.stdout;
    // Must contain our marker AND the current PID to be considered valid
    return output.includes('aumx-hook') && output.includes(`kill -USR2 ${this.pid}`);
  }

  /**
   * Install all performance hooks for this session
   */
  async installHooks(): Promise<boolean> {
    if (!this.sessionName) {
      this.logger.error('Cannot install hooks: session name not set', 'hooks');
      return false;
    }

    try {
      const sn = shQuote(this.sessionName);
      const hookCommands = [
        `tmux set-hook -t ${sn} after-split-window 'run-shell "kill -USR2 ${this.pid} 2>/dev/null || true # aumx-hook"'`,
        `tmux set-hook -t ${sn} pane-exited 'run-shell "kill -USR2 ${this.pid} 2>/dev/null || true # aumx-hook"'`,
        `tmux set-hook -t ${sn} client-resized 'run-shell "kill -USR2 ${this.pid} 2>/dev/null || true # aumx-hook"'`,
        `tmux set-hook -t ${sn} after-select-pane 'run-shell "kill -USR2 ${this.pid} 2>/dev/null || true # aumx-hook"'`,
      ];

      for (const cmd of hookCommands) {
        await execAsync(cmd, { timeout: 2000 });
      }

      this.hooksInstalled = true;
      this.logger.info('Tmux hooks installed successfully', 'hooks');
      return true;
    } catch (error) {
      this.logger.error(`Failed to install hooks: ${error}`, 'hooks');
      return false;
    }
  }

  /**
   * Remove all aumx hooks from this session
   */
  async uninstallHooks(): Promise<boolean> {
    if (!this.sessionName) return false;

    try {
      const sn = shQuote(this.sessionName);
      const unsetCommands = [
        `tmux set-hook -u -t ${sn} after-split-window`,
        `tmux set-hook -u -t ${sn} pane-exited`,
        `tmux set-hook -u -t ${sn} client-resized`,
        `tmux set-hook -u -t ${sn} after-select-pane`,
      ];

      await Promise.all(
        unsetCommands.map(cmd => execAsync(cmd, { silent: true, timeout: 2000 }).catch(() => {}))
      );

      this.hooksInstalled = false;
      this.logger.info('Tmux hooks uninstalled', 'hooks');
      return true;
    } catch (error) {
      this.logger.debug(`Error uninstalling hooks: ${error}`, 'hooks');
      return false;
    }
  }

  /**
   * Check if hooks are currently active
   */
  isActive(): boolean {
    return this.hooksInstalled;
  }

  /**
   * Subscribe to hook events with debouncing
   * Returns an unsubscribe function
   */
  onHookTriggered(callback: () => void, debounceMs: number = 100): () => void {
    let timeoutId: NodeJS.Timeout | null = null;

    const debouncedCallback = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      timeoutId = setTimeout(() => {
        callback();
        timeoutId = null;
      }, debounceMs);
    };

    this.on('hook-triggered', debouncedCallback);

    // Return unsubscribe function
    return () => {
      this.off('hook-triggered', debouncedCallback);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }

  /**
   * Clean up on shutdown — uninstall hooks to prevent stale PID references
   */
  async cleanup(): Promise<void> {
    await this.uninstallHooks();
    this.removeAllListeners();
  }
}
