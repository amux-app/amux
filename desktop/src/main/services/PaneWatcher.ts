import { BrowserWindow } from 'electron';
import {
  MUXBASE_PANE_ID_OPTION,
  PaneEventService,
  StateManager,
  execFileAsync,
  stampTmuxPaneIdOption,
  stampTmuxPaneIncarnationOption,
  type MuxBasePane,
} from 'muxbase/core';
import { IPC_EVENT } from '../../shared/ipc-channels.js';
import { log } from './Logger.js';

const PANE_INFO_FORMAT = `#{pane_id}|#{${MUXBASE_PANE_ID_OPTION}}|#{pane_title}`;

interface TmuxPaneInfo {
  boundPaneId: string;
  paneId: string;
  title: string;
}

interface RebindMatch {
  paneId: string;
  source: 'option' | 'title';
}

interface PaneLookup {
  allPaneIds: string[];
  boundIdToTmuxId: Map<string, string>;
  titleToTmuxId: Map<string, string>;
  tmuxIdToBoundId: Map<string, string>;
}

/**
 * An MuxBase id reported by more than one tmux pane is ambiguous — either inherited
 * from a wider tmux option scope or forged — so it identifies nobody.
 */
function buildUniqueBoundIndex(paneInfo: TmuxPaneInfo[]): Map<string, string> {
  const index = new Map<string, string>();
  const ambiguous = new Set<string>();

  for (const info of paneInfo) {
    if (!info.boundPaneId) continue;
    if (index.has(info.boundPaneId)) ambiguous.add(info.boundPaneId);
    index.set(info.boundPaneId, info.paneId);
  }
  for (const boundPaneId of ambiguous) index.delete(boundPaneId);

  return index;
}

function buildPaneLookup(paneInfo: TmuxPaneInfo[]): PaneLookup {
  return {
    allPaneIds: paneInfo.map((info) => info.paneId),
    boundIdToTmuxId: buildUniqueBoundIndex(paneInfo),
    titleToTmuxId: new Map(paneInfo.map((info) => [info.title, info.paneId])),
    tmuxIdToBoundId: new Map(paneInfo.map((info) => [info.paneId, info.boundPaneId])),
  };
}

function carriesForeignIdentity(lookup: PaneLookup, tmuxPaneId: string, paneId: string): boolean {
  const carried = lookup.tmuxIdToBoundId.get(tmuxPaneId);
  if (!carried || carried === paneId) return false;
  return lookup.boundIdToTmuxId.has(carried);
}

/**
 * The pane option is authoritative because it cannot be written from inside the
 * pane. The title fallback exists only for panes predating the option, so it is
 * refused whenever the candidate tmux pane carries another pane's identity.
 * Either match is refused when the tmux pane is already held by a live pane.
 */
function resolveRebindMatch(
  pane: MuxBasePane,
  lookup: PaneLookup,
  occupiedTmuxIds: Map<string, string>,
): RebindMatch | null {
  const heldByAnotherPane = (tmuxPaneId: string): boolean => {
    const holder = occupiedTmuxIds.get(tmuxPaneId);
    return holder !== undefined && holder !== pane.id;
  };

  const optionMatch = lookup.boundIdToTmuxId.get(pane.id);
  if (optionMatch) {
    return heldByAnotherPane(optionMatch) ? null : { paneId: optionMatch, source: 'option' };
  }

  const titleMatch = lookup.titleToTmuxId.get(pane.slug);
  if (!titleMatch || heldByAnotherPane(titleMatch)) return null;
  if (carriesForeignIdentity(lookup, titleMatch, pane.id)) return null;
  return { paneId: titleMatch, source: 'title' };
}

export class PaneWatcher {
  private window: BrowserWindow | null;
  private configPath: string;
  private controlPaneId: string | null;
  private eventService: PaneEventService;
  private unsubscribe: (() => void) | null = null;
  private stopped = false;
  private syncSuspendCount = 0;
  private onPaneRemoved?: (paneId: string) => void;
  private onPaneIdsRebound?: (panes: MuxBasePane[]) => void;

  constructor(
    window: BrowserWindow | null,
    configPath: string,
    controlPaneId: string | null,
    onPaneRemoved?: (paneId: string) => void,
    onPaneIdsRebound?: (panes: MuxBasePane[]) => void,
  ) {
    this.window = window;
    this.configPath = configPath;
    this.controlPaneId = controlPaneId;
    this.eventService = PaneEventService.getInstance();
    this.onPaneRemoved = onPaneRemoved;
    this.onPaneIdsRebound = onPaneIdsRebound;
  }

  setWindow(win: BrowserWindow): void {
    this.window = win;
  }

  suspendSync(): void {
    this.syncSuspendCount += 1;
    log.info('pane-watcher', 'Sync suspended (pane creation in progress)', { depth: this.syncSuspendCount });
  }

  resumeSync(): void {
    this.syncSuspendCount = Math.max(0, this.syncSuspendCount - 1);
    if (this.syncSuspendCount === 0) {
      log.info('pane-watcher', 'Sync resumed');
      this.syncPanes().catch(() => { });
    }
  }

