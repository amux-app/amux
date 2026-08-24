import { BrowserWindow } from 'electron';
import { ConfigWatcher, StateManager, type AumxConfig, type AumxPane } from 'aumx/core';
import { IPC_EVENT } from '../../shared/ipc-channels.js';
import type { PaneWatcher } from './PaneWatcher.js';
import { log } from './Logger.js';

function definedKeyCount(value: Record<string, unknown>): number {
  let count = 0;
  for (const key of Object.keys(value)) {
    if (value[key] !== undefined) count++;
  }
  return count;
}

function stripPersistedRuntimeActivity(pane: AumxPane): AumxPane {
  const {
    agentStatus: _agentStatus,
    lastAgentCheck: _lastAgentCheck,
    lastDeterministicStatus: _lastDeterministicStatus,
    optionsQuestion: _optionsQuestion,
    ...persistedPane
  } = pane;
  return persistedPane;
}

export function jsonSemanticallyEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index++) {
      if (!jsonSemanticallyEqual(left[index], right[index])) return false;
    }
    return true;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  if (definedKeyCount(leftRecord) !== definedKeyCount(rightRecord)) return false;

  for (const key of Object.keys(leftRecord)) {
    const leftValue = leftRecord[key];
    if (leftValue === undefined) continue;
    if (!Object.hasOwn(rightRecord, key) || rightRecord[key] === undefined) return false;
    if (!jsonSemanticallyEqual(leftValue, rightRecord[key])) return false;
  }
  return true;
}

export class ConfigBridge {
  private window: BrowserWindow | null;
  private watcher: ConfigWatcher;
  private paneWatcher: PaneWatcher;

  constructor(window: BrowserWindow | null, configPath: string, paneWatcher: PaneWatcher) {
    this.window = window;
    this.paneWatcher = paneWatcher;
    this.watcher = new ConfigWatcher(configPath);
  }

  setWindow(win: BrowserWindow): void {
    this.window = win;
  }

  async start(): Promise<void> {
    log.info('config-bridge', 'Starting config watcher');
    StateManager.getInstance().setConfigWatcher(this.watcher);

    this.watcher.on('change', (config: AumxConfig) => {
      const stateManager = StateManager.getInstance();
      const currentPanes = stateManager.getPanes();
      const reconciledPanes = config.panes.map(stripPersistedRuntimeActivity);
      if (jsonSemanticallyEqual(reconciledPanes, currentPanes.map(stripPersistedRuntimeActivity))) return;
      log.info('config-bridge', 'Config file changed', {
        paneCount: reconciledPanes.length,
        paneIds: reconciledPanes.map((p) => p.id),
      });
      stateManager.updatePanes(reconciledPanes);

      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.send(IPC_EVENT.PANE_LIST_CHANGED, reconciledPanes);
      }

      // syncPanes will check its own suspension flag internally
      this.paneWatcher.syncPanes().catch(() => {});
    });

    await this.watcher.start();
    log.info('config-bridge', 'Config watcher active');
  }

  async stop(): Promise<void> {
    log.info('config-bridge', 'Stopping config watcher');
    StateManager.getInstance().setConfigWatcher(null);
    await this.watcher.stop();
  }
}
