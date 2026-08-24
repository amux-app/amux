/**
 * PaneWatcher rebinds tmux pane ids in memory after a tmux restart. Unless the
 * rebind reaches the config file, the next config broadcast replays the stale
 * on-disk ids and main-process pane state oscillates between the two. These
 * tests pin the persistence, the "only on a real id rebind" churn guardrail,
 * and the absence of a config-write feedback loop.
 */
import { StateManager, atomicWriteJsonSync, type AumxPane } from 'aumx/core';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigBridge } from '../../src/main/services/ConfigBridge';
import { PaneWatcher } from '../../src/main/services/PaneWatcher';

const execFileAsyncMock = vi.hoisted(() => vi.fn());
const stampMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('electron', () => ({
  BrowserWindow: class {},
}));

vi.mock('aumx/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('aumx/core')>();
  return { ...actual, execFileAsync: execFileAsyncMock, stampTmuxPaneIdOption: stampMock };
});

vi.mock('../../src/main/services/Logger.js', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

interface StoredConfig {
  lastUpdated?: string;
  panes: AumxPane[];
}

const SESSION_NAME = 'aumx-rebind';

let root: string;
let configPath: string;
let bridge: ConfigBridge | null = null;

function makePane(paneId: string, overrides: Partial<AumxPane> = {}): AumxPane {
  return {
    agent: 'claude',
    agentStatus: 'working',
    id: 'pane-a',
    paneId,
    prompt: '',
    slug: 'task',
    ...overrides,
  };
}

function readConfig(): StoredConfig {
  return JSON.parse(readFileSync(configPath, 'utf-8')) as StoredConfig;
}

function writeConfig(panes: AumxPane[]): void {
  atomicWriteJsonSync(configPath, { lastUpdated: new Date().toISOString(), panes });
}

/** Mirrors AumxBridge.persistPanesToConfig, which is what the watcher calls. */
function persistPanesToConfig(panes: AumxPane[]): void {
  const config = readConfig();
  config.panes = panes;
  config.lastUpdated = new Date().toISOString();
  atomicWriteJsonSync(configPath, config);
}

/** Models any other writer touching the config: panes come back off disk. */
function rebroadcastFromDisk(patch: Partial<AumxPane>): void {
  const config = readConfig();
  config.panes = config.panes.map((pane) => ({ ...pane, ...patch }));
  config.lastUpdated = new Date().toISOString();
  atomicWriteJsonSync(configPath, config);
}

function createWatcher(onPaneRemoved?: (paneId: string) => void): {
  persist: ReturnType<typeof vi.fn>;
  watcher: PaneWatcher;
} {
  const persist = vi.fn((panes: AumxPane[]) => persistPanesToConfig(panes));
  return { persist, watcher: new PaneWatcher(null, configPath, null, onPaneRemoved, persist) };
}

/**
 * Registered after ConfigBridge's own listener, so each entry is the in-memory
 * pane id exactly as ConfigBridge left it for that config change.
 */
function observeConfigChanges(): { paneIds: (string | undefined)[] } {
  const observed: { paneIds: (string | undefined)[] } = { paneIds: [] };
  const watcher = Reflect.get(bridge as object, 'watcher') as {
    on(event: 'change', listener: () => void): unknown;
  };
  watcher.on('change', () => {
    observed.paneIds.push(StateManager.getInstance().getPaneById('pane-a')?.paneId);
  });
  return observed;
}

async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aumx-pane-rebind-'));
  configPath = join(root, '.aumx', 'aumx.config.json');
  mkdirSync(join(root, '.aumx'), { recursive: true });
  writeConfig([]);
  execFileAsyncMock.mockReset();
  stampMock.mockClear();
  StateManager.getInstance().reset();
  StateManager.getInstance().updateProjectInfo('rebind', SESSION_NAME, root, configPath);
});

afterEach(async () => {
  await bridge?.stop();
  bridge = null;
  StateManager.getInstance().reset();
  rmSync(root, { recursive: true, force: true });
});

