import { execAsync, shQuote } from 'aumx/core';
import { spawnSync } from 'child_process';
import * as pty from 'node-pty';
import type { TerminalDataSource } from '../../shared/ipc-types.js';
import { log } from './Logger.js';
import { makeTerminalPtyViewSessionName } from './terminal-pty-session.js';

export interface TerminalPtyProcess {
  kill(signal?: string): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  resize(cols: number, rows: number): void;
  write(data: string | Buffer): void;
}

export interface TerminalPtySpawner {
  spawn(
    file: string,
    args: string[],
    options: {
      cols: number;
      cwd: string;
      encoding: string;
      env: NodeJS.ProcessEnv;
      name: string;
      rows: number;
    },
  ): TerminalPtyProcess;
}

export interface TerminalPtyAttachOptions {
  cols: number;
  enableMouse?: boolean;
  onData: (paneId: string, data: string, source: TerminalDataSource, streamId: number) => void;
  onExit?: (paneId: string, event: { exitCode: number; signal?: number }) => void;
  onScreenReaderDetected?: (paneId: string) => void;
  paneId: string;
  rows: number;
  sessionName: string;
  streamId: number;
  tmuxPaneId: string;
  windowId: string;
}

export interface TerminalPtyHandle {
  dispose(): void;
  resize(cols: number, rows: number): void;
  setMouse(enabled: boolean): Promise<void>;
  write(data: string): void;
}

interface TerminalPtyServiceOptions {
  exec?: typeof execAsync;
  killViewSession?: (viewSessionName: string) => void;
  spawner?: TerminalPtySpawner;
}

const defaultSpawner: TerminalPtySpawner = {
  spawn(file, args, options) {
    return pty.spawn(file, args, options);
  },
};

const TMUX_SETUP_TIMEOUT_MS = 5000;
const TMUX_CLIENT_FEATURES = 'RGB,hyperlinks,usstyle,overline,strikethrough,sync,clipboard';
const VIEW_BOOTSTRAP_WINDOW_NAME = '__aumx_view_bootstrap__';
const VIEW_BOOTSTRAP_COMMAND = 'sleep 86400';
const SCREEN_READER_MARKER = /\[(?:Screen Reader Mode: on via (?:flag|env|settings)|Accessible screen reader mode: on)\]/i;
const SCREEN_READER_SCAN_LIMIT = 256;

function stripTerminalControls(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
}

function makePtyEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COLORTERM: 'truecolor',
    TERM: 'xterm-256color',
  };
  delete env.TMUX;
  return env;
}

function isUnsupportedCopyModePositionFormat(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes('invalid option: copy-mode-position-format');
}

export class TerminalPtyService {
  private readonly exec: typeof execAsync;
  private readonly killViewSessionCommand: (viewSessionName: string) => void;
  private readonly spawner: TerminalPtySpawner;

  constructor(options: TerminalPtyServiceOptions = {}) {
    this.exec = options.exec ?? execAsync;
    this.killViewSessionCommand = options.killViewSession ?? killViewSessionSync;
    this.spawner = options.spawner ?? defaultSpawner;
  }

