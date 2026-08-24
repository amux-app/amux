import { EventEmitter } from 'events';
import { execFileAsync } from '../utils/execAsync.js';
import { LogService } from './LogService.js';
import { TmuxHookManager } from './TmuxHookManager.js';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const TMUX_POLL_TIMEOUT_MS = 2_000;

export type PaneEventMode = 'hooks' | 'polling' | 'disabled';

export interface PaneChangeEvent {
  type: 'panes-changed';
  paneIds?: string[];
  added?: string[];
  removed?: string[];
  timestamp: number;
  source: PaneEventMode;
}

interface PaneEventConfig {
  sessionName: string;
  controlPaneId?: string;
  pollInterval?: number;
  preferHooks?: boolean;
}

export class PaneEventService extends EventEmitter {
  private static instance: PaneEventService;
  private logger = LogService.getInstance();
  private hookManager: TmuxHookManager;
  private mode: PaneEventMode = 'disabled';
  private config: PaneEventConfig | null = null;
  private unsubscribeHook: (() => void) | null = null;
  private pollingTimer: ReturnType<typeof setTimeout> | null = null;
  private pollingInFlight: Promise<void> | null = null;
  private pollingGeneration = 0;
  private forcePollPending = false;
  private lastPaneIds: string[] | null = null;

  private constructor() {
    super();
    this.hookManager = TmuxHookManager.getInstance();
  }

  static getInstance(): PaneEventService {
    if (!PaneEventService.instance) {
      PaneEventService.instance = new PaneEventService();
    }
    return PaneEventService.instance;
  }

  async initialize(config: PaneEventConfig): Promise<void> {
    this.config = config;
    this.hookManager.initialize(config.sessionName);
  }

  async start(useHooks: boolean = true): Promise<PaneEventMode> {
    if (!this.config) {
      throw new Error('PaneEventService not initialized');
    }

    await this.stop();

    if (useHooks) {
      const hooksAvailable = await this.hookManager.areHooksInstalled();
      if (hooksAvailable || await this.hookManager.installHooks()) {
        this.mode = 'hooks';
        this.startHookMode();
        this.logger.info('Pane events: Using tmux hooks (low CPU)', 'paneEvents');
        return 'hooks';
      }
    }

    this.mode = 'polling';
    this.lastPaneIds = null;
    this.schedulePoll(0, false);
    this.logger.info('Pane events: Using main-process polling', 'paneEvents');
    return 'polling';
  }

  private startHookMode(): void {
    this.unsubscribeHook = this.hookManager.onHookTriggered(() => {
      this.emit('panes-changed', {
        type: 'panes-changed',
        timestamp: Date.now(),
        source: 'hooks',
      } as PaneChangeEvent);
    }, 100);
  }

  private schedulePoll(delayMs: number, forced: boolean): void {
    if (this.mode !== 'polling') return;
    this.clearPollingTimer();
    const generation = this.pollingGeneration;
    const timer = setTimeout(() => {
      if (this.pollingTimer === timer) this.pollingTimer = null;
      if (generation !== this.pollingGeneration || this.mode !== 'polling') return;
      this.beginPoll(generation, forced);
    }, delayMs);
    timer.unref();
    this.pollingTimer = timer;
  }

  private beginPoll(generation: number, forced: boolean): void {
    if (this.pollingInFlight) {
      this.forcePollPending = this.forcePollPending || forced;
      return;
    }

    const poll = this.pollOnce(generation, forced);
    this.pollingInFlight = poll;
    void poll.then(() => this.finishPoll(generation, poll));
  }

  private finishPoll(generation: number, poll: Promise<void>): void {
    if (this.pollingInFlight === poll) this.pollingInFlight = null;
    if (generation !== this.pollingGeneration || this.mode !== 'polling') return;

    if (this.forcePollPending) {
      this.forcePollPending = false;
      this.schedulePoll(0, true);
      return;
    }

    this.schedulePoll(this.getPollInterval(), false);
  }

