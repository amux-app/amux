/**
 * ConfigBridge owns the only config watcher in the app. These tests pin the
 * contract that StateManager still receives external config edits through it,
 * and that pausing it (close action) defers rather than drops updates.
 */
import { StateManager } from 'muxbase/core';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigBridge,
  jsonSemanticallyEqual,
} from '../../src/main/services/ConfigBridge';
import type { PaneWatcher } from '../../src/main/services/PaneWatcher';
import { IPC_EVENT } from '../../src/shared/ipc-channels';

vi.mock('electron', () => ({
  BrowserWindow: class {},
}));

let root: string;
let configPath: string;
let bridge: ConfigBridge | null = null;

function writeConfigAtomically(paneIds: string[]): void {
  writeRawConfig({
    panes: paneIds.map((id, index) => ({
      id,
      paneId: `%${index + 1}`,
      prompt: '',
      slug: id,
    })),
  });
}

function writeRawConfig(config: object): void {
  const tmpPath = `${configPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(config));
  renameSync(tmpPath, configPath);
}

function emitConfigChange(config: object): void {
  const watcher = Reflect.get(bridge, 'watcher') as {
    emit(event: 'change', value: object): boolean;
  };
  watcher.emit('change', config);
}

async function waitForPaneIds(expected: string[], timeoutMs = 4000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let ids: string[] = [];
  while (Date.now() < deadline) {
    ids = StateManager.getInstance().getPanes().map((pane) => pane.id);
    if (ids.length === expected.length && expected.every((id) => ids.includes(id))) return ids;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return ids;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'muxbase-config-bridge-'));
  configPath = join(root, '.muxbase', 'muxbase.config.json');
  mkdirSync(join(root, '.muxbase'), { recursive: true });
  writeConfigAtomically([]);
  StateManager.getInstance().reset();
});

afterEach(async () => {
  await bridge?.stop();
  bridge = null;
  StateManager.getInstance().reset();
  rmSync(root, { recursive: true, force: true });
});

describe('ConfigBridge', () => {
  it('treats property order and undefined-only object differences as JSON-equivalent', () => {
    expect(jsonSemanticallyEqual(
      [{ id: 'pane-a', metadata: { enabled: true, optional: undefined } }],
      [{ metadata: { enabled: true }, id: 'pane-a' }],
    )).toBe(true);
    expect(jsonSemanticallyEqual(
      [{ id: 'pane-a' }, { id: 'pane-b' }],
      [{ id: 'pane-b' }, { id: 'pane-a' }],
    )).toBe(false);
  });

  it('suppresses pane-list and reconciliation echoes already represented in memory', async () => {
    const syncPanes = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn();
    const paneWatcher = { syncPanes } as unknown as PaneWatcher;
    const window = {
      isDestroyed: () => false,
      webContents: { send },
    };
    const panes = [{
      agent: 'claude' as const,
      agentStatus: 'working' as const,
      id: 'pane-a',
      paneId: '%1',
      prompt: '',
      slug: 'pane-a',
    }];
    StateManager.getInstance().updatePanes(panes);
    bridge = new ConfigBridge(window as never, configPath, paneWatcher);
    await bridge.start();

    emitConfigChange({ lastUpdated: Date.now(), panes });

    expect(send).not.toHaveBeenCalledWith(IPC_EVENT.PANE_LIST_CHANGED, expect.anything());
    expect(syncPanes).not.toHaveBeenCalled();
  });

  it('propagates a config title edit without importing runtime activity fields', async () => {
    const syncPanes = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn();
    const paneWatcher = { syncPanes } as unknown as PaneWatcher;
    const window = {
      isDestroyed: () => false,
      webContents: { send },
    };
    const pane = {
      agent: 'claude' as const,
      agentStatus: 'working' as const,
      id: 'pane-a',
      lastAgentCheck: 1000,
      paneId: '%1',
      prompt: '',
      slug: 'pane-a',
      title: 'Before',
    };
    StateManager.getInstance().updatePanes([pane]);
    bridge = new ConfigBridge(window as never, configPath, paneWatcher);
    await bridge.start();

    // Act — config on disk carries a stale agentStatus/lastAgentCheck (never
    // persisted for real) alongside a genuine title edit.
    emitConfigChange({
      panes: [{ ...pane, agentStatus: 'idle', lastAgentCheck: 2000, title: 'After' }],
    });

    // Assert — config wins for title; runtime activity is not part of the
    // config bridge transport.
    await vi.waitFor(() => {
      expect(StateManager.getInstance().getPaneById('pane-a')).toEqual(
        expect.objectContaining({ title: 'After' }),
      );
    }, { interval: 25, timeout: 4000 });

    expect(send).toHaveBeenCalledWith(
      IPC_EVENT.PANE_LIST_CHANGED,
      [expect.objectContaining({ title: 'After' })],
    );
    expect(syncPanes).toHaveBeenCalledOnce();
  });

  it('does not seed runtime activity from config for a cold pane', async () => {
    const syncPanes = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn();
    const paneWatcher = { syncPanes } as unknown as PaneWatcher;
    const window = {
      isDestroyed: () => false,
      webContents: { send },
    };
    const coldPane = {
      agent: 'claude' as const,
      agentStatus: 'working' as const,
      id: 'pane-cold',
      paneId: '%2',
      prompt: '',
      slug: 'pane-cold',
    };
    bridge = new ConfigBridge(window as never, configPath, paneWatcher);
    await bridge.start();

    // Act — config introduces a pane StateManager has never seen.
    emitConfigChange({ panes: [coldPane] });

    // Assert — runtime activity remains absent until the activity service
    // observes this pane.
    await vi.waitFor(() => {
      expect(StateManager.getInstance().getPaneById('pane-cold')?.agentStatus).toBeUndefined();
    }, { interval: 25, timeout: 4000 });
  });

  it('does not reconcile a top-level-only config change', async () => {
    const syncPanes = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn();
    const paneWatcher = { syncPanes } as unknown as PaneWatcher;
    const window = {
      isDestroyed: () => false,
      webContents: { send },
    };
    const panes = [{ id: 'pane-a', paneId: '%1', prompt: '', slug: 'pane-a' }];
    StateManager.getInstance().updatePanes(panes);
    bridge = new ConfigBridge(window as never, configPath, paneWatcher);
    await bridge.start();

    emitConfigChange({ panes, welcomePaneId: '%welcome' });

    expect(send).not.toHaveBeenCalled();
    expect(syncPanes).not.toHaveBeenCalled();
  });

  it('propagates external config edits into StateManager', async () => {
    // Arrange
    const paneWatcher = { syncPanes: vi.fn().mockResolvedValue(undefined) } as unknown as PaneWatcher;
    bridge = new ConfigBridge(null, configPath, paneWatcher);
    await bridge.start();

    // Act
    writeConfigAtomically(['pane-a', 'pane-b']);

    // Assert
    expect(await waitForPaneIds(['pane-a', 'pane-b'])).toEqual(['pane-a', 'pane-b']);
    expect(paneWatcher.syncPanes).toHaveBeenCalled();
  });

  it('is the only watcher: StateManager alone does not observe config edits', async () => {
    // Arrange
    StateManager.getInstance().updateProjectInfo('proj', 'muxbase-proj', root, configPath);

    // Act
    writeConfigAtomically(['pane-a']);

    // Assert
    expect(await waitForPaneIds(['pane-a'], 800)).toEqual([]);
  });

  it('replays a config change that landed while paused', async () => {
    // Arrange
    const paneWatcher = { syncPanes: vi.fn().mockResolvedValue(undefined) } as unknown as PaneWatcher;
    bridge = new ConfigBridge(null, configPath, paneWatcher);
    await bridge.start();
    const stateManager = StateManager.getInstance();
    stateManager.pauseConfigWatcher();

    // Act
    writeConfigAtomically(['pane-paused']);
    expect(await waitForPaneIds(['pane-paused'], 800)).toEqual([]);
    stateManager.resumeConfigWatcher();

    // Assert
    expect(await waitForPaneIds(['pane-paused'])).toEqual(['pane-paused']);
  });
});