describe('PaneWatcher tmux pane id rebinding', () => {
  it('keeps a rebound pane id when the config is rebroadcast', async () => {
    // Arrange
    const pane = makePane('%1');
    writeConfig([pane]);
    StateManager.getInstance().updatePanes([pane]);
    const { watcher } = createWatcher();
    bridge = new ConfigBridge(null, configPath, watcher);
    await bridge.start();
    await settle(250);
    const observed = observeConfigChanges();
    execFileAsyncMock.mockResolvedValue('%9||task\n');

    // Act
    await watcher.syncPanes();
    rebroadcastFromDisk({ title: 'external' });

    // Assert
    await vi.waitFor(() => {
      expect(StateManager.getInstance().getPaneById('pane-a')?.title).toBe('external');
    }, { interval: 25, timeout: 4000 });
    expect(observed.paneIds.every((paneId) => paneId === '%9')).toBe(true);
    expect(readConfig().panes[0].paneId).toBe('%9');
  });

  it('does not persist when no tmux pane id changed', async () => {
    // Arrange
    StateManager.getInstance().updatePanes([makePane('%1', { title: 'Old' })]);
    const { persist, watcher } = createWatcher();
    execFileAsyncMock.mockResolvedValue('%1||task-renamed\n');

    // Act
    await watcher.syncPanes();

    // Assert
    expect(persist).not.toHaveBeenCalled();
    expect(StateManager.getInstance().getPaneById('pane-a')?.paneId).toBe('%1');
  });

  it('does not persist when a pane dies without an id rebind', async () => {
    // Arrange
    StateManager.getInstance().updatePanes([
      makePane('%1'),
      makePane('%2', { id: 'pane-b', slug: 'other' }),
    ]);
    const removed: string[] = [];
    const { persist, watcher } = createWatcher((paneId) => removed.push(paneId));
    execFileAsyncMock.mockResolvedValue('%1||task\n');

    // Act
    await watcher.syncPanes();

    // Assert
    expect(removed).toEqual(['pane-b']);
    expect(persist).not.toHaveBeenCalled();
    expect(StateManager.getInstance().getPanes().map((p) => p.id)).toEqual(['pane-a']);
  });

  it('does not re-enter sync or persist again after persisting a rebind', async () => {
    // Arrange
    const pane = makePane('%1');
    writeConfig([pane]);
    StateManager.getInstance().updatePanes([pane]);
    const { persist, watcher } = createWatcher();
    const syncSpy = vi.spyOn(watcher, 'syncPanes');
    bridge = new ConfigBridge(null, configPath, watcher);
    await bridge.start();
    await settle(250);
    const observed = observeConfigChanges();
    execFileAsyncMock.mockResolvedValue('%9||task\n');

    // Act
    await watcher.syncPanes();
    await vi.waitFor(() => {
      expect(observed.paneIds.length).toBeGreaterThan(0);
    }, { interval: 25, timeout: 4000 });
    await settle(250);

    // Assert
    expect(persist).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(StateManager.getInstance().getPaneById('pane-a')?.paneId).toBe('%9');
  });
});