  private async pollOnce(generation: number, forced: boolean): Promise<void> {
    const config = this.config;
    if (!config) return;

    try {
      const output = await execFileAsync(
        'tmux',
        ['list-panes', '-s', '-t', `${config.sessionName}:`, '-F', '#{pane_id}'],
        { timeout: TMUX_POLL_TIMEOUT_MS },
      );
      if (
        generation !== this.pollingGeneration
        || this.mode !== 'polling'
        || config !== this.config
      ) {
        return;
      }

      const paneIds = output.split('\n').filter(Boolean);
      if (forced) {
        if (!this.lastPaneIds) this.lastPaneIds = paneIds;
        this.emitPollingChange(paneIds, [], []);
        return;
      }

      const previousPaneIds = this.lastPaneIds;
      this.lastPaneIds = paneIds;
      if (!previousPaneIds) return;

      const { added, removed } = comparePaneIds(previousPaneIds, paneIds);
      if (added.length > 0 || removed.length > 0) {
        this.emitPollingChange(paneIds, added, removed);
      }
    } catch (error) {
      if (generation === this.pollingGeneration && this.mode === 'polling') {
        this.logger.debug(`Polling error: ${String(error)}`, 'paneEvents');
      }
    }
  }

  private emitPollingChange(paneIds: string[], added: string[], removed: string[]): void {
    this.emit('panes-changed', {
      type: 'panes-changed',
      paneIds,
      added,
      removed,
      timestamp: Date.now(),
      source: 'polling',
    } as PaneChangeEvent);
  }

  async stop(): Promise<void> {
    if (this.unsubscribeHook) {
      this.unsubscribeHook();
      this.unsubscribeHook = null;
    }

    this.mode = 'disabled';
    this.pollingGeneration += 1;
    this.forcePollPending = false;
    this.lastPaneIds = null;
    this.clearPollingTimer();

    this.pollingInFlight = null;
  }

  private clearPollingTimer(): void {
    if (!this.pollingTimer) return;
    clearTimeout(this.pollingTimer);
    this.pollingTimer = null;
  }

  private getPollInterval(): number {
    return this.config?.pollInterval || DEFAULT_POLL_INTERVAL_MS;
  }

  getMode(): PaneEventMode {
    return this.mode;
  }

  forceCheck(): void {
    if (this.mode === 'polling') {
      if (this.pollingInFlight) {
        this.forcePollPending = true;
      } else {
        this.schedulePoll(0, true);
      }
    } else if (this.mode === 'hooks') {
      this.emit('panes-changed', {
        type: 'panes-changed',
        timestamp: Date.now(),
        source: 'hooks',
      } as PaneChangeEvent);
    }
  }

  setPollingInterval(ms: number): void {
    if (this.config && ms > 0) {
      this.config.pollInterval = ms;
    }
  }

  async canUseHooks(): Promise<boolean> {
    return this.hookManager.areHooksInstalled();
  }

  async installHooks(): Promise<boolean> {
    const success = await this.hookManager.installHooks();
    if (success && this.mode === 'polling') {
      await this.start(true);
    }
    return success;
  }

  async uninstallHooks(): Promise<boolean> {
    const success = await this.hookManager.uninstallHooks();
    if (success && this.mode === 'hooks') {
      await this.start(false);
    }
    return success;
  }

  onPanesChanged(callback: (event: PaneChangeEvent) => void): () => void {
    this.on('panes-changed', callback);
    return () => this.off('panes-changed', callback);
  }

  async cleanup(): Promise<void> {
    const shouldCleanupHooks = this.mode === 'hooks' || this.hookManager.isActive();
    await this.stop();
    if (shouldCleanupHooks) {
      await this.hookManager.cleanup();
    }
    this.removeAllListeners();
  }
}

function comparePaneIds(previous: string[], current: string[]): {
  added: string[];
  removed: string[];
} {
  const previousSet = new Set(previous);
  const currentSet = new Set(current);
  return {
    added: current.filter((paneId) => !previousSet.has(paneId)),
    removed: previous.filter((paneId) => !currentSet.has(paneId)),
  };
}

export default PaneEventService.getInstance();