  async start(): Promise<void> {
    const stateManager = StateManager.getInstance();
    const state = stateManager.getState();

    log.info('pane-watcher', 'Starting pane watcher', { sessionName: state.sessionName, pollInterval: 5000 });

    await this.eventService.initialize({
      sessionName: state.sessionName,
      controlPaneId: this.controlPaneId || undefined,
      pollInterval: 5000,
    });

    await this.eventService.start(false);

    this.unsubscribe = this.eventService.onPanesChanged(async () => {
      log.debug('pane-watcher', 'Pane change event detected — syncing');
      await this.syncPanes();
    });

    log.info('pane-watcher', 'Pane watcher active');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    await this.eventService.cleanup();
  }

  async syncPanes(): Promise<void> {
    if (this.syncSuspendCount > 0) {
      log.debug('pane-watcher', 'Sync skipped — suspended during pane creation');
      return;
    }

    const stateManager = StateManager.getInstance();
    const state = stateManager.getState();
    const sessionName = state.sessionName;

    if (!sessionName) {
      log.debug('pane-watcher', 'Sync skipped — no session name');
      return;
    }

    try {
      const paneInfo = await this.getSessionPaneInfo(sessionName);
      if (this.stopped) return;

      // A tmux read that yields nothing is missing data, never proof that every
      // pane died: the session always owns at least one pane while it exists.
      if (paneInfo.length === 0) {
        log.debug('pane-watcher', 'Sync skipped — tmux reported no panes', { sessionName });
        return;
      }

      const lookup = buildPaneLookup(paneInfo);
      const allPaneIds = lookup.allPaneIds;

      log.debug('pane-watcher', 'Tmux panes in session', {
        sessionName,
        count: allPaneIds.length,
        paneIds: allPaneIds,
      });

      const rebind = this.rebindPaneIds(stateManager.getPanes(), lookup);
      const alive = rebind.panes.filter((pane) => allPaneIds.includes(pane.paneId));
      const dead = rebind.panes.filter((pane) => !allPaneIds.includes(pane.paneId));

      await this.stampMismatchedPanes(alive, lookup);
      if (this.stopped) return;

      if (dead.length > 0) {
        log.info('pane-watcher', 'Dead panes detected', {
          deadIds: dead.map((p) => p.id),
          trackedPaneIds: rebind.panes.map((p) => p.paneId),
          tmuxPaneIds: allPaneIds,
        });
        for (const pane of dead) {
          this.onPaneRemoved?.(pane.id);
        }
      }

      if (!rebind.rebound && dead.length === 0) return;

      log.info('pane-watcher', 'Pane list updated', { aliveCount: alive.length, ids: alive.map((p) => p.id) });
      stateManager.updatePanes(alive);
      if (rebind.rebound) this.onPaneIdsRebound?.(alive);
      this.notifyRenderer(alive);
    } catch (error) {
      log.debug('pane-watcher', 'Sync failed', error);
    }
  }

  /**
   * Rebinding is reported only when a pane's tmux id actually changes, so
   * callers can persist rare tmux-restart rebinds without config churn.
   */
  private rebindPaneIds(
    panes: MuxBasePane[],
    lookup: PaneLookup,
  ): { panes: MuxBasePane[]; rebound: boolean } {
    let rebound = false;
    const occupiedTmuxIds = new Map<string, string>();
    for (const pane of panes) {
      if (lookup.allPaneIds.includes(pane.paneId)) occupiedTmuxIds.set(pane.paneId, pane.id);
    }

    const next = panes.map((pane: MuxBasePane) => {
      if (lookup.allPaneIds.includes(pane.paneId)) return pane;

      const match = resolveRebindMatch(pane, lookup, occupiedTmuxIds);
      if (!match || match.paneId === pane.paneId) return pane;

      occupiedTmuxIds.set(match.paneId, pane.id);
      log.info('pane-watcher', 'Pane rebound', {
        id: pane.id,
        slug: pane.slug,
        oldPaneId: pane.paneId,
        newPaneId: match.paneId,
        source: match.source,
      });
      rebound = true;
      return { ...pane, paneId: match.paneId };
    });

    return { panes: next, rebound };
  }

  /**
   * The option is inherited from wider tmux scopes, so absence is not the signal
   * — a value other than the pane's own id is. A pane-level stamp always beats an
   * inherited value, so this converges in one sync and is a no-op in steady state.
   */
  private async stampMismatchedPanes(panes: MuxBasePane[], lookup: PaneLookup): Promise<void> {
    const mismatched = panes.filter((pane) => lookup.tmuxIdToBoundId.get(pane.paneId) !== pane.id);
    if (mismatched.length === 0) return;

    log.info('pane-watcher', 'Stamping tmux pane identity option', {
      ids: mismatched.map((pane) => pane.id),
    });
    await Promise.all(mismatched.map(async (pane) => {
      await stampTmuxPaneIdOption(pane.paneId, pane.id);
      await stampTmuxPaneIncarnationOption(pane.paneId);
    }));
  }

  private async getSessionPaneInfo(sessionName: string): Promise<TmuxPaneInfo[]> {
    const output = await execFileAsync(
      'tmux',
      ['list-panes', '-s', '-t', sessionName, '-F', PANE_INFO_FORMAT],
      { silent: true },
    );

    return output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [paneId, boundPaneId, ...titleParts] = line.split('|');
        return { boundPaneId: boundPaneId || '', paneId, title: titleParts.join('|') };
      });
  }

  private notifyRenderer(panes: MuxBasePane[]): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(IPC_EVENT.PANE_LIST_CHANGED, panes);
    }
  }
}