  async attach(options: TerminalPtyAttachOptions): Promise<TerminalPtyHandle> {
    const viewSessionName = makeTerminalPtyViewSessionName(options.sessionName, options.paneId);
    await this.prepareViewSession(viewSessionName, options);

    // Finder-launched desktop apps may not inherit a UTF-8 locale. Force UTF-8
    // for this client so tmux never transliterates Unicode glyphs before xterm
    // receives them. -T likewise scopes terminal capabilities to this client.
    let terminal: TerminalPtyProcess;
    try {
      terminal = this.spawner.spawn('tmux', ['-u', '-T', TMUX_CLIENT_FEATURES, 'attach-session', '-t', `=${viewSessionName}`], {
        cols: options.cols,
        cwd: process.env.HOME || process.cwd(),
        encoding: 'utf8',
        env: makePtyEnv(),
        name: 'xterm-256color',
        rows: options.rows,
      });
    } catch (error) {
      this.killViewSession(viewSessionName, options.paneId);
      throw error;
    }

    let disposed = false;
    let screenReaderDetected = false;
    let markerBuffer = '';
    const setMouse = (enabled: boolean): Promise<void> => this.setViewSessionMouse(viewSessionName, enabled);
    const dataSubscription = terminal.onData((data) => {
      if (disposed) return;
      if (options.enableMouse === true && !screenReaderDetected) {
        markerBuffer = `${markerBuffer}${data}`.slice(-SCREEN_READER_SCAN_LIMIT);
        if (SCREEN_READER_MARKER.test(stripTerminalControls(markerBuffer))) {
          screenReaderDetected = true;
          options.onScreenReaderDetected?.(options.paneId);
          void setMouse(false).catch((error) => {
            log.warn('terminal', 'Failed to disable view-session mouse for screen-reader mode', {
              error,
              paneId: options.paneId,
              viewSessionName,
            });
          });
        }
      }
      options.onData(options.paneId, data, 'live', options.streamId);
    });
    const exitSubscription = terminal.onExit((event) => {
      if (disposed) return;
      log.info('terminal', 'PTY tmux client exited', {
        event,
        paneId: options.paneId,
        sessionName: options.sessionName,
        viewSessionName,
      });
      options.onExit?.(options.paneId, event);
    });

    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        dataSubscription.dispose();
        exitSubscription.dispose();
        try {
          terminal.kill();
        } catch (error) {
          log.debug('terminal', 'PTY process kill failed during dispose', {
            error,
            paneId: options.paneId,
            viewSessionName,
          });
        }
        this.killViewSession(viewSessionName, options.paneId);
      },
      resize: (cols, rows) => {
        terminal.resize(cols, rows);
      },
      setMouse,
      write: (data) => {
        terminal.write(data);
      },
    };
  }

  private async prepareViewSession(
    viewSessionName: string,
    options: TerminalPtyAttachOptions,
  ): Promise<void> {
    const viewTarget = shQuote(`=${viewSessionName}`);
    const viewOptionTarget = shQuote(viewSessionName);
    const sourceWindowTarget = shQuote(`=${options.sessionName}:${options.windowId}`);
    const viewLinkTarget = shQuote(`=${viewSessionName}:`);
    const viewBootstrapWindowTarget = shQuote(`=${viewSessionName}:${VIEW_BOOTSTRAP_WINDOW_NAME}`);
    const viewWindowTarget = shQuote(`=${viewSessionName}:${options.windowId}`);
    const setupOptions = { timeout: TMUX_SETUP_TIMEOUT_MS };

    await this.removeExistingViewSession(viewTarget, viewSessionName, options.paneId, setupOptions);

    try {
      // The @aumx_view_session marker is chained into new-session so the
      // session is created already tagged: startup cleanup only kills tagged
      // sessions, and a crash between two separate commands would otherwise
      // leave an untagged orphan it refuses to touch.
      await this.exec(
        `tmux new-session -d -s ${shQuote(viewSessionName)} -n ${shQuote(VIEW_BOOTSTRAP_WINDOW_NAME)} ${shQuote(VIEW_BOOTSTRAP_COMMAND)} ';' set -t ${viewOptionTarget} @aumx_view_session 1`,
        setupOptions,
      );
      await this.exec(`tmux set-option -t ${viewOptionTarget} status off`, setupOptions);
      if (options.enableMouse !== undefined) {
        await this.setViewSessionMouse(viewSessionName, options.enableMouse);
      }
      await this.exec(`tmux link-window -s ${sourceWindowTarget} -t ${viewLinkTarget}`, setupOptions);
      await this.exec(`tmux kill-window -t ${viewBootstrapWindowTarget}`, setupOptions);
      await this.exec(`tmux select-window -t ${viewWindowTarget}`, setupOptions);
      // Classic-mode wheel scrolling enters tmux copy-mode; hide tmux's own
      // "HH:MM [pos/total]" position overlay so it doesn't paint over the pane.
      // copy-mode-position-format is a WINDOW option, so it must be set with -w
      // on the (now-linked) shared window — a session-scope set is a silent no-op.
      try {
        await this.exec(`tmux set-option -w -t ${viewWindowTarget} copy-mode-position-format ''`, setupOptions);
      } catch (error) {
        if (!isUnsupportedCopyModePositionFormat(error)) throw error;
        log.debug('terminal', 'tmux copy-mode position overlay option is unavailable', {
          viewSessionName,
        });
      }
    } catch (error) {
      await this.removeExistingViewSession(viewTarget, viewSessionName, options.paneId, setupOptions);
      throw error;
    }
  }

  private async setViewSessionMouse(viewSessionName: string, enabled: boolean): Promise<void> {
    await this.exec(
      `tmux set-option -t ${shQuote(viewSessionName)} mouse ${enabled ? 'on' : 'off'}`,
      { timeout: TMUX_SETUP_TIMEOUT_MS },
    );
  }

  private async removeExistingViewSession(
    viewTarget: string,
    viewSessionName: string,
    paneId: string,
    setupOptions: { timeout: number },
  ): Promise<void> {
    try {
      await this.exec(`tmux kill-session -t ${viewTarget}`, setupOptions);
    } catch (error) {
      log.debug('terminal', 'No existing PTY view session to replace', {
        error,
        paneId,
        viewSessionName,
      });
    }
  }

  private killViewSession(viewSessionName: string, paneId: string): void {
    try {
      this.killViewSessionCommand(viewSessionName);
    } catch (error) {
      log.debug('terminal', 'PTY view session cleanup failed', {
        error,
        paneId,
        viewSessionName,
      });
    }
  }
}

function killViewSessionSync(viewSessionName: string): void {
  const result = spawnSync('tmux', ['kill-session', '-t', `=${viewSessionName}`], {
    stdio: 'ignore',
    timeout: TMUX_SETUP_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
}
