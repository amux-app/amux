import { describe, expect, it, vi, beforeEach } from 'vitest';
import { execFileAsync } from 'muxbase/core';
import { PaneWatcher } from '../../src/main/services/PaneWatcher';

const execFileAsyncMock = vi.hoisted(() => vi.fn());
const stampMock = vi.hoisted(() => vi.fn(async () => {}));
const stateManagerMock = vi.hoisted(() => ({
  getPanes: vi.fn(() => []),
  getState: vi.fn(() => ({ sessionName: "muxbase-o'hara" })),
  updatePanes: vi.fn(),
}));

vi.mock('muxbase/core', () => ({
  MUXBASE_PANE_ID_OPTION: '@muxbase_pane_id',
  PaneEventService: {
    getInstance: () => ({
      cleanup: vi.fn().mockResolvedValue(undefined),
      initialize: vi.fn().mockResolvedValue(undefined),
      onPanesChanged: vi.fn(() => vi.fn()),
      start: vi.fn().mockResolvedValue('polling'),
    }),
  },
  StateManager: {
    getInstance: () => stateManagerMock,
  },
  execFileAsync: execFileAsyncMock,
  stampTmuxPaneIdOption: stampMock,
}));

vi.mock('../../src/main/services/Logger.js', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const CONFIG_PATH = '/tmp/.muxbase/muxbase.config.json';
const TRACKED_PANE = { id: 'pane-1', paneId: '%404', slug: 'task' };

describe('PaneWatcher', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset();
    stampMock.mockClear();
    stateManagerMock.getPanes.mockReturnValue([]);
    stateManagerMock.getState.mockReturnValue({ sessionName: "muxbase-o'hara" });
    stateManagerMock.updatePanes.mockClear();
  });

  it('passes session names as literal tmux arguments without a shell', async () => {
    // Arrange
    execFileAsyncMock.mockResolvedValue('');
    const watcher = new PaneWatcher(null, '/tmp/.muxbase/muxbase.config.json', null);

    // Act
    await watcher.syncPanes();

    // Assert
    expect(execFileAsync).toHaveBeenCalledWith(
      'tmux',
      ['list-panes', '-s', '-t', "muxbase-o'hara", '-F', '#{pane_id}|#{@muxbase_pane_id}|#{pane_title}'],
      { silent: true },
    );
  });

  it('syncs once after resume even when no pane event arrived during suspension', async () => {
    // Arrange
    execFileAsyncMock.mockResolvedValue('%1||other\n');
    stateManagerMock.getPanes.mockReturnValue([TRACKED_PANE]);
    const watcher = new PaneWatcher(null, CONFIG_PATH, null);

    // Act
    watcher.suspendSync();
    watcher.resumeSync();
    await flushMicrotasks();

    // Assert
    expect(stateManagerMock.updatePanes).toHaveBeenCalledWith([]);
  });

  it('leaves pane state untouched when tmux reports no panes', async () => {
    // Arrange
    execFileAsyncMock.mockResolvedValue('');
    stateManagerMock.getPanes.mockReturnValue([TRACKED_PANE]);
    const removed: string[] = [];
    const watcher = new PaneWatcher(null, CONFIG_PATH, null, (paneId) => removed.push(paneId));

    // Act
    await watcher.syncPanes();

    // Assert
    expect(removed).toEqual([]);
    expect(stateManagerMock.updatePanes).not.toHaveBeenCalled();
  });

  it('discards a sync that resolves after the watcher stopped', async () => {
    // Arrange
    let completeRead: (output: string) => void = () => {};
    execFileAsyncMock.mockReturnValue(new Promise<string>((resolve) => { completeRead = resolve; }));
    stateManagerMock.getPanes.mockReturnValue([TRACKED_PANE]);
    const removed: string[] = [];
    const watcher = new PaneWatcher(null, CONFIG_PATH, null, (paneId) => removed.push(paneId));

    // Act
    const pending = watcher.syncPanes();
    await watcher.stop();
    completeRead('%1||other\n');
    await pending;

    // Assert
    expect(removed).toEqual([]);
    expect(stateManagerMock.updatePanes).not.toHaveBeenCalled();
  });
});