describe('PaneWatcher tmux pane identity option', () => {
  it('rebinds by pane option when another tmux pane forges the slug as its title', async () => {
    // Arrange
    StateManager.getInstance().updatePanes([makePane('%1')]);
    const { persist, watcher } = createWatcher();
    execFileAsyncMock.mockResolvedValue('%7|pane-a|renamed-by-user\n%8||task\n');

    // Act
    await watcher.syncPanes();

    // Assert
    expect(StateManager.getInstance().getPaneById('pane-a')?.paneId).toBe('%7');
    expect(persist).toHaveBeenCalledTimes(1);
    expect(stampMock).not.toHaveBeenCalled();
  });

  it('refuses the title fallback when the forging tmux pane already carries another identity', async () => {
    // Arrange
    StateManager.getInstance().updatePanes([makePane('%1')]);
    const removed: string[] = [];
    const { watcher } = createWatcher((paneId) => removed.push(paneId));
    execFileAsyncMock.mockResolvedValue('%8|pane-b|task\n');

    // Act
    await watcher.syncPanes();

    // Assert
    expect(removed).toEqual(['pane-a']);
  });

  it('rebinds a legacy pane by title and stamps the option so it self-upgrades', async () => {
    // Arrange
    StateManager.getInstance().updatePanes([makePane('%1')]);
    const { watcher } = createWatcher();
    execFileAsyncMock.mockResolvedValue('%9||task\n');

    // Act
    await watcher.syncPanes();

    // Assert
    expect(StateManager.getInstance().getPaneById('pane-a')?.paneId).toBe('%9');
    expect(stampMock).toHaveBeenCalledWith('%9', 'pane-a');
  });

  it('stamps a live legacy pane that never changed tmux id', async () => {
    // Arrange
    StateManager.getInstance().updatePanes([makePane('%1')]);
    const { persist, watcher } = createWatcher();
    execFileAsyncMock.mockResolvedValue('%1||task\n');

    // Act
    await watcher.syncPanes();

    // Assert
    expect(stampMock).toHaveBeenCalledWith('%1', 'pane-a');
    expect(persist).not.toHaveBeenCalled();
  });

  it('keeps stamping when every tmux pane inherits the option from a wider scope', async () => {
    // Arrange
    StateManager.getInstance().updatePanes([
      makePane('%1'),
      makePane('%2', { id: 'pane-b', slug: 'other' }),
    ]);
    const removed: string[] = [];
    const { watcher } = createWatcher((paneId) => removed.push(paneId));
    execFileAsyncMock.mockResolvedValue('%1|GLOBAL_X|task\n%2|GLOBAL_X|other\n');

    // Act
    await watcher.syncPanes();

    // Assert
    expect(removed).toEqual([]);
    expect(stampMock.mock.calls).toEqual([['%1', 'pane-a'], ['%2', 'pane-b']]);
  });

  it('rebinds through the title fallback when an inherited option makes every tmux pane look stamped', async () => {
    // Arrange
    StateManager.getInstance().updatePanes([
      makePane('%1'),
      makePane('%2', { id: 'pane-b', slug: 'other' }),
    ]);
    const removed: string[] = [];
    const { watcher } = createWatcher((paneId) => removed.push(paneId));
    execFileAsyncMock.mockResolvedValue('%9|GLOBAL_X|task\n%8|GLOBAL_X|other\n');

    // Act
    await watcher.syncPanes();

    // Assert
    expect(removed).toEqual([]);
    expect(StateManager.getInstance().getPaneById('pane-a')?.paneId).toBe('%9');
    expect(StateManager.getInstance().getPaneById('pane-b')?.paneId).toBe('%8');
  });

  it('refuses an identity claimed by more than one tmux pane', async () => {
    // Arrange
    StateManager.getInstance().updatePanes([makePane('%1')]);
    const removed: string[] = [];
    const { watcher } = createWatcher((paneId) => removed.push(paneId));
    execFileAsyncMock.mockResolvedValue('%7|pane-a|forged\n%8|pane-a|also-forged\n');

    // Act
    await watcher.syncPanes();

    // Assert
    expect(removed).toEqual(['pane-a']);
    expect(stampMock).not.toHaveBeenCalled();
  });

  it('refuses an option match whose tmux pane is already held by another live pane', async () => {
    // Arrange
    StateManager.getInstance().updatePanes([
      makePane('%7', { id: 'pane-b', slug: 'other' }),
      makePane('%1'),
    ]);
    const removed: string[] = [];
    const { watcher } = createWatcher((paneId) => removed.push(paneId));
    execFileAsyncMock.mockResolvedValue('%7|pane-a|other\n');

    // Act
    await watcher.syncPanes();

    // Assert
    expect(removed).toEqual(['pane-a']);
    expect(StateManager.getInstance().getPaneById('pane-b')?.paneId).toBe('%7');
    expect(stampMock).toHaveBeenCalledWith('%7', 'pane-b');
  });

  it('parses a tmux pane title that contains the field delimiter', async () => {
    // Arrange
    StateManager.getInstance().updatePanes([makePane('%1', { slug: 'task|with|pipes' })]);
    const { watcher } = createWatcher();
    execFileAsyncMock.mockResolvedValue('%4||task|with|pipes\n');

    // Act
    await watcher.syncPanes();

    // Assert
    expect(StateManager.getInstance().getPaneById('pane-a')?.paneId).toBe('%4');
  });
});
